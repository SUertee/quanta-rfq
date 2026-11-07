import {useQuoteSignature} from '../engine/useQuoteSignature';
import {QuoteSignature,SignaturePreview} from '../components/QuoteSignature';
import {citeReference,dragReference,type ChatReference} from '../engine/chatReferences';
import {appFetch as fetch} from '../engine/appUrl';
import {useStageNavigation} from '../engine/useStageNavigation';
import {inquiryStages} from '../engine/workflow';
import type {IntakeBatch} from '../engine/intake';
import {Modal} from '../components/Modal';
import {IntakeRecord} from '../components/IntakeRecord';
import { Fragment, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import type { Dataset } from '../data';
import type { EmailSample, EstCost, InquiryLine, PricedLine } from '../types';
import { parseEmailBody } from '../engine/parse';
import { normalizeUom, splitPn } from '../engine/structure';
import { isYellow, FLAG_META } from '../engine/pricing';
import { defaultConfirmPrice, freightChargeFor, repriceBook, marginOf, suggestPrice, type PricingPolicy } from '../engine/pricingPolicy';
import { llmConfigured, llmEstimatePrice, llmExtractLines, llmNormalizeLine, llmPing, llmSummarizeRequirements } from '../engine/llm';
import { fmtMoney, toChineseUpper } from '../engine/amount';
import { FLAG_PLAIN } from '../plain';
import { Badge, FilterTabs } from '../components/ui';
import { validInquiryLine, validUnitPrice } from '../engine/quoteValidation';
import { getCompany } from '../engine/company';
import {
  exportCustomerHtml, exportInternalCsv, exportSupplierRfqCsv, quoteGate, quoteQtyOf,
  type ExportCtx,
} from '../engine/export';
import type { Source } from '../App';

const yellowReasons = (p: PricedLine) => p.flags.filter((f) => FLAG_META[f].yellow);

const fmtDuration = (sec: number) => {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${(sec / 3600).toFixed(1)} 小时`;
};

/** 原文高亮：把行对应的原文片段标黄并滚动到可视位置 */
function RawHighlight({ body, needle }: { body: string; needle: string }) {
  if (!needle) return <>{body}</>;
  const i = body.indexOf(needle);
  if (i < 0) return <>{body}</>;
  return (
    <>
      {body.slice(0, i)}
      <mark className="raw-mark">{needle}</mark>
      {body.slice(i + needle.length)}
    </>
  );
}

/** 报价工作台：一个页面完成 核对 → 定价 → 预览 → 导出 */
export function WorkbenchPage({
  persistenceError, persistenceConflict, onRetryQuote, quoteVersion, persistencePending=false, onDataRefresh, onAskAgent, selectedAgentLine, ds, source, lines, priced, email, label, assigneeId, onAssigneeChange, currentUserId, inquiryError, onConvertManual,
  policy, priceBook, setPriceBook, resolved, setResolved, estCost, setEstCost, manualPrices, setManualPrices, skipped, setSkipped, taskKey, timing, ops, onTime, onOp, onEditLine, onAddLine, onBack, onApplyLlmRows,
}: {
  persistenceError?:string;
  persistenceConflict?:boolean;
  onRetryQuote?:()=>void;
  quoteVersion?:number;
  persistencePending?:boolean;
  onDataRefresh?:()=>void;
  onAskAgent?: (key: string | null) => void; selectedAgentLine?: string | null;
  assigneeId: string; onAssigneeChange: (id: string) => void; currentUserId: string; inquiryError: boolean; onConvertManual: () => void;
  ds: Dataset;
  source: Source;
  lines: InquiryLine[];
  priced: PricedLine[];
  email?: EmailSample;
  label: string;
  policy: PricingPolicy;
  priceBook: Record<string, number>;
  setPriceBook: (pb: SetStateAction<Record<string, number>>) => void;
  manualPrices: Set<string>;
  setManualPrices: (s: Set<string>) => void;
  skipped: Set<string>;
  setSkipped: (s: Set<string>) => void;
  taskKey: string;
  timing: number;
  ops: Record<string, number>;
  onTime: (key: string, sec: number) => void;
  onOp: (op: string) => void;
  resolved: Set<string>;
  setResolved: (s: Set<string>) => void;
  estCost: Record<string, EstCost>;
  setEstCost: (ec: SetStateAction<Record<string, EstCost>>) => void;
  onAddLine: (pn: string, quantity: number, uom: string, description: string) => void;
  onEditLine: (key: string, patch: Partial<InquiryLine>) => void;
  onBack: () => void;
  onApplyLlmRows: (rows: ReturnType<typeof parseEmailBody>['rows']) => void;
}) {
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [dismissedStageTip,setDismissedStageTip]=useState<number|null>(null);
  const {stage, flowRef, goToStage} = useStageNavigation(taskKey);
  const [intakeRecord,setIntakeRecord]=useState<IntakeBatch|null>(null);
  const [exported,setExported]=useState(false);
  const exportedBasis=useRef<string|null>(null);
  const [rowFilter, setRowFilter] = useState<'all'|'review'|'unpriced'>('all');
  const [lineSearch, setLineSearch] = useState('');
  // 任务计时：打开 → 离开累计（持久化到 task-time）
  useEffect(() => {
    const start = Date.now();
    return () => { onTime(taskKey, Math.round((Date.now() - start) / 1000)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey]);
  const [editError, setEditError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newLine, setNewLine] = useState({ pn: '', quantity: '1', uom: 'EA', description: '', requirement: '', needByDate: '', quoteDeadline: '', dueDate: '' });
  const [open, setOpen] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmNote, setLlmNote] = useState('');
  const [exportBusy,setExportBusy]=useState(false);
  const [exportError,setExportError]=useState('');
  const [exportReceipt,setExportReceipt]=useState<number|null>(null);
  const [summary, setSummary] = useState('');
  const [tab, setTab] = useState<'quote' | 'cn'>('quote');
  const [reviewRows, setReviewRows] = useState<{ pn: string; action: string; detail: string; operator: string; created_at: string }[] | null>(null);
  const [snapshots, setSnapshots] = useState<{ id: number; kind: string; total: number; operator: string; created_at: string }[] | null>(null);

  const [recordTab, setRecordTab] = useState<'actions'|'quotes'|null>(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordError, setRecordError] = useState('');
  const loadRecords = async (kind: 'actions'|'quotes') => {
    setRecordTab(kind); setRecordBusy(true); setRecordError('');
    try {
      const response = await fetch(kind==='actions' ? `/api/review?task=${encodeURIComponent(orderId)}` : `/api/snapshots?order_id=${encodeURIComponent(orderId)}`);
      if (!response.ok) throw new Error('记录读取失败，请重试');
      const data = await response.json();
      if (kind==='actions') setReviewRows(data.rows ?? []); else setSnapshots(data.rows ?? []);
    } catch (error) { setRecordError(error instanceof Error ? error.message : '记录读取失败'); }
    finally { setRecordBusy(false); }
  };

  const parseRows = useMemo(() => {
    if (!email) return [];
    if (email.parsedRows) return email.parsedRows;
    if (source.kind === 'email' && source.llmRows) return source.llmRows;
    return parseEmailBody(email).rows;
  }, [email, source]);

  const referenceForLine = (line: InquiryLine): ChatReference => {
    const stored = parseRows.find(row=>row.lineNo===line.lineNo);
    const excerpt=[line.partNumber,line.description,`${line.quantity} ${line.uom}`,line.condition,line.requirement,line.needByDate,line.quoteDeadline,line.dueDate].filter(Boolean).join(' · ');
    return {
      id:`line:${line.key}:${stored?.version||1}`,
      label:`物料 · ${line.partNumber||'件号待补'}`,
      excerpt,
      ...(email?.intakeBatchId&&stored?.persistedLineId?{inquiryId:email.intakeBatchId,lineId:stored.persistedLineId,contentId:stored.contentId,version:stored.version}:{}),
    };
  };

  // 原文定位：当前展开行 → 原文片段（优先整行原文，退件号）
  const rawBoxRef = useRef<HTMLPreElement>(null);
  const openLine = priced.find((p) => p.line.key === open)?.line;
  const hlNeedle = (() => {
    if (!openLine || !showRaw || !email?.body) return '';
    const raw = parseRows.find((r) => r.lineNo === openLine.lineNo)?.raw;
    if (raw && email.body.includes(raw)) return raw;
    return openLine.partNumber && email.body.includes(openLine.partNumber) ? openLine.partNumber : '';
  })();
  useEffect(() => {
    if (showRaw && hlNeedle) rawBoxRef.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
  }, [showRaw, hlNeedle]);

  const unreadRows = priced.filter((p) => p.flags.includes('PARSE_ISSUE')).length;
  const noMatchLeft = priced.filter((p) => p.flags.includes('NO_MATCH') && estCost[p.line.key] == null).length;

  const suggOf = (p: PricedLine) => suggestPrice(p, policy, estCost[p.line.key]?.value);

  const setCost = (key: string, v: string) => {
    const next = { ...estCost };
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || n <= 0) delete next[key];
    else next[key] = { value: n, source: 'manual' };
    setEstCost(next);
  };

  const [estBusy, setEstBusy] = useState('');

  // AI 在线状态：在线才显示 AI 按钮；离线/未配置时所有功能走手工入口
  const [aiOk, setAiOk] = useState<boolean | null>(llmConfigured() ? null : false);
  useEffect(() => {
    let live = true;
    if (llmConfigured()) llmPing().then((ok) => { if (live) setAiOk(ok); });
    return () => { live = false; };
  }, []);

  // 行级手工修改（AI 不可用时的兜底入口，也对所有行开放）
  const [editKey, setEditKey] = useState<string | null>(null);
  const [draft, setDraft] = useState({ partNumber: '', quantity: '', uom: '', condition: '', description: '', requirement: '', needByDate: '', quoteDeadline: '', dueDate: '' });
  const startEdit = (p: PricedLine) => {
    setEditError(''); setEditKey(p.line.key);
    setDraft({
      partNumber: p.line.partNumber, quantity: String(p.line.quantity || ''),
      uom: p.line.uom, condition: p.line.condition, description: p.line.description,
      requirement:p.line.requirement, needByDate:p.line.needByDate||'', quoteDeadline:p.line.quoteDeadline||'', dueDate:p.line.dueDate||'',
    });
  };
  const saveEdit = (key: string) => {
    const pn = draft.partNumber.trim();
    if (!pn || !Number.isFinite(Number(draft.quantity)) || Number(draft.quantity) <= 0 || !draft.uom.trim()) { setEditError('请填写件号、单位，以及大于零的有效数量。'); return; }
    setEditError('');
    const { base, suffix } = splitPn(pn);
    const u = normalizeUom(draft.uom);
    const original=lines.find(line=>line.key===key);
    const patch:Partial<InquiryLine>={
      partNumber: pn, basePn: base, pnSuffix: suffix,
      quantity: Number(draft.quantity) || 0,
      uom: draft.uom, uomNormalized: u.norm, uomFactor: u.factor,
      condition: draft.condition, description: draft.description.trim(),
      requirement:draft.requirement.trim(), needByDate:draft.needByDate.trim(), quoteDeadline:draft.quoteDeadline.trim(), dueDate:draft.dueDate.trim(),
      issues: [], manualFixedMark: true,
    };
    onEditLine(key,Object.fromEntries(Object.entries(patch).filter(([field,value])=>String(value ?? '')!==String(original?.[field as keyof InquiryLine] ?? ''))));
    setEditKey(null);
    onOp('edit');
  };

  /** 非标品 AI 市场估价（单行） */
  const runAiEst = async (p: PricedLine) => {
    setEstBusy(p.line.key);
    try {
      const est = await llmEstimatePrice(p.line, policy.industryKw);
      if (!live.current) return;
      if (est) { setEstCost(latest => ({ ...latest, [p.line.key]: latest[p.line.key] ?? est })); setLlmNote('估价完成，请核对依据后定价。已有人工成本保留。'); onOp('est'); } else setLlmNote('本次未取得有效估价，请重试或手工填写成本。');
    } catch (e) { if (live.current) setLlmNote(`估价失败：${e instanceof Error ? e.message : String(e)}，可重试或手工填写成本。`); }
    setEstBusy('');
  };

  /** 非标品 AI 市场估价（批量，逐个出建议价与合理最低价） */
  const runBatchEst = async () => {
    const targets = priced.filter((p) => p.flags.includes('NO_MATCH') && estCost[p.line.key] == null);
    setEstBusy('batch');
    const next = { ...estCost };
    let i = 0;
    let ok = 0;
    for (const p of targets) {
      if (!live.current) return;
      i++;
      setLlmNote(`AI 估价中 ${i}/${targets.length}…`);
      try {
        const est = await llmEstimatePrice(p.line, policy.industryKw);
        if (est) { next[p.line.key] = est; ok++; }
      } catch { break; }
    }
    if (!live.current) return;
    setEstCost(latest => ({ ...next, ...latest }));
    if (ok) onOp('est');
    setLlmNote(`AI 估价完成 ${ok}/${targets.length}：已出建议售价与合理最低报价，请逐个核对后定价`);
    setEstBusy('');
  };
  const confirmOf = (p: PricedLine) => priceBook[p.line.key];
  /** 定价日志：值真正变化且在 blur/Enter 提交时才记一条（修"打一个数字记一次"） */
  const lastLogged = useRef<Record<string, number>>({});
  const setOne = (key: string, v: string) => {
    const next = { ...priceBook };
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || n <= 0) delete next[key];
    else next[key] = Math.round(n * 100) / 100;
    setPriceBook(next);
    // 手工定价标记：重新核价时保留
    const m = new Set(manualPrices);
    if (next[key] != null) m.add(key); else m.delete(key);
    setManualPrices(m);
  };
  const logPriceCommit = (key: string) => {
    const value = priceBook[key];
    const row = priced.find((p) => p.line.key === key);
    if (value != null && lastLogged.current[key] !== value) {
      lastLogged.current[key] = value;
      logAction(row?.line.partNumber ?? key, '确认定价', `行 ${row?.line.lineNo ?? '?'} · 单价 ${value}`);
      onOp('price');
    }
  };
  const fillAll = () => {
    const next = { ...priceBook };
    for (const p of priced) {
      const v = defaultConfirmPrice(suggOf(p));
      if (v != null && next[p.line.key] == null) next[p.line.key] = v;
    }
    setPriceBook(next);
  };

  /** 重新核价：按当前参数（加价率/溢价/汇率等）重算建议价；手工改过的行保留 */
  const reprice = () => {
    const {next,kept} = repriceBook(priced,priceBook,manualPrices,skipped,policy,estCost);
    setPriceBook(next);
    logAction('全部', '重新核价', `加价率 ${(policy.margin * 100).toFixed(0)}% · 保留手工定价 ${kept} 行`);
    onOp('reprice');
    setLlmNote(`已按当前参数重新核价：手工改过的 ${kept} 行保留，其余行刷新为建议价`);
  };

  /** 接单ID：优先询价单号，处理记录以此为主键 */
  const orderId = lines[0]?.rfqId || label;
  /** B6：处理记录落库（后端不可用则静默跳过） */
  const logAction = (pn: string, action: string, detail: string) => {
    fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: orderId, pn, action, detail, operator: getCompany().operator }),
    }).catch(() => { /* 后端未启动，忽略 */ });
  };

  const toggleResolved = (key: string) => {
    const n = new Set(resolved);
    const row = priced.find((p) => p.line.key === key);
    if (n.has(key)) n.delete(key); else n.add(key);
    setResolved(n);
    logAction(row?.line.partNumber ?? key, n.has(key) ? '标记已核对' : '撤销核对',
      row ? yellowReasons(row).map((f) => FLAG_PLAIN[f]).join('；') : '');
    onOp('resolve');
  };

  /** 暂不报价：本行进客户版附录"待报价清单"，不进合计；原因保留可回查 */
  const toggleSkip = (key: string) => {
    const n = new Set(skipped);
    const row = priced.find((p) => p.line.key === key);
    if (n.has(key)) n.delete(key); else n.add(key);
    setSkipped(n);
    logAction(row?.line.partNumber ?? key, n.has(key) ? '暂不报价' : '恢复报价',
      row ? yellowReasons(row).map((f) => FLAG_PLAIN[f]).join('；') : '');
    onOp('skip');
  };

  const needCheck = priced.filter((p) => isYellow(p) && !resolved.has(p.line.key) && !skipped.has(p.line.key));
  const unpriced = priced.filter((p) => !validUnitPrice(confirmOf(p)) && !skipped.has(p.line.key));
  const gate = quoteGate(priced, priceBook, resolved, skipped);
  // A8：MOQ 不足行按 MOQ 实报数量计价
  const activePriced = priced.filter(p => !skipped.has(p.line.key));
  const confirmedSum = activePriced.reduce((s, p) => {
    const c = confirmOf(p);
    return c != null ? s + c * quoteQtyOf(p).qty : s;
  }, 0);
  // 货运成本：运费向客户单列收取（免运费门槛/最低运费）；我方货运成本只进内部毛利测算
  const freightCharge = freightChargeFor(confirmedSum, policy);
  const freightCost = policy.freightCostCny || 0;
  const orderTotal = Math.round((confirmedSum + freightCharge) * 100) / 100;
  const marginKnown = activePriced.filter((p) => confirmOf(p) != null && suggOf(p).costBase != null);
  const lineMarginSum = marginKnown.reduce(
    (s, p) => s + (confirmOf(p)! - suggOf(p).costBase!) * quoteQtyOf(p).qty, 0,
  );
  // B11 运费分摊：按行均摊 / 按金额比例（影响内部毛利测算口径）
  const allocFreight = (p: PricedLine): number => {
    if (policy.freightAlloc === 'byLine' && priced.length) return freightCost / priced.length;
    if (policy.freightAlloc === 'byValue' && confirmedSum > 0) {
      const c = confirmOf(p);
      return c != null ? (c * quoteQtyOf(p).qty / confirmedSum) * freightCost : 0;
    }
    return 0;
  };
  const estMargin = lineMarginSum + freightCharge - freightCost;
  const invalidLines = activePriced.filter(p => !validInquiryLine(p.line));
  const exportable = !inquiryError && !invalidLines.length && gate.ok;
  const overCap = orderTotal > policy.orderCapCny;

  const exportCtx: ExportCtx = {
    taskLabel: label, priceBook, policy, company: getCompany(), resolved, skipped,
    manualCost: estCost,
  };
  const unsignedReceiptContent=JSON.stringify({schemaVersion:2,draftVersion:quoteVersion,policy,company:getCompany(),manualCost:estCost,lines:priced.map(p=>({
    key:p.line.key,pn:p.line.partNumber,desc:p.line.description,requestedQty:p.line.quantity,qty:quoteQtyOf(p).qty,
    uom:p.line.uom,condition:p.line.condition,requirement:p.line.requirement,needByDate:p.line.needByDate||'',dueDate:p.line.dueDate,quoteDeadline:p.line.quoteDeadline||'',ruleVersion:p.ruleVersion,basisId:p.basisId,basisResource:p.basisResource,price:priceBook[p.line.key]??null,skipped:skipped.has(p.line.key),reviewed:resolved.has(p.line.key),flags:p.flags,
  }))});
  const quoteSignature=useQuoteSignature(taskKey,unsignedReceiptContent);
  const [signatureOpen,setSignatureOpen]=useState(false);
  const currentReceiptContent=quoteSignature.signature?JSON.stringify({...JSON.parse(unsignedReceiptContent),signature:quoteSignature.signature}):unsignedReceiptContent;
  exportCtx.signature=quoteSignature.signature;
  const liveReceiptContent=useRef(currentReceiptContent);
  liveReceiptContent.current=currentReceiptContent;
  useEffect(()=>{
    let active=true;
    if(exportedBasis.current!==currentReceiptContent){setExported(false);setExportReceipt(null);}
    const restore=async()=>{
      try{
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(currentReceiptContent)))).map(b=>b.toString(16).padStart(2,'0')).join('');
        const response=await fetch(`/api/snapshots?order_id=${encodeURIComponent(orderId)}`);
        if(!response.ok)return;
        const data=await response.json();const match=data.rows?.find((r:{id:number;content_sha256?:string})=>r.content_sha256===hash);
        if(active&&match){exportedBasis.current=currentReceiptContent;setExportReceipt(match.id);setExported(true);}
      }catch{/* A missing receipt never marks a quote exported. */}
    };void restore();return()=>{active=false;};
  },[currentReceiptContent,orderId]);
  /** Persist the human-reviewed receipt before generating a download. */
  const postSnapshot = async (kind: string) => {
    const content=currentReceiptContent;
    const response=await fetch('/api/snapshots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId,kind,total:orderTotal,content,operator:getCompany().operator,inquiryId:email?.intakeBatchId,draftVersion:quoteVersion})});
    const receipt=await response.json();
    if(!response.ok||!receipt.ok||!receipt.id)throw new Error(receipt.error||'无法保存审核快照，尚未生成导出文件');
    return receipt.id as number;
  };
  const exportReviewed = async (kind:'内部版'|'客户版') => {
    if(!stageExportable||exportBusy)return;
    setExportBusy(true);setExportError('');
    try{
      const id=await postSnapshot(kind);
      if(!live.current||liveReceiptContent.current!==currentReceiptContent)throw new Error('报价已变化，请重新核对后导出');
      if(kind==='内部版')exportInternalCsv(priced,exportCtx);else exportCustomerHtml(priced,exportCtx);
      logAction('全部',`导出${kind}`,`合计 ${orderTotal}；审核快照 ${id}`);onOp('export');exportedBasis.current=currentReceiptContent;setExportReceipt(id);setExported(true);
    }catch(error){setExportError(error instanceof Error?error.message:'导出失败，请重试');}
    finally{setExportBusy(false);}
  };
  const doExportInternal = () => void exportReviewed('内部版');
  const doExportCustomer = () => void exportReviewed('客户版');
  const doSupplierRfq = () => {
    const n = priced.filter((p) => p.flags.includes('NO_MATCH')).length;
    logAction('全部', '生成供应商询价单', `${n} 行`);
    onOp('export');
    exportSupplierRfqCsv(priced, exportCtx);
  };

  const runLlmFix = async () => {
    setLlmBusy(true);
    const targets = parseRows.filter((r) => r.issues.length);
    const next = [...parseRows];
    let ok = 0, fail = 0;
    for (const t of targets) {
      try {
        const fixed = await llmNormalizeLine(t.raw);
        if (fixed) {
          const i = next.findIndex((r) => r.lineNo === t.lineNo);
          next[i] = { ...next[i], ...fixed, issues: [], llmFixed: true };
          ok++;
        } else fail++;
      } catch { fail++; break; }
    }
    if (!live.current) return;
    onApplyLlmRows(next);
    setLlmNote(`AI 重读了 ${targets.length} 行：修好 ${ok} 行${fail ? `，还有 ${fail} 行请您人工核对` : ''}`);
    setLlmBusy(false);
  };

  /** 纯语料进订单：整段文字 → 订单行（正则解析不出行时的兜底） */
  const runLlmExtract = async () => {
    if (!email?.body) return;
    setLlmBusy(true);
    try {
      const rows = await llmExtractLines(email.body, policy.industryKw);
      if (!live.current) return;
      if (rows?.length) {
        onApplyLlmRows(rows);
        setLlmNote(`AI 从文字提取 ${rows.length} 行（带异常标记的请核对）`);
      } else {
        setLlmNote('AI 没有从这段文字里识别出订单行，请检查原文或手工录入');
      }
    } catch (e) {
      setLlmNote(`提取失败：${e instanceof Error ? e.message : String(e)}`);
    }
    setLlmBusy(false);
  };

  const runSummary = async () => {
    setLlmBusy(true);
    try {
      setSummary(await llmSummarizeRequirements(
        lines.map((l) => ({ partNumber: l.partNumber, requirement: l.requirement, condition: l.condition, dueDate: l.dueDate, quantity: l.quantity, uom: l.uom })),
        policy.industryKw,
      ));
    } catch (e) { setSummary(`调用失败：${e instanceof Error ? e.message : String(e)}`); }
    setLlmBusy(false);
  };

  const visibleRows = priced.filter(p=>(rowFilter==='all'||(rowFilter==='review'?isYellow(p)&&!resolved.has(p.line.key):!validUnitPrice(confirmOf(p))))&&`${p.line.partNumber} ${p.line.description}`.toLowerCase().includes(lineSearch.toLowerCase()));

  const [checkFilter,setCheckFilter]=useState<'pending'|'all'>('pending');
  const extractionGaps=lines.filter(l=>!l.partNumber||!(l.quantity>0)||!l.uom||!l.condition||l.issues.length).length+(intakeRecord?.issues.length||0);
  const stageExportable=!persistencePending&&exportable&&extractionGaps===0&&activePriced.length>0&&activePriced.every(p=>resolved.has(p.line.key));
  const stageItems=inquiryStages({materialCount:intakeRecord?.files.length ?? (email?1+email.attachments.length:lines.length?1:0),lineCount:lines.length,extractionGaps,matchedLines:intakeRecord?intakeRecord.lines.filter(l=>(l as typeof l&{evidence?:unknown[]}).evidence?.length).length:priced.filter(p=>p.cost||p.candidates.length).length,reviewedLines:activePriced.filter(p=>resolved.has(p.line.key)).length,activeLines:activePriced.length,pricedLines:activePriced.filter(p=>validUnitPrice(confirmOf(p))).length,exportAllowed:stageExportable,exported});
  const reviewBasis=JSON.stringify([lines,policy,priced.map(p=>({cost:p.cost,candidates:p.candidates.map(c=>c.row)}))]);
  const seenReviewBasis=useRef(reviewBasis);
  useEffect(()=>{if(seenReviewBasis.current!==reviewBasis){seenReviewBasis.current=reviewBasis;const keys=new Set(lines.map(l=>l.key));if([...resolved].some(k=>keys.has(k)))setResolved(new Set([...resolved].filter(k=>!keys.has(k))));}},[reviewBasis]);
  return (
    <div className="quotation-workbench">
      {inquiryError && <div className="check-box" role="alert"><strong>询价错误：PDF 附件未完成结构化核验</strong><button className="btn primary" onClick={onConvertManual}>转为手工单（保留草稿）</button></div>}
      <header className="inquiry-page-head">
        <div><button className="btn inquiry-back" aria-label="返回询价列表" title="返回询价列表" onClick={onBack}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button><h1>{label}</h1></div>
      </header>
      <div className="stage-workspace">
      <nav className="inquiry-stage-rail" aria-label="询价阶段">{stageItems.map(item=><button key={item.id} aria-current={stage===item.id?'step':undefined} aria-label={`${item.id}. ${item.label}，${item.detail}`} aria-describedby={`stage-tip-${item.id}`} data-tip-dismissed={dismissedStageTip===item.id?'true':undefined} className={`stage-node ${stage===item.id?'current':''} ${item.state}`} onClick={()=>goToStage(item.id)} onMouseEnter={()=>setDismissedStageTip(null)} onFocus={()=>setDismissedStageTip(null)} onKeyDown={e=>{if(e.key==='Escape')setDismissedStageTip(item.id)}}><span className="stage-dot" aria-hidden="true">{item.state==='done'&&stage!==item.id?'✓':item.id}</span><span className="stage-tooltip" role="tooltip" id={`stage-tip-${item.id}`}><strong><span>{String(item.id).padStart(2,'0')}</span>{item.label}</strong><span>{item.detail}</span><small>{item.state==='done'?'已有结果':item.state==='attention'?'待处理':'待执行'}</small></span></button>)}</nav>
      <section className="stage-main" ref={flowRef} aria-label="询价完整流程">

      <section className="workflow-section" data-current={stage===1} id="inquiry-stage-1" tabIndex={-1} data-inquiry-stage="1" aria-labelledby="inquiry-stage-title-1">
        <header className="workflow-section-heading"><h2 id="inquiry-stage-title-1">{stageItems[0].label}</h2></header>
      {email?.intakeBatchId&&<IntakeRecord batchId={email.intakeBatchId} revisionKey={JSON.stringify(email.parsedRows?.map(l=>l.version))} view="files" onLoaded={setIntakeRecord} onEvidenceRefresh={onDataRefresh} />}
      {!email?.intakeBatchId&&<section className="panel stage-original"><div className="panel-title">原始材料 <Badge text="演示／历史记录" tone="gray" /></div>{email?<><div className="source-file-row"><span>邮件</span><b>{email.file}</b><span>{email.from}</span></div><pre className="stage-raw-text">{email.body||'邮件正文为空'}</pre>{email.attachments.map((name,i)=><div className="source-file-row" key={i}><span>附件</span><b>{name}</b></div>)}</>:<div className="source-file-row"><span>历史询价</span><b>{label}</b><span>{lines.length} 行</span></div>}</section>}

      </section>
      <section className="workflow-section" data-current={stage===2} id="inquiry-stage-2" tabIndex={-1} data-inquiry-stage="2" aria-labelledby="inquiry-stage-title-2">
        <header className="workflow-section-heading"><h2 id="inquiry-stage-title-2">{stageItems[1].label}</h2></header>
      {intakeRecord?.issues.length? <div className="stage-input-issues">{intakeRecord.issues.map((issue,i)=><button key={i} onClick={()=>goToStage(1)}>{issue} ↗</button>)}</div>:null}
      <div className="panel inquiry-materials-panel" id="rfq-materials" role="region" aria-label="物料核对">
        <div className="panel-title">物料明细
          <span className="material-header-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {email && !email.intakeBatchId && unreadRows > 0 && aiOk === true && (
            <button className="btn" disabled={llmBusy || estBusy !== ''} onClick={runLlmFix}>
              {llmBusy ? 'AI 重读中…' : `AI 重读 ${unreadRows} 行读不准的`}
            </button>
          )}
            <button className="btn" onClick={reprice} title="按当前加价率/溢价/汇率等参数重算建议价；手工改过的行保留">重新核价</button>
            <button className="btn" onClick={() => setAdding(true)}>新增询价行</button>
          </span>
        </div>
        <div className="wb-filterbar"><FilterTabs label="筛选物料" value={rowFilter} onChange={setRowFilter} items={[{value:'all',label:'全部',count:priced.length},{value:'review',label:'待核对',count:needCheck.length},{value:'unpriced',label:'待定价',count:unpriced.length}]} /><input aria-label="搜索物料" placeholder="搜索件号 / 描述" value={lineSearch} onChange={e=>setLineSearch(e.target.value)} /></div>
        {adding && <form className="check-box" onSubmit={e => { e.preventDefault(); if (!newLine.pn.trim() || !Number.isFinite(Number(newLine.quantity)) || Number(newLine.quantity) <= 0) return; onAddLine(newLine.pn.trim(), Number(newLine.quantity), newLine.uom.trim(), newLine.description.trim()); setAdding(false); setNewLine({ pn: '', quantity: '1', uom: 'EA', description: '', requirement: '', needByDate: '', quoteDeadline: '', dueDate: '' }); }}><div className="edit-grid"><label>新增件号<input required value={newLine.pn} onChange={e => setNewLine({ ...newLine, pn: e.target.value })} /></label><label>新增数量<input required type="number" min="0.01" step="any" value={newLine.quantity} onChange={e => setNewLine({ ...newLine, quantity: e.target.value })} /></label><label>新增单位<input required value={newLine.uom} onChange={e => setNewLine({ ...newLine, uom: e.target.value })} /></label><label>新增描述<input value={newLine.description} onChange={e => setNewLine({ ...newLine, description: e.target.value })} /></label></div><div className="toolbar"><button className="btn primary" type="submit">添加到当前询价</button><button className="btn" type="button" onClick={() => setAdding(false)}>取消新增</button></div></form>}
        <div className="table-wrap material-table-scroll">
          <table className="material-table">
            <colgroup>{[36,130,150,90,145,130,80,100].map((width,i)=><col key={i} style={{width}} />)}</colgroup>
            <thead>
              <tr>
                <th>#</th><th>件号</th><th>描述</th><th>数量</th><th>建议售价</th>
                <th>您的定价</th><th>毛利率</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((p) => {
                const s = suggOf(p);
                const c = confirmOf(p);
                const m = c != null ? marginOf(c, s.costBase) : undefined;
                const reasons = yellowReasons(p);
                const isResolved = resolved.has(p.line.key);
                const checking = reasons.length > 0 && !isResolved;
                return (
                  <Fragment key={p.line.key}>
                    <tr className={`clickable ${selectedAgentLine===p.line.key?'agent-selected-row':''} ${checking ? 'row-yellow' : isResolved ? 'row-resolved' : ''}`}
                      onClick={() => setOpen(open === p.line.key ? null : p.line.key)}>
                      <td>{p.line.lineNo}</td>
                      <td><div className="material-reference-name reference-source" draggable onDragStart={event=>dragReference(event,referenceForLine(p.line))}><b>{p.line.partNumber}</b><button type="button" className="reference-cite" aria-label={`引用物料 ${p.line.partNumber}`} onClick={event=>{event.stopPropagation();citeReference(referenceForLine(p.line));}}>引用</button></div></td>
                      <td>{p.line.description}</td>
                      <td>{p.line.quantity} {p.line.uom}</td>
                      <td>
                        {defaultConfirmPrice(s) != null ? fmtMoney(defaultConfirmPrice(s)) : '—'}
                        {s.aogApplied && <Badge text={`加急+${Math.round(policy.aogPremium * 100)}%`} tone="red" />}
                        {s.bulkApplied && <Badge text={`批量-${Math.round(policy.bulkDiscount * 100)}%`} tone="blue" />}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          className={`price-input ${c != null && s.floor != null && c < s.floor ? 'below-floor' : ''}`}
                          type="number" min="0" step="0.01"
                          aria-label={`${p.line.partNumber} 行单价`} value={c ?? ''} placeholder={defaultConfirmPrice(s)?.toFixed(2) ?? '请定价'}
                          onChange={(e) => setOne(p.line.key, e.target.value)}
                          onBlur={() => logPriceCommit(p.line.key)}
                          onKeyDown={(e) => { if (e.key === 'Enter') logPriceCommit(p.line.key); }} />
                        {c != null && s.floor != null && c < s.floor && (
                          <div className="floor-warn">低于合理最低 {fmtMoney(s.floor)}</div>
                        )}
                      </td>
                      <td className={m != null && m < policy.marginFloor ? 'margin-low' : ''}>
                        {m != null ? `${(m * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td>
                        {skipped.has(p.line.key)
                          ? <Badge text="暂不报价" tone="gray" />
                          : checking
                            ? <Badge text="需核对" tone="amber" />
                            : isResolved
                              ? <Badge text="已核对" tone="green" />
                              : <Badge text="待核价" tone="blue" />}
                      </td>
                    </tr>
                    {open === p.line.key && (
                      <tr className="expand-row"><td colSpan={8}>
                        {editKey === p.line.key ? (
                          <div className="check-box">
                            <b>修改本行（手工）</b>{editError && <p role="alert" className="margin-low">{editError}</p>}
                            <div className="edit-grid">
                              <label>件号<input value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })} /></label>
                              <label>数量<input type="number" min="0.01" step="any" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} /></label>
                              <label>单位
                                <select value={draft.uom} onChange={(e) => setDraft({ ...draft, uom: e.target.value })}>
                                  {[...new Set([draft.uom, 'EA', 'IN', 'FT', 'Each'])].map((u) => <option key={u} value={u}>{u}</option>)}
                                </select>
                              </label>
                              <label>件状
                                <select value={draft.condition} onChange={(e) => setDraft({ ...draft, condition: e.target.value })}>
                                  {['', 'FN', 'NE', 'OH', 'SV'].map((c) => <option key={c} value={c}>{c || '未指定'}</option>)}
                                </select>
                              </label>
                              <label className="span2">描述<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
                              <label className="span2">证书与附加要求<input value={draft.requirement} onChange={e=>setDraft({...draft,requirement:e.target.value})} /></label>
                              <label>到货日期<input type="date" value={draft.needByDate.slice(0,10)} onChange={e=>setDraft({...draft,needByDate:e.target.value})} /></label>
                              <label>报价截止日期<input type="date" value={draft.quoteDeadline.slice(0,10)} onChange={e=>setDraft({...draft,quoteDeadline:e.target.value})} /></label>
                              {draft.dueDate&&<label className="span2">待确认日期<input value={draft.dueDate} onChange={e=>setDraft({...draft,dueDate:e.target.value})} /><span>确认日期用途后，将日期填入对应字段并清空此项。</span></label>}
                            </div>
                            <div className="toolbar" style={{ marginTop: 8 }}>
                              <button className="btn primary" onClick={() => saveEdit(p.line.key)}>保存并重新核价</button>
                              <button className="btn" onClick={() => setEditKey(null)}>取消</button>
                            </div>
                          </div>
                        ) : (
                          <div className="toolbar" style={{ marginBottom: 8 }}>
                            <button className="btn" onClick={() => startEdit(p)}>修改本行（手工）</button>
                          </div>
                        )}
                        {reasons.length > 0 && (
                          <div className="check-box">
                            <b>需要您核对：</b>
                            <ul>{reasons.map((f) => (
                              <li key={f}>
                                {FLAG_PLAIN[f]}
                                {f === 'NO_MATCH' && estCost[p.line.key] != null && '（已有估价，建议价已出）'}
                              </li>
                            ))}</ul>
                            <button className="btn" onClick={() => toggleResolved(p.line.key)}>
                              {isResolved ? '撤销核对标记' : '我已核对，标记完成'}
                            </button>
                            <button className="btn" onClick={() => toggleSkip(p.line.key)}>
                              {skipped.has(p.line.key) ? '恢复报价' : '本行暂不报价（进待报价清单）'}
                            </button>
                          </div>
                        )}
                        {p.flags.includes('NO_MATCH') && (
                          <div className="check-box">
                            <b>非标品 / 查不到件号：</b>
                            <Badge text="缺报价依据" tone="amber" />
                            <div className="toolbar">
                              {aiOk === true && (
                                <button className="btn" disabled={estBusy !== '' || llmBusy} onClick={() => runAiEst(p)}>
                                  {estBusy === p.line.key ? 'AI 估价中…' : 'AI 市场估价'}
                                </button>
                              )}
                              <label className="cost-input-label">成本（元/件）：
                                <input className="policy-input wide" type="number" min="0" step="0.01"
                                  value={estCost[p.line.key]?.value ?? ''} placeholder="AI 估价或人工填"
                                  onChange={(e) => setCost(p.line.key, e.target.value)} />
                              </label>
                              {estCost[p.line.key]?.source === 'ai' && <Badge text="AI 估价" tone="blue" />}
                              {estCost[p.line.key]?.verdict && (
                                <Badge
                                  text={estCost[p.line.key].verdict!}
                                  tone={estCost[p.line.key].verdict === '有市场依据' ? 'green' : estCost[p.line.key].verdict === '有间接参考' ? 'blue' : 'amber'}
                                />
                              )}
                            </div>
                            {estCost[p.line.key]?.basis && (
                              <div className="hint">估价依据：{estCost[p.line.key].basis}（估算，非真实市场报价）</div>
                            )}
                            {estCost[p.line.key]?.limitation && (
                              <div className="hint limitation">证据局限：{estCost[p.line.key].limitation}</div>
                            )}
                            {estCost[p.line.key]?.trace?.length ? (
                              <div className="hint">
                                检索轨迹：{estCost[p.line.key].trace!.map((t, i) => (
                                  <span key={i}>「{t.query}」命中 {t.hits} 条{t.hits === 0 ? '（不以搜索缺失证明无市场价，以下为纯经验估算）' : ''}</span>
                                ))}
                              </div>
                            ) : null}
                            {estCost[p.line.key]?.refs?.length ? (
                              <div className="hint">
                                市场来源：
                                {estCost[p.line.key].refs!.map((r, i) => (
                                  <a key={i} href={r.url} target="_blank" rel="noreferrer" className="ref-link">
                                    {i + 1}. {r.title.slice(0, 36) || r.url}
                                  </a>
                                ))}
                              </div>
                            ) : null}
                            {estCost[p.line.key] != null && suggOf(p).target != null && (
                              <div className="hint">
                                建议售价 <b>{fmtMoney(suggOf(p).target)}</b>　·　合理最低报价 <b className="floor-min">{fmtMoney(suggOf(p).floor)}</b>
                              </div>
                            )}
                          </div>
                        )}
                        {p.cost && (
                          <dl className="row-fact-grid"><div><dt>最近采购价</dt><dd>{fmtMoney(p.cost.lastPurchasePrice)}</dd></div><div><dt>标准成本</dt><dd>{fmtMoney(p.cost.stdCost)}</dd></div><div><dt>库存</dt><dd>{p.cost.stockQty}</dd></div><div><dt>仓库／件状</dt><dd>{p.cost.warehouse} · {p.cost.stockCondition}</dd></div></dl>
                        )}
                        {!p.cost && !p.candidates.length && <Badge text="未匹配" tone="amber" />}
                        {p.candidates.length > 0 && (
                          <table className="sub-table">
                            <thead>
                              <tr><th>供应商</th><th>件状</th><th>单价</th><th>折合人民币</th><th>起订量</th><th>交期</th><th>现货</th><th>证书</th><th>有效期至</th><th>提醒</th></tr>
                            </thead>
                            <tbody>
                              {p.candidates.map((cd) => (
                                <tr key={cd.row.id} className={cd.flags.some((f) => FLAG_META[f].yellow) ? 'row-yellow' : ''}>
                                  <td>{cd.row.supplierName}（{cd.row.supplierType}）</td>
                                  <td>{cd.row.condition || '—'}</td>
                                  <td>{fmtMoney(cd.row.unitPrice, cd.row.currency)}</td>
                                  <td>{fmtMoney(cd.cnyPrice)}</td>
                                  <td>{cd.row.moq}</td>
                                  <td>{cd.row.leadDays} 天</td>
                                  <td>{cd.row.inStock}</td>
                                  <td>{cd.row.certType || '—'}</td>
                                  <td>{cd.row.validUntil}</td>
                                  <td className="flags">{cd.flags.map((f) => <Badge key={f} text={FLAG_PLAIN[f]} tone={FLAG_META[f].yellow ? 'amber' : 'blue'} />)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {p.excluded.length > 0 && (
                          <div className="hint excluded-note">
                            已剔除 {p.excluded.length} 条资源（交期+货运 {policy.freightDays} 天送达晚于需求日期 {p.line.needByDate?.slice(0, 10)}）：
                            {p.excluded.map((e) => `${e.row.supplierName}（${e.row.leadDays}天）`).join('、')}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {!visibleRows.length && priced.length>0 && <tr><td colSpan={8} className="empty-cell">没有符合筛选条件的物料。<button className="btn" onClick={()=>{setRowFilter('all');setLineSearch('');}}>显示全部</button></td></tr>}
              {!priced.length && (
                <tr><td colSpan={8} className="empty-cell">
                  <div style={{ marginBottom: 8 }}>该任务没有解析出行项目</div>
                  {email?.body && !email.intakeBatchId && aiOk === true ? (
                    <button className="btn primary" disabled={llmBusy || estBusy !== ''} onClick={runLlmExtract}>
                      {llmBusy ? 'AI 识别中…' : 'AI 从文字提取订单行（纯语料进单）'}
                    </button>
                  ) : (
                    <div className="empty-actions"><button className="btn" onClick={()=>goToStage(1)}>查看原件</button><button className="btn primary" onClick={()=>setAdding(true)}>录入物料</button></div>
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>


      </section>
      <section className="workflow-section" data-current={stage===3} id="inquiry-stage-3" tabIndex={-1} data-inquiry-stage="3" aria-labelledby="inquiry-stage-title-3">
        <header className="workflow-section-heading"><h2 id="inquiry-stage-title-3">{stageItems[2].label}</h2></header>
      {email?.intakeBatchId&&<IntakeRecord batchId={email.intakeBatchId} revisionKey={JSON.stringify(email.parsedRows?.map(l=>l.version))} view="evidence" rules={{condFnNe:policy.condFnNe,certMutual:policy.certMutual,freightDays:policy.freightDays,fxRates:{...(policy.fxUsd?{USD:policy.fxUsd}:{}),...(policy.fxEur?{EUR:policy.fxEur}:{}),...(policy.fxRates||{})},unitConversions:ds.units}} onLoaded={setIntakeRecord} onEvidenceRefresh={onDataRefresh} />}
      {!email?.intakeBatchId&&<section className="panel"><div className="panel-title">库存与供应商依据</div><div className="table-wrap"><table><thead><tr><th>件号</th><th>库存</th><th>内部成本</th><th>供应商参考</th></tr></thead><tbody>{priced.map(p=><tr key={p.line.key}><td><b>{p.line.partNumber}</b></td><td>{p.cost?`${p.cost.stockQty} ${p.cost.uom}`:'未匹配'}</td><td>{p.cost?fmtMoney(p.cost.lastPurchasePrice||p.cost.avgCost):'缺依据'}</td><td>{p.candidates.length?<div className="candidate-evidence-list">{p.candidates.map((c,i)=><div className="candidate-evidence" key={i}><b>{c.row.supplierName}</b><span>{c.row.unitPrice} {c.row.currency}</span><span>{c.row.condition} · MOQ {c.row.moq} · {c.row.validUntil||'有效期缺失'}</span></div>)}</div>:'未匹配'}</td></tr>)}</tbody></table></div></section>}

      </section>
      <section className="workflow-section" data-current={stage===4} id="inquiry-stage-4" tabIndex={-1} data-inquiry-stage="4" aria-labelledby="inquiry-stage-title-4">
        <header className="workflow-section-heading"><h2 id="inquiry-stage-title-4">{stageItems[3].label}</h2></header>
      {<section className="panel stage-checks"><div className="stage-check-filters"><FilterTabs label="条件检查筛选" value={checkFilter} onChange={setCheckFilter} items={[{value:'pending',label:'待核对',count:activePriced.filter(p=>!resolved.has(p.line.key)).length},{value:'all',label:'全部',count:activePriced.length}]} /></div>{activePriced.filter(p=>checkFilter==='all'||!resolved.has(p.line.key)).map(p=><article className="stage-check-row" key={p.line.key}><div><b>{p.line.partNumber||'件号待补'}</b><span>{p.line.quantity} {p.line.uom}</span></div><div className="stage-check-findings">{p.ruleIssues?.length?p.ruleIssues.map(issue=><span className="check-finding" key={issue}><span className="check-finding-mark" aria-hidden="true">!</span><span>{issue}</span></span>):yellowReasons(p).length?yellowReasons(p).map(f=><span className="check-finding" key={f}><span className="check-finding-mark" aria-hidden="true">!</span><span>{FLAG_PLAIN[f]}</span></span>):<span className="check-neutral">规则未发现阻断项 · 待人工核对</span>}</div><div className="stage-check-actions"><button className="btn" onClick={()=>{goToStage(2);setOpen(p.line.key)}}>查看物料</button><button className="btn" disabled={persistencePending} onClick={()=>toggleResolved(p.line.key)}>{resolved.has(p.line.key)?'撤销核对':'标记人工已核对'}</button></div></article>)}{!activePriced.filter(p=>checkFilter==='all'||!resolved.has(p.line.key)).length&&<div className="stage-empty"><span>✓</span><strong>{activePriced.length?'当前没有待核对行':'暂无物料'}</strong><button className="btn" onClick={()=>goToStage(2)}>打开物料表</button></div>}</section>}

      </section>
      <section className="workflow-section" data-current={stage===5} id="inquiry-stage-5" tabIndex={-1} data-inquiry-stage="5" aria-labelledby="inquiry-stage-title-5">
        <header className="workflow-section-heading"><h2 id="inquiry-stage-title-5">{stageItems[4].label}</h2></header>
      <section className="quote-stage-tools">

      <div className="workflow-actions">
        <div className="toolbar">

          {aiOk === true && lines.length > 0 && (
            <button className="btn" disabled={llmBusy || estBusy !== ''} onClick={runSummary}>汇总需求</button>
          )}
          {aiOk === true && noMatchLeft > 0 && (
            <button className="btn" disabled={estBusy !== '' || llmBusy} onClick={runBatchEst}>
              {estBusy === 'batch' ? 'AI 估价中…' : `AI 估价 ${noMatchLeft} 个非标品`}
            </button>
          )}
          {priced.some((p) => p.flags.includes('NO_MATCH')) && (
            <button className="btn" onClick={doSupplierRfq}>导出供应商询价单（非标品）</button>
          )}
          {email && !email.intakeBatchId && (
            <button className="btn" onClick={() => setShowRaw(!showRaw)}>{showRaw ? '收起原始邮件' : '查看原始邮件'}</button>
          )}
          <button className="btn" onClick={()=>void loadRecords('actions')}>记录</button>
        </div>
        {llmNote && <div className="hint">{llmNote}</div>}
        {summary && <pre className="summary-box">{summary}</pre>}
        {showRaw && email && (
          <pre className="raw-box" ref={rawBoxRef}>
            <RawHighlight body={email.body || '（空正文，内容在附件）'} needle={hlNeedle} />
          </pre>
        )}
        {recordTab&&<Modal title="询价记录" onClose={()=>setRecordTab(null)} className="workflow-record-dialog">
          <FilterTabs label="记录类型" value={recordTab} onChange={value=>void loadRecords(value)} items={[{value:'actions',label:'操作记录'},{value:'quotes',label:'报价版本'}]} />
          {recordBusy?<p role="status">正在读取记录…</p>:recordError?<div role="alert"><p>{recordError}</p><button className="btn" onClick={()=>void loadRecords(recordTab)}>重试</button></div>:<div className="workflow-record-content">
        {recordTab==='actions' && reviewRows && (
          reviewRows.length ? (
            <table className="sub-table" style={{ marginTop: 8 }}>
              <thead><tr><th>时间</th><th>件号</th><th>操作</th><th>说明</th><th>操作人</th></tr></thead>
              <tbody>
                {reviewRows.slice(0, 30).map((r, i) => (
                  <tr key={i}>
                    <td>{r.created_at?.replace('T', ' ').slice(0, 19)}</td>
                    <td>{r.pn}</td><td>{r.action}</td><td>{r.detail}</td><td>{r.operator}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="hint">暂无处理记录</div>
        )}
        {recordTab==='quotes' && snapshots && (
          snapshots.length ? (
            <table className="sub-table" style={{ marginTop: 8 }}>
              <thead><tr><th>时间</th><th>版本</th><th>整单合计</th><th>操作人</th></tr></thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>{s.created_at?.replace('T', ' ').slice(0, 19)}</td>
                    <td>{s.kind}</td>
                    <td>{fmtMoney(s.total)}</td>
                    <td>{s.operator}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="hint">暂无导出记录</div>
        )}
          </div>}
        </Modal>}
      </div>

      </section>
      <div className="panel inquiry-quote-panel" id="rfq-quote-preview" role="region" aria-label="报价草稿">
        <div className="panel-title">
          报价单预览
          <button className="btn" onClick={fillAll}>按规则填入建议价</button>
          <FilterTabs label="报价版式" value={tab} onChange={setTab} items={[{value:'quote',label:'航空 Quote 表'},{value:'cn',label:'中文报价单'}]} />
        </div>

        {tab === 'quote' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Item</th><th>Part No</th><th>Qty</th><th>Unit Price</th><th>Amount</th><th>Delivery</th><th>Condition</th><th>Remarks</th></tr>
              </thead>
              <tbody>
                {activePriced.map((p, i) => {
                  const c = confirmOf(p);
                  const selectedResource = p.basisResource;
                  const reasons = yellowReasons(p);
                  const q = quoteQtyOf(p);
                  const stockCovers = p.basisSource === 'inventory';
                  return (
                    <tr key={p.line.key} className={reasons.length && !resolved.has(p.line.key) ? 'row-yellow' : ''}>
                      <td>{i + 1}</td>
                      <td><b>{p.line.partNumber}</b></td>
                      <td>{q.qty} {p.line.uom}{q.moqNote && <div className="hint">{q.moqNote}</div>}</td>
                      <td><input aria-label={`${p.line.partNumber} 报价单价`} className="price-input" type="number" min="0" step="0.01" value={c ?? ''} placeholder="填写单价" onChange={(e) => setOne(p.line.key, e.target.value)} onBlur={() => logPriceCommit(p.line.key)} onKeyDown={(e) => { if (e.key === 'Enter') logPriceCommit(p.line.key); }} /></td>
                      <td>{c != null ? fmtMoney(c * q.qty) : '—'}</td>
                      <td>{stockCovers ? '现货（库存）' : selectedResource?.leadDays != null ? `${selectedResource.leadDays} 天` : '—'}</td>
                      <td>{selectedResource?.stockCondition || selectedResource?.condition || p.line.condition || '—'}</td>
                      <td>{reasons.length && !resolved.has(p.line.key) ? reasons.map((f) => FLAG_PLAIN[f]).join('；') : p.line.requirement || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="doc-sum">
              <div>行项目合计：{fmtMoney(Math.round(confirmedSum * 100) / 100)}（仅统计已定价行）</div>
              <div>运费 Freight：{fmtMoney(freightCharge)}{freightCharge === 0 && '（未收取，可在定价设置中调整）'}</div>
              <div>整单合计：{fmtMoney(Math.round(orderTotal * 100) / 100)}（大写：{toChineseUpper(Math.round(orderTotal * 100) / 100)}）</div>
              {overCap && <div className="margin-low">整单金额超过审批上限 {fmtMoney(policy.orderCapCny)}，请主管审批后再导出。</div>}
            </div>
            <div className="sign-line">{quoteSignature.signature&&<SignaturePreview signature={quoteSignature.signature}/>}</div>
          </div>
        )}

        {tab === 'cn' && (
          <div className="doc">
            <h3 className="doc-title">报 价 单</h3>
            <div className="doc-parties">
              <span>需方（客户）：{lines[0]?.customer || '________'}</span>
              <span>供方（报价方）：{getCompany().name || '________（设置页维护）'}</span>
              <span>报价日期：{new Date().toISOString().slice(0, 10)}</span>
            </div>
            <table>
              <thead>
                <tr><th>序号</th><th>名称</th><th>规格型号</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th><th>备注</th></tr>
              </thead>
              <tbody>
                {activePriced.map((p, i) => {
                  const c = confirmOf(p);
                  const q = quoteQtyOf(p);
                  const checking = yellowReasons(p).length > 0 && !resolved.has(p.line.key);
                  return (
                    <tr key={p.line.key} className={checking || c == null ? 'row-yellow' : ''}>
                      <td>{i + 1}</td>
                      <td>{p.line.description}</td>
                      <td>{p.line.partNumber}</td>
                      <td>{q.qty}{q.moqNote && <div className="hint">{q.moqNote}</div>}</td>
                      <td>{p.line.uom}</td>
                      <td><input aria-label={`${p.line.partNumber} 报价单价`} className="price-input" type="number" min="0" step="0.01" value={c ?? ''} placeholder="填写单价" onChange={(e) => setOne(p.line.key, e.target.value)} onBlur={() => logPriceCommit(p.line.key)} onKeyDown={(e) => { if (e.key === 'Enter') logPriceCommit(p.line.key); }} /></td>
                      <td>{c != null ? (c * q.qty).toFixed(2) : '待定价'}</td>
                      <td>{checking ? '需核对' : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="doc-sum">
              <div>行项目合计：{fmtMoney(Math.round(confirmedSum * 100) / 100)}（仅统计已定价行）</div>
              <div>运费：{fmtMoney(freightCharge)}{freightCharge === 0 && '（未收取，可在定价设置中调整）'}</div>
              <div>整单合计（小写）：{fmtMoney(Math.round(orderTotal * 100) / 100)}</div>
              <div>整单合计（大写）：{toChineseUpper(Math.round(orderTotal * 100) / 100)}</div>
              {overCap && <div className="margin-low">整单金额超过审批上限 {fmtMoney(policy.orderCapCny)}，请主管审批后再导出。</div>}
            </div>
            <div className="doc-foot">
              <span>交货时间：合同约定</span>
              <span>质保期：新件 {getCompany().warrantyNew} 个月 / 翻修件 {getCompany().warrantyOh} 个月</span>
              <span>报价有效期：{getCompany().validityDays} 天</span>
              <span>供方盖章 / 信用代码：{getCompany().creditCode || '________'}</span>
            </div>
          </div>
        )}

      </div>

      </section>
      <section className="workflow-section" data-current={stage===6} id="inquiry-stage-6" tabIndex={-1} data-inquiry-stage="6" aria-labelledby="inquiry-stage-title-6">
        <header className="workflow-section-heading"><h2 id="inquiry-stage-title-6">{stageItems[5].label}</h2></header>
      <section className="panel stage-export">
        <div className="quote-signature-row"><div className="quote-signature-identity"><b>报价签名</b>{quoteSignature.signature?<><SignaturePreview signature={quoteSignature.signature}/><span>{quoteSignature.signature.signer}</span></>:<span>尚未签名</span>}</div><div className="quote-signature-actions">{quoteSignature.signature&&<button className="btn" onClick={quoteSignature.clear}>清除签名</button>}<button className="btn" disabled={!quoteSignature.basis||!stageExportable} onClick={()=>setSignatureOpen(true)}>{quoteSignature.signature?'重新签名':'手写签名'}</button></div></div>
        {quoteSignature.error&&<div role="alert" className="check-box">{quoteSignature.error}</div>}
        {signatureOpen&&quoteSignature.basis&&<QuoteSignature key={quoteSignature.basis} basis={quoteSignature.basis} signer={getCompany().operator} onClose={()=>setSignatureOpen(false)} onSave={signature=>{quoteSignature.save(signature);setSignatureOpen(false);}}/>}
        <div className="export-checklist"><div><span>物料信息</span><b>{invalidLines.length ? `${invalidLines.length} 行待补全` : `${activePriced.length} 行已完整`}</b><button className="btn" onClick={()=>goToStage(2)}>核对物料</button></div><div><span>人工核对</span><b>{activePriced.filter(p=>!resolved.has(p.line.key)).length} 行待核对</b><button className="btn" onClick={()=>goToStage(4)}>检查条件</button></div><div><span>报价单价</span><b>{activePriced.filter(p=>!validUnitPrice(confirmOf(p))).length} 行待定价</b><button className="btn" onClick={()=>goToStage(5)}>查看草稿</button></div></div>
        {invalidLines.length > 0 && <div role="alert" className="check-box">有 {invalidLines.length} 行缺少件号、单位或大于零的数量，请展开该行并修改。</div>}
        {exportError&&<div role="alert" className="check-box">{exportError}</div>}
        {persistenceError&&<div role="alert" className="check-box">{persistenceError} <button className="btn" onClick={onRetryQuote}>{persistenceConflict?'载入服务端版本':'重试保存'}</button></div>}
        {persistencePending&&!persistenceError&&<div role="status">正在保存询价审核…</div>}
        {exportBusy&&<div role="status">正在保存审核快照…</div>}
        {exportReceipt&&exported&&<Badge text={`已生成文件 · 审核快照 ${exportReceipt}`} tone="green" />}
        <div className="export-row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={!stageExportable||exportBusy} onClick={doExportInternal}>
            下载内部核价表
          </button>
          <button className="btn primary" disabled={!stageExportable||exportBusy} onClick={doExportCustomer}>
            下载客户报价单
          </button>
          {!stageExportable && <div className="export-blockers" role="status">
            <strong>完成以下事项后可导出</strong>
            <ul>
              {extractionGaps>0&&<li><button onClick={()=>goToStage(2)}>补全 {extractionGaps} 项需求信息</button></li>}
              {activePriced.some(p=>!resolved.has(p.line.key))&&<li><button onClick={()=>goToStage(4)}>核对 {activePriced.filter(p=>!resolved.has(p.line.key)).length} 行物料条件</button></li>}
              {unpriced.length>0&&<li><button onClick={()=>goToStage(5)}>填写 {unpriced.length} 行报价单价</button></li>}
              {!activePriced.length&&<li>至少保留一行可报价物料</li>}
            </ul>
          </div>}
          {stageExportable && <Badge text="可导出" tone="green" />}
        </div>
        <div className="export-financials"><dl><div><dt>已定价小计</dt><dd>{fmtMoney(Math.round(confirmedSum*100)/100)}</dd></div><div><dt>客户运费</dt><dd>{fmtMoney(freightCharge)}</dd></div><div><dt>内部预计毛利</dt><dd>{fmtMoney(Math.round(estMargin*100)/100)}</dd></div><div><dt>成本覆盖</dt><dd>{marginKnown.length} 行有成本，共 {activePriced.length} 行</dd></div></dl>{exported&&<div role="status" className="export-receipt">✓ 导出文件已生成</div>}</div>
      </section>
      </section>

      </section>
      </div>
    </div>
  );
}
