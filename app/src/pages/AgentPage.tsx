import type {InquiryStage,WorkflowRun} from '../engine/workflow';
import {ChatMaterialPurpose,ChatSupplierFlow,ChatSupplierResult} from '../components/ChatMaterials';
import {chatMaterialRoute,type MaterialPurpose,type ChatSupplierRequest,type ChatSupplierReceipt} from '../engine/chatMaterials';
import {submitChatInquiry,type ChatIntakeRequest} from '../engine/chatIntake';
import type {IntakeBatch} from '../engine/intake';
import {ChatInquiryReceipt, chatInquiryResult, type ChatInquiryResult} from '../components/ChatInquiryReceipt';
import {ReferenceList,useChatReferences} from '../components/ChatReferences';
import {conversationReferences,type ChatReference} from '../engine/chatReferences';
import {fmtMoney} from '../engine/amount';
import {readChatStream,readAgentStream} from '../engine/chatStream';
import {useChatScroll} from '../engine/useChatScroll';
import {appFetch as fetch} from '../engine/appUrl';
import {ChatAttachmentPreview} from '../components/ChatAttachmentPreview';
import type {ChatAttachment} from '../engine/chatAttachments';
import {ChatMarkdown} from '../components/ChatMarkdown';
import {ChatFiles} from '../components/ChatFiles';
import { useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useStoredState } from '../engine/persistence';
import type { Dataset } from '../data';
import type { TaskSummary } from '../task';
import { linesOf } from '../task';
import type { Source } from '../App';
import type { EstCost, InquiryLine } from '../types';
import type { PricingPolicy } from '../engine/pricingPolicy';
import { isYellow, priceAll } from '../engine/pricing';
import { certificatesFor, condAliasesFor } from '../engine/fieldSchema';
import {ExecutionSteps} from '../components/ExecutionSteps';
import {MessageRail} from '../components/MessageRail';

type DraftLine = { key: string; partNumber: string; quantity: number; uom?: string; cost?: number; basisSource?:string; basisId?:string; basisLabel?:string; suggestedPrice?: number; currency: string; source?: string; issues: string[] };
type AgentResult = { runId: string; status: 'needs_review' | 'failed'; summary: string; answer?: string; model: string; draft: { lines: DraftLine[]; questions: string[]; mode?: string; limitations?: string[] }; events: { tool: string; state: string; detail: string }[] };
type Turn = { references?:ChatReference[]; attachments?:ChatAttachment[]; createdAt?:string; inquiry?:ChatInquiryResult; supplier?:ChatSupplierReceipt; role: 'user' | 'assistant'; content: string; basis?: string; result?: AgentResult; elapsed?: number };
type Session = { state: 'idle' | 'running' | 'failed' | 'stopped'; input: string; turns: Turn[]; error?: string; progressEvents?:{tool:string;state:string}[]; creation?:ChatIntakeRequest; supplierCreation?:ChatSupplierRequest };
const fresh = (): Session => ({ state: 'idle', input: '', turns: [] });
const money = (v?: number) => v == null ? '—' : `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

export function AgentPage({ onWorkflowProgress, onInquiryCreated, operator='本机用户', sessionOverride, quickMessage, onQuickHandled, onHistory, priceBook, tasks, ds, policy, activeSource, lineEdits, resolved, onOpenTask, onSelectTask, onNewInquiry, embedded = false, expanded = false, docked = false, selectedLineKey = null, onClearLine, onClose, onExpand, onApplyPrice, skipped = new Set(), addedLines = {},selectedBases={},persistencePending=false,quoteVersion }: {
  onWorkflowProgress?: (stage:InquiryStage,state:WorkflowRun['state'])=>void;
  onInquiryCreated?: (batch:IntakeBatch,conversationKey:string)=>void;
  operator?:string;
  sessionOverride?:string;
  quickMessage?:{id:number;text:string;inquiryId?:string;workflow?:boolean}|null; onQuickHandled?:()=>void; onHistory?:()=>void;
  skipped?: Set<string>;
  expanded?: boolean; docked?: boolean; embedded?: boolean; selectedLineKey?: string | null; onClearLine?: () => void; onClose?: () => void; onExpand?: () => void;
  onApplyPrice?: (line: DraftLine, price: number) => void;
  onNewInquiry?: () => void;
  addedLines?: Record<string, InquiryLine[]>;
  tasks: TaskSummary[]; ds: Dataset; policy: PricingPolicy;
  selectedBases?:Record<string,string>;
  persistencePending?:boolean;
  quoteVersion?:number;
  activeSource: Source | null; lineEdits: Record<string, Partial<InquiryLine>>;
  priceBook: Record<string, number>; setPriceBook: (v: SetStateAction<Record<string, number>>) => void;
  resolved: Set<string>; setResolved: (v: SetStateAction<Set<string>>) => void;
  estCost: Record<string, EstCost>; setEstCost: (v: SetStateAction<Record<string, EstCost>>) => void;
  onOpenTask: (s: Source) => void; onOpenSettings: () => void;
  onSelectTask: (s: Source) => void;
}) {
  const [materialPurpose,setMaterialPurpose]=useState<MaterialPurpose>('auto');
  const [attachmentContext,setAttachmentContext]=useState('');
  const [attachments,setAttachments]=useState<ChatAttachment[]>([]),[attachmentEpoch,setAttachmentEpoch]=useState(0);
  const [selectedKey, setSelectedKey] = useStoredState<string>('agent-selected', '');
  const [sessions, setSessions] = useStoredState<Record<string, Session>>('rfq-chat-v1', {});
  useEffect(()=>{window.dispatchEvent(new Event('rfq-chat-updated'));},[sessions]);
  const [queueFilter, setQueueFilter] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const activeTask = tasks.find(t => t.source.kind === activeSource?.kind && (t.source.kind === 'email' ? activeSource?.kind === 'email' && t.source.id === activeSource.id : activeSource?.kind === 'kanban' && t.source.rfqId === activeSource.rfqId));
  const task = (embedded ? activeTask : undefined) ?? tasks.find(t => t.key === selectedKey) ?? tasks[0];
  const taskKey = task?.key ?? '';
  const sessionKey = sessionOverride || (embedded && activeSource === null ? '__no_task__' : selectedLineKey ? `${taskKey}:line:${selectedLineKey}` : taskKey);
  const session = {...fresh(),...sessions[sessionKey]};
  const references=useChatReferences(sessionKey,session.state==='running');
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const workflowStage=useRef<InquiryStage|null>(null);
  const composing = useRef(false);
  const chatScroll=useChatScroll(session.turns);
  const draftAside = useRef<HTMLElement | null>(null);
  const openDraft = () => { if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1481px)').matches) { draftAside.current?.focus(); } else { setDrawerOpen(true); } };
  const patch = (key: string, value: Partial<Session>) => setSessions(old => ({ ...old, [key]: { ...(old[key] ?? fresh()), ...value } }));
  const append = (key: string, turn: Turn) => setSessions(old => { const s = old[key] ?? fresh(); return { ...old, [key]: { ...s, turns: [...s.turns, {...turn,createdAt:new Date().toISOString()}] } }; });
  useEffect(() => {
    setSessions(old=>{const saved=old[sessionKey];return saved?.state==='running'?{...old,[sessionKey]:{...saved,state:'stopped',error:'上次执行已中断，已保留部分回复，可以继续提问。'}}:old;});
    return () => { if(workflowStage.current)onWorkflowProgress?.(workflowStage.current,'stopped');workflowStage.current=null;generation.current++; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!activeSource || busy.current) return;
    const selected = tasks.find(t => t.source.kind === activeSource.kind && (t.source.kind === 'email' ? activeSource.kind === 'email' && t.source.id === activeSource.id : activeSource.kind === 'kanban' && t.source.rfqId === activeSource.rfqId));
    if (selected) setSelectedKey(selected.key);
  }, [activeSource]);
  const current = useMemo(() => {
    if (!task) return null;
    const base = linesOf(ds, task.source);
    const key = task.source.kind === 'email' ? `email:${task.source.id}` : `kanban:${task.source.rfqId}`;
    const allLines = [...base.lines, ...(addedLines[key] ?? [])].map(l => ({ ...l, ...lineEdits[l.key],selectedBasisId:selectedBases[l.key] }));
    return { ...base, lines: selectedLineKey ? allLines.filter(l => l.key === selectedLineKey && !skipped.has(l.key)) : allLines.filter(l => !skipped.has(l.key)) };
  }, [ds, task, lineEdits, addedLines, embedded, selectedLineKey, skipped,selectedBases]);
  const priced = useMemo(() => current ? priceAll(current.lines, ds, { freightDays: policy.freightDays, condFnNe: policy.condFnNe, certMutual: policy.certMutual, fxOverride: { ...(policy.fxUsd ? { USD: policy.fxUsd } : {}), ...(policy.fxEur ? { EUR: policy.fxEur } : {}),...(policy.fxRates||{}) }, certificates: certificatesFor(ds.fieldSchema), condAliases: condAliasesFor(ds.fieldSchema) }) : [], [current, ds, policy]);
  const pending = priced.filter(p => isYellow(p) && !resolved.has(p.line.key)).length;
  const basis = JSON.stringify({ lines: current?.lines, policy, inventory: ds.cost, supplierPrices: ds.prices });
  const latestBasis = useRef(basis); latestBasis.current = basis;
  const receiveInquiry = async (creation?: ChatIntakeRequest, instruction=session.input.trim()) => {
    if (busy.current) return;
    const incoming = creation || {requestId:crypto.randomUUID(), instruction, attachments, operator};
    busy.current = true;
    const id = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    if (!creation) {
      append(sessionKey, {role:'user', content:incoming.instruction || incoming.attachments.map(file=>file.name).join('、'), attachments:incoming.attachments});
      setAttachments([]);setMaterialPurpose('auto');setAttachmentContext('');
      setAttachmentEpoch(number=>number+1);
    }
    patch(sessionKey, {state:'running', input:'', error:undefined, creation:incoming, progressEvents:[]});
    try {
      const batch = await submitChatInquiry(incoming, controller.signal);
      if (id !== generation.current || controller.signal.aborted) return;
      append(sessionKey, {role:'assistant', content:'', inquiry:chatInquiryResult(batch)});
      patch(sessionKey, {state:'idle', creation:undefined});
      references.clear();
      onInquiryCreated?.(batch, sessionKey);
    } catch (error) {
      if (id === generation.current) patch(sessionKey, {state:controller.signal.aborted?'stopped':'failed', error:'接收未完成，可重试读取处理结果。'+(error instanceof Error?error.message:'')});
    } finally {
      if (id === generation.current) {busy.current=false;request.current=null;}
    }
  };
  const run = async (preset?: string, automatic=false) => {
    const instruction = (preset ?? (session.input || (references.items.length?'请核对引用内容。':attachments.length?'请核对附件与当前询价；附件中未读取的信息保持待补充，不编造价格。':''))).trim();
    if (!task || !current || busy.current || (!automatic&&attachments.some(f=>f.status==='reading')) || !instruction) return;
    if (session.creation||session.supplierCreation) return;
    const route=automatic?'question':chatMaterialRoute((preset??session.input).trim(),attachments.length,materialPurpose);
    if(route==='choose'){patch(sessionKey,{error:'请选择资料用途，再发送。'});return;}
    if(route==='supplier'){
      append(sessionKey,{role:'user',content:(preset??session.input).trim()||attachments.map(file=>file.name).join('、'),attachments});
      patch(sessionKey,{input:'',error:undefined,supplierCreation:{attachments,operator,inquiryId:current.email?.intakeBatchId}});
      setAttachments([]);setAttachmentEpoch(n=>n+1);setMaterialPurpose('auto');return;
    }
    if(persistencePending){patch(sessionKey,{error:'询价修改正在保存，请稍后重试。'});return;}
    if (onInquiryCreated && (attachments.length || /(新建|创建|建立).{0,8}询价/.test(instruction)) && route==='inquiry') {
      await receiveInquiry(undefined,(preset??session.input).trim());
      return;
    }
    busy.current = true;chatScroll.follow.current=true;
    const id = ++generation.current;
    const controller = new AbortController(); request.current = controller;
    const started = performance.now();
    const activeReferences=automatic?[]:references.items.length?references.items:conversationReferences([],session.turns.filter(turn=>turn.basis===basis)).filter(reference=>{
      if(!reference.inquiryId)return true;
      if(reference.stage&&(reference.stageVersion!==current.email?.intakeUpdatedAt||(reference.stage>=5&&reference.draftVersion!==quoteVersion)))return false;
      if(reference.inquiryId!==current.email?.intakeBatchId)return false;
      const raw=current.email?.parsedRows?.find(row=>row.persistedLineId===reference.lineId);
      if(reference.lineId&&!raw)return false;
      if(reference.version&&reference.version!==raw?.version)return false;
      return !reference.evidenceId||!!raw?.evidence?.some(entry=>entry.id===reference.evidenceId&&(!reference.matchedAt||entry.matched_at===reference.matchedAt));
    });
    const history = session.turns.filter(t => (!t.basis || t.basis === basis) && t.content.trim()).slice(-6).map(t => ({role:t.role,content:t.content.slice(0,2000)}));
    append(sessionKey, {role:'user',content:instruction,basis,attachments:automatic?[]:attachments,references:automatic?[]:references.items});
    if(!automatic){setAttachments([]);setAttachmentEpoch(n=>n+1);setMaterialPurpose('auto');setAttachmentContext('');}
    patch(sessionKey,{state:'running',input:automatic?session.input:'',error:undefined,progressEvents:[]});
    try {
      const greeting = /^(你好|您好|嗨|hello\b|hi\b|你能做什么|你可以做什么|你能帮我|你是谁|介绍一下你|谢谢|感谢)/i.test(instruction);
      const requestsWork = /(生成|计算|核对|检查|查询|分析|报价草稿|单价|库存)/.test(instruction);
      const explainReference=activeReferences.length>0&&/(解释|为什么|什么|如何|怎么|来源|说明)/.test(instruction)&&!/(生成|计算|填入|执行)/.test(instruction);
      if(!automatic&&route==='question'&&attachments.length||!current.lines.length||(greeting&&!requestsWork&&!attachments.length&&!attachmentContext)||explainReference){
        append(sessionKey,{role:'assistant',content:'',basis});
        const response=await fetch('/api/assistant/chat',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},signal:controller.signal,body:JSON.stringify({instruction,history,references:activeReferences,inquiryId:current.email?.intakeBatchId,inquiryTitle:task.title.slice(0,300),context:attachmentContext||(!current.lines.length?JSON.stringify({lineCount:0,status:current.email?.intakeStatus,issues:current.email?.intakeIssues||[],materials:current.email?.attachments||[]}):undefined)})});
        await readChatStream(response,content=>{
          if(id!==generation.current||latestBasis.current!==basis)return;
          setSessions(old=>{const saved=old[sessionKey];if(!saved)return old;const turns=[...saved.turns];const last=turns.length-1;if(turns[last]?.role!=='assistant')return old;turns[last]={...turns[last],content};return {...old,[sessionKey]:{...saved,turns}};});
        });
        if(id===generation.current){if(!automatic)references.clear();patch(sessionKey,{state:'idle'});}
        return;
      }
      const reportsWorkflow=(!!preset&&quickMessage?.workflow&&(!quickMessage.inquiryId||quickMessage.inquiryId===current.email?.intakeBatchId))||(!explainReference&&/(生成|计算).{0,12}(报价|草稿)/.test(instruction));
      if(reportsWorkflow){workflowStage.current=4;onWorkflowProgress?.(4,'running');}
      // Legacy field named margin stores markup rate (cost-based), matching Settings.
      const response = await fetch('/api/agent/run', {method:'POST',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},signal:controller.signal,body:JSON.stringify({instruction,history,references:activeReferences,context:automatic?undefined:attachmentContext,inquiryId:current.email?.intakeBatchId,draftVersion:quoteVersion,lines:current.lines.map(l => ({key:l.key,partNumber:l.partNumber || '',description:l.description,quantity:l.quantity,uom:l.uom,condition:l.condition,urgency:l.urgency,requirement:l.requirement,dueDate:l.dueDate,needByDate:l.needByDate||'',quoteDeadline:l.quoteDeadline||'',customFields:l.customFields,issues:l.issues})),policy:{condFnNe:policy.condFnNe,certMutual:policy.certMutual,freightDays:policy.freightDays,fxRates:{...(policy.fxUsd?{USD:policy.fxUsd}:{}),...(policy.fxEur?{EUR:policy.fxEur}:{}),...(policy.fxRates||{})},markupRate:policy.margin,aogPremium:policy.aogPremium,bulkDiscount:policy.bulkDiscount,bulkQty:policy.bulkQty}})});
      const data = await readAgentStream<AgentResult>(response,(tool,state)=>{
        if(id!==generation.current)return;
        if(workflowStage.current){
          workflowStage.current=Math.max(workflowStage.current,tool==='build_quote_draft'?5:4) as InquiryStage;
          onWorkflowProgress?.(workflowStage.current,'running');
        }
        setSessions(old=>{
          const saved=old[sessionKey];
          if(!saved)return old;
          return {...old,[sessionKey]:{...saved,progressEvents:[...(saved.progressEvents||[]),{tool,state}]}};
        });
      });
      if (!response.ok) throw new Error(`请求失败 (${response.status})`);
      if (id !== generation.current) return;
      if (latestBasis.current !== basis) throw new Error('询价或策略已修改，本轮结果未采用。请重新提问。');
      if (!data.draft || !Array.isArray(data.draft.lines) || !Array.isArray(data.events)) throw new Error('服务返回不完整，请重试。');
      append(sessionKey,{role:'assistant',content:((/生成.{0,8}(报价|草稿)/.test(instruction) ? data.summary : data.answer) || data.summary || '核对完成，请查看本轮结果。'),basis,result:data,elapsed:performance.now()-started});
      if(!automatic)references.clear();
      if(workflowStage.current)onWorkflowProgress?.(data.status==='failed'?workflowStage.current:data.draft.mode==='analysis'?4:6,data.status==='failed'?'failed':data.draft.mode==='analysis'?'attention':'done');
      patch(sessionKey,{state:data.status==='failed'?'failed':'idle',error:data.status==='failed'?'本次处理未完成，请重新发送。':undefined});
    } catch(error) {
      if (id !== generation.current) return;
      if(workflowStage.current)onWorkflowProgress?.(workflowStage.current,controller.signal.aborted?'stopped':'failed');
      patch(sessionKey,{state:controller.signal.aborted ? 'stopped':'failed',error:error instanceof Error ? error.message : String(error)});
    } finally { if (id === generation.current) { busy.current=false; request.current=null;workflowStage.current=null; } }
  };
  const seenQuickMessage=useRef<number|null>(null);
  useEffect(()=>{if(quickMessage&&task&&!persistencePending&&!busy.current&&!session.creation&&!session.supplierCreation&&(!quickMessage.workflow||!!current?.lines.length)&&(!quickMessage.inquiryId||quickMessage.inquiryId===current?.email?.intakeBatchId)&&seenQuickMessage.current!==quickMessage.id){seenQuickMessage.current=quickMessage.id;onQuickHandled?.();void run(quickMessage.text,!!quickMessage.workflow);}},[quickMessage,persistencePending,session.state,session.creation,session.supplierCreation,current?.email?.intakeBatchId,current?.lines.length]);
  const previousSession = useRef(sessionKey);
  useEffect(() => {
    if (previousSession.current !== sessionKey) {
      generation.current++; request.current?.abort(); request.current = null; busy.current = false;
      patch(previousSession.current, {state:'stopped'}); previousSession.current = sessionKey;
    }
  }, [sessionKey]);
  const stop = () => { if(workflowStage.current)onWorkflowProgress?.(workflowStage.current,'stopped');workflowStage.current=null;generation.current++; request.current?.abort(); request.current=null; busy.current=false; patch(sessionKey,{state:'stopped',error:'已停止，本轮迟到结果不会采用。'}); };
  const selectTask = (nextKey: string) => { const next=tasks.find(t=>t.key===nextKey); if(next&&!busy.current){setSelectedKey(next.key);onSelectTask(next.source);} };
  const isDemo = (t: TaskSummary) => t.source.kind !== 'email' || !(t.source.id.startsWith('custom-') || t.source.id.startsWith('intake-'));
  const demo = tasks.find(t=>isDemo(t)&&t.total>0&&!t.inquiryError);
  const latestTurn = [...session.turns].reverse().find(t=>t.role==='assistant'&&t.basis===basis&&t.result&&t.result.draft.mode!=='analysis'&&t.result.draft.lines.length>0);
  const latestResult=latestTurn?.result;
  const draftPanel = <><div className="rfq-draft-heading"><div><span>当前报价</span><h2>报价草稿</h2></div><span className="rfq-draft-status">待人工核对</span></div>
    {latestResult ? <><div className="rfq-draft-totals"><span>已形成建议价 <b>{latestResult.draft.lines.filter(l=>l.suggestedPrice!=null).length}/{latestResult.draft.lines.length} 行</b></span><strong>{latestResult.draft.lines.some(l=>l.suggestedPrice!=null) ? money(latestResult.draft.lines.reduce((n,l)=>n+(l.suggestedPrice??0)*l.quantity,0)) : '待补成本依据'}</strong><small>已定价行小计 · 不含运费</small></div><div className="rfq-draft-scroll">{latestResult.draft.lines.map((line,i)=><article className="rfq-current-line" key={`${line.key}-${i}`}><header><span><b>{line.partNumber || '缺件号'}</b><small>{line.quantity} {line.uom || '单位待补'}</small></span><strong>{line.suggestedPrice==null?'待补依据':money(line.suggestedPrice)}</strong></header><p>{line.basisSource==='supplier_price'?'供应商成本':'内部成本'}：{money(line.cost)}</p><p>来源：{line.source || '未取得依据'}</p>{line.issues.map((issue,j)=><p className="rfq-line-issue" key={j}>{issue}</p>)}</article>)}</div><button className="btn primary" onClick={()=>{setDrawerOpen(false);if(task)onOpenTask(task.source);}}>逐行核对与导出</button></> : <div className="rfq-draft-placeholder"><span>▤</span><h3>还没有报价草稿</h3><button className="btn primary" onClick={()=>run('按当前规则生成报价草稿，缺依据的行留空。')}>生成报价草稿</button></div>}
    <p className="rfq-draft-footnote">{task&&isDemo(task)?'当前询价使用演示样例。':'本地导入的询价。'} 草稿不会自动写入最终报价。</p></>;
  if (task && current && !current.lines.length && !session.turns.length) return <div className="agent-empty"><h2>当前范围暂无可报价物料</h2><button className="btn" onClick={onClearLine}>切回整单</button><button className="btn" onClick={onClose}>收起助手</button></div>;
  if (!task || !current) return <div className="agent-empty"><h2>从一份询价开始</h2><button className="btn primary" onClick={onNewInquiry}>上传询价</button></div>;
  return <div className={`rfq-hybrid ${embedded ? 'rfq-embedded' : ''}`}><aside className="rfq-inquiry-rail"><div className="rfq-queue-heading"><h2>询价队列</h2><span>{tasks.length}</span></div><button className="btn primary rfq-upload" disabled={session.state==='running'} onClick={onNewInquiry}>＋ 上传询价</button><label className="rfq-queue-search"><span>查找询价</span><input aria-label="查找询价" placeholder="搜索客户或询价" value={queueFilter} onChange={e=>setQueueFilter(e.target.value)} /></label><div className="rfq-queue-list">{tasks.filter(t=>`${t.title} ${t.customer}`.toLowerCase().includes(queueFilter.toLowerCase())).map(t=><button className={`rfq-inquiry-item ${taskKey===t.key?'selected':''}`} disabled={session.state==='running'} key={t.key} onClick={()=>selectTask(t.key)}><span className="rfq-item-meta">{isDemo(t)?'演示样例':'本地导入'}<small>{t.total} 行</small></span><strong>{t.title}</strong><span>{t.customer || '客户待补'}</span><small className={t.checkCount?'rfq-queue-warning':''}>{t.checkCount ? `${t.checkCount} 行待核对` : '待确认报价'}</small></button>)}</div><button className="rfq-demo-button" disabled={!demo||session.state==='running'} onClick={()=>demo&&selectTask(demo.key)}>使用演示样例 ↗</button></aside><section className="rfq-chat" aria-label="报价智能体对话">
    {embedded ? <><header className="copilot-header"><div><span className="copilot-mark">Q</span><div><strong>报价助手</strong>{session.state==='running'&&<small>正在核对…</small>}</div></div><div><button className="copilot-icon" aria-label="打开 AI 对话页" title="打开 AI 对话页" onClick={onHistory}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 18 6M8 6h10v10"/></svg></button><button className="copilot-icon" aria-label={expanded||docked?'恢复浮窗':'展开到右侧'} title={expanded||docked?'恢复浮窗':'展开到右侧'} onClick={onExpand}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded||docked?'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5':'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'} /></svg></button><button className="copilot-icon" aria-label="收起报价助手" title="收起报价助手" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button></div></header></> : <header className="rfq-chat-head"><label>询价<select aria-label="切换询价任务" value={taskKey} disabled={session.state === 'running'||!!session.creation} onChange={e => {const t=tasks.find(t => t.key===e.target.value);if(t&&!busy.current){setSelectedKey(t.key);onSelectTask(t.source);}}}>{tasks.map(t => <option key={t.key} value={t.key}>{t.title}</option>)}</select></label><span>{current.lines.length} 行 · {pending} 行待核对</span><button className="btn rfq-mobile-upload" disabled={session.state==='running'} onClick={onNewInquiry}>上传询价</button><button className="btn rfq-draft-toggle" aria-expanded={drawerOpen} onClick={openDraft}>报价草稿</button><button className="btn rfq-workbench-link" onClick={() => onOpenTask(task.source)}>打开工作台</button>{selectedLineKey && <button className="btn" disabled={session.state==='running'} onClick={onClearLine}>切回整单</button>}</header>}
    <div className="rfq-chat-messages" ref={chatScroll.containerRef} onScroll={chatScroll.onScroll} role="log" aria-live="polite">
      {!session.turns.length && <div className="rfq-chat-welcome">{expanded&&<h1>处理这份询价</h1>}{!embedded&&<span className="rfq-chat-avatar">Q</span>}{!embedded&&<h2>{embedded ? (selectedLineKey ? '一起核对这行物料' : '这份询价，交给我核对') : '这份询价，先帮你做什么？'}</h2>}<div className="rfq-chat-suggestions">{embedded&&selectedLineKey&&<button disabled={session.state==='running'} onClick={onClearLine}>处理整单</button>}<button onClick={() => run('按当前规则生成报价草稿，缺少依据的行保留缺口，不估价。')}>生成报价草稿 ↗</button><button onClick={() => run('只检查询价和成本缺口，不生成价格。')}>检查缺失信息 ↗</button></div></div>}
      {session.turns.map((turn,i) => {
        const result=turn.result, stale=!!turn.basis&&turn.basis!==basis, failed=result?.status==='failed';
        return <article key={i} className={`rfq-chat-turn ${turn.role}`}>{turn.role==='assistant'&&<div className="rfq-chat-speaker">Quanta{stale&&<span>旧询价记录</span>}</div>}{result&&<ExecutionSteps events={result.events} lines={result.draft.lines} mode={result.draft.mode}/>}<div className={turn.role==='assistant'&&result?'rfq-response-event':undefined}><div className="rfq-chat-text">{turn.references&&<ReferenceList items={turn.references}/ >}{turn.attachments&&<div className="chat-attachment-strip">{turn.attachments.map(file=><ChatAttachmentPreview key={file.id} attachment={file}/>)}</div>}{turn.supplier ? <ChatSupplierResult receipt={turn.supplier} operator={operator} onOpen={()=>onOpenTask({kind:'email',id:`intake-${turn.supplier!.inquiryId}`})} onImported={batch=>onInquiryCreated?.(batch,sessionKey)}/> : turn.inquiry ? <ChatInquiryReceipt result={turn.inquiry} onOpen={() => onOpenTask({kind:'email',id:`intake-${turn.inquiry!.id}`})}/> : <ChatMarkdown text={turn.content || result?.summary || ''} />}</div>
          {result && <>{result.draft.lines.length>0 && result.draft.mode!=='analysis' && !embedded && <button className="rfq-chat-output" disabled={stale} onClick={openDraft}><span>▤</span><strong>{result.draft.mode==='analysis'?'缺口清单':'报价草稿'} · {result.draft.lines.length} 行</strong><small>{stale?'旧记录':'查看当前草稿 →'}</small></button>}
            {embedded && result.draft.mode!=='analysis' && result.draft.lines.length>0 && <section className="copilot-results" aria-label="报价建议">
              <header className="copilot-result-title"><strong>报价建议</strong><span>{result.draft.lines.length} 项物料</span></header>
              {result.draft.lines.map((line,j)=>{
                const applied=priceBook[line.key]===line.suggestedPrice&&line.suggestedPrice!=null;
                return <article className="copilot-price-card" key={`${line.key}-${j}`}>
                  <header className="quote-line-top">
                    <div><strong className="quote-part">{line.partNumber||'缺件号'}</strong><span className="quote-quantity">{line.quantity} {line.uom||'单位待补'}</span></div>
                    <div className="quote-unit-price"><span>建议单价</span><b>{fmtMoney(line.suggestedPrice,line.currency)||'待补依据'}</b></div>
                  </header>
                  <dl className="quote-cost-basis"><div><dt>{line.basisSource==='supplier_price'?'供应商成本':'内部成本'}</dt><dd>{fmtMoney(line.cost,line.currency)||'待补充'}</dd></div><div><dt>报价依据</dt><dd>{line.basisLabel||(line.basisSource==='supplier_price'?'供应商报价':line.source?'内部库存成本':'暂无满足条件的依据')}</dd></div></dl>
                  {line.issues.length>0&&<ul className="quote-line-issues">{line.issues.map((issue,k)=><li key={k}>{issue}</li>)}</ul>}
                  <footer className="quote-line-actions">
                    <span className={`quote-price-state ${stale?'stale':applied?'applied':'pending'}`}>{failed?'本次处理未完成':stale?'需重新核对':applied?'✓ 已填入单价':line.suggestedPrice==null?'缺少报价依据':'待核对'}</span>
                    {line.suggestedPrice!=null&&!applied&&<button className="btn" disabled={stale||failed||persistencePending||!onApplyPrice} onClick={()=>onApplyPrice?.(line,line.suggestedPrice!)}>接受建议单价</button>}
                  </footer>
                </article>;
              })}
              <footer className="quote-card-footer">{(stale||failed)&&<><span className="quote-stale-reason">{failed?'本次处理未完成':'询价或报价依据已变化'}</span><button className="btn" disabled={session.state==='running'} onClick={()=>run('按当前规则重新生成报价草稿，缺少依据的行保留空白。')}>重新生成建议</button></>}<button className="btn" onClick={()=>onOpenTask(task.source)}>前往工作台核对</button></footer>
            </section>}
            {result.draft.mode==='analysis' && result.draft.lines.length>0 && <section className="rfq-chat-artifact"><header><strong>缺口清单</strong><span>{result.draft.lines.length} 行</span></header><div className="rfq-chat-table"><table><thead><tr><th>物料</th><th>数量</th><th>依据成本</th><th>待核对事项</th></tr></thead><tbody>{result.draft.lines.map((line,j)=><tr key={j}><td>{line.partNumber || '缺件号'}</td><td>{line.quantity} {line.uom}</td><td>{money(line.cost)}</td><td>{line.issues.length?line.issues.join('；'):'未发现额外成本缺口，业务条件仍待人工核对'}</td></tr>)}</tbody></table></div></section>}
          </>}
        </div></article>;
      })}
      {session.state==='running' && <div className="rfq-chat-thinking" role="status">{session.progressEvents?.length?<ExecutionSteps events={session.progressEvents} running/>:<span>正在回复…</span>}</div>}
      {session.creation&&session.state!=='running'&&<div className="chat-intake-recovery"><button className="btn" onClick={()=>receiveInquiry(session.creation)}>重试接收</button><button className="btn" onClick={()=>patch(sessionKey,{creation:undefined,error:undefined,state:'idle'})}>放弃重试</button></div>}
      {session.error && <div className="rfq-chat-error" role="alert">{session.progressEvents?.length?<ExecutionSteps events={session.progressEvents}/>:null}{session.error}</div>}

    </div>
    {!embedded&&<MessageRail container={chatScroll.containerRef} turns={session.turns}/>}
    <footer className="rfq-chat-footer"><div className="chat-conversation-context" title={task.title}><span>当前询价</span><strong>{task.title}</strong>{persistencePending && <span role="status">正在同步…</span>}</div><div className="rfq-chat-composer">{references.composer}{attachments.length>0&&<ChatMaterialPurpose value={materialPurpose} onChange={setMaterialPurpose} disabled={session.state==='running'||!!session.creation}/> }<ChatFiles showPicker key={attachmentEpoch} disabled={session.state==='running'||!!session.creation} onChange={setAttachments} excerptLimit={1400} onRead={setAttachmentContext}/><textarea aria-label="给智能体的指令" placeholder="输入消息…" maxLength={2000} value={session.input} disabled={session.state==='running'||!!session.creation} onChange={e=>patch(sessionKey,{input:e.target.value})} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&!composing.current&&e.keyCode!==229){e.preventDefault();void run();}}} />{session.state==='running' ? <button className="stop-btn" onClick={stop}>停止</button> : <button aria-label="发送消息" className="send-btn" disabled={(!session.input.trim()&&!attachments.length&&!references.items.length)||attachments.some(f=>f.status==='reading')||!!session.creation} onClick={()=>run()}>↑</button>}</div></footer>
    {session.supplierCreation&&<ChatSupplierFlow request={session.supplierCreation} onTarget={id=>patch(sessionKey,{supplierCreation:{...session.supplierCreation!,inquiryId:id}})} onCancel={()=>patch(sessionKey,{supplierCreation:undefined})} onReceived={receipt=>{append(sessionKey,{role:'assistant',content:'',supplier:receipt});patch(sessionKey,{supplierCreation:undefined});}}/>}
  </section><aside className="rfq-current-draft" ref={draftAside} tabIndex={-1} aria-label="当前报价草稿">{draftPanel}</aside>{drawerOpen&&<div className="rfq-draft-overlay" onClick={()=>setDrawerOpen(false)}><aside className="rfq-draft-drawer" role="dialog" aria-modal="true" aria-label="报价草稿" tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape')setDrawerOpen(false);}} onClick={e=>e.stopPropagation()}><button autoFocus className="rfq-drawer-close" onClick={()=>setDrawerOpen(false)}>关闭 ×</button>{draftPanel}</aside></div>}</div>;
}
