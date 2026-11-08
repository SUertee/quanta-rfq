import {PdfPreview} from './PdfPreview';
import {fieldConflictIssues} from '../../shared/field-review.mjs';
import {SupplierImportDialog} from './SupplierImportDialog';
import {evaluateQuoteLine,type RulePolicy} from '../../shared/rfq-rules.mjs';
import {citeReference,dragReference,type ChatReference} from '../engine/chatReferences';
import {appFetch as fetch,appUrl} from '../engine/appUrl';
import { useEffect, useRef, useState } from "react";
import type { IntakeBatch } from "../engine/intake";
type Pane = "files" | "issues" | "evidence";
type Evidence = {
  id: string;
  source: string;
  source_key: string;
  matched_at?: string;
  current_match?: { state: string; checks: { code: string; state: string; message: string }[]; asOf: string; ruleVersion: string };
  snapshot: Record<string, unknown> & { match?: { state: string; checks: { code: string; state: string; message: string }[]; asOf: string; ruleVersion: string } };
};
const documentTypes: Record<string, string> = { customer_inquiry: '客户询价', supplier_quote: '供应商报价', inventory: '库存', certificate: '证书', unknown: '待分类' };
const matchStates: Record<string, string> = { usable: '条件满足', needs_review: '待确认', conflict: '条件冲突' };
const fieldLabels: Record<string, string> = { partNumber: '件号', quantity: '数量', uom: '单位', condition: '件状', dueDate: '待确认日期', needByDate: '到货日期', quoteDeadline: '报价截止日期', description: '描述', requirement: '要求', mpn: '制造商件号', priority: '优先级', manualPn: '手册件号', productScope: '产品范围' };
const fileStates: Record<string, string> = {
  parsed: "已读取",
  needs_ocr: "待识别",
  unsupported: "不支持的格式",
  failed: "读取失败",
  processing: "读取中",
};
function position(locator?: Record<string, unknown>) {
  if (!locator) return "";
  if (locator.sheet) return `${locator.sheet} · 第 ${locator.row} 行`;
  if (locator.page) return `第 ${locator.page} 页`;
  if (locator.line) return `第 ${locator.line} 行`;
  return "邮件正文";
}
function value(v: unknown) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}
export function IntakeRecord({
  batchId,
  revisionKey,
  view,
  onLoaded,
  onEvidenceRefresh,
  operator='本机用户',rules,selectedBases={},selectionDisabled=false,onSelectBasis,
}: {
  selectedBases?:Record<string,string>;
  selectionDisabled?:boolean;
  onSelectBasis?:(key:string,id:string|null)=>void;
  operator?:string;
  batchId: string;
  rules?: RulePolicy;
  revisionKey?: string;
  view?: Pane | null;
  onLoaded?: (record: IntakeBatch) => void;
  onEvidenceRefresh?:()=>void;
}) {
  const [record, setRecord] = useState<IntakeBatch | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [localPane, setPane] = useState<Pane | null>(null),
    [selected, setSelected] = useState("");
  const [supplierImportOpen,setSupplierImportOpen]=useState(false);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [recovering,setRecovering]=useState(false);
  const [readEpoch,setReadEpoch]=useState(0);
  const recoveryRequest=useRef<{requestId:string;fingerprint:string;operator:string}|null>(null);
  const recoveryController=useRef<AbortController|null>(null);
  useEffect(()=>{recoveryRequest.current=null;setRecovering(false);setRecord(null);return()=>recoveryController.current?.abort();},[batchId]);
  const recover=async()=>{
    if(busy||recovering)return;
    const controller=new AbortController();recoveryController.current=controller;
    setRecovering(true);setError('');
    try {
      if(!recoveryRequest.current){
        const response=await fetch(`/api/inquiries/${batchId}/recovery`,{signal:controller.signal});
        const check=await response.json();
        if(!response.ok||!check.canRecover)throw Error(check.reason||check.error||'无法恢复处理');
        if(controller.signal.aborted)return;
        recoveryRequest.current={requestId:crypto.randomUUID(),fingerprint:check.fingerprint,operator:operator||'本机用户'};
      }
      const response=await fetch(`/api/inquiries/${batchId}/recovery`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recoveryRequest.current),signal:controller.signal});
      let data=await response.json();
      if(!response.ok){if(response.status>=400&&response.status<500)recoveryRequest.current=null;throw Error(data.error||'恢复处理失败');}
      if(controller.signal.aborted)return;
      setRecord(data);onLoaded?.(data);onEvidenceRefresh?.();
      setReadEpoch(value=>value+1);
      recoveryRequest.current=null;
    } catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error));}
    finally{if(!controller.signal.aborted)setRecovering(false);}
  };
  const pane = view === undefined ? localPane : view;
  const load = async (refresh = false) => {
    setError("");
    setBusy(true);
    try {
      const r = await fetch(
        "/api/inquiries/" +
          encodeURIComponent(batchId) +
          (refresh ? "/evidence" : ""),
        { method: refresh ? "POST" : "GET" },
      );
      if (!r.ok) throw new Error("询价记录读取失败");
      const data = await r.json();
      setRecord(data);
      onLoaded?.(data);
      if(refresh)onEvidenceRefresh?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const controller=new AbortController();
    const poll=async()=>{
      let wasProcessing=false;
      try {
        while(!controller.signal.aborted){
          const response=await fetch(`/api/inquiries/${batchId}`,{signal:controller.signal});
          if(!response.ok)throw Error('询价记录读取失败');
          const data=await response.json();
          if(controller.signal.aborted)return;
          setRecord(data);onLoaded?.(data);setBusy(false);
          if(data.status!=='processing'){if(wasProcessing)onEvidenceRefresh?.();return;}
          wasProcessing=true;
          await new Promise(resolve=>setTimeout(resolve,600));
        }
      } catch(error){if(!controller.signal.aborted){setError(String(error));setBusy(false);}}
    };
    setBusy(true);setError('');void poll();
    return()=>controller.abort();
  }, [batchId, revisionKey,readEpoch]);
  const previewFile = record?.files.find(file => file.id === previewFileId);
  const previewContents = record?.contents.filter(content => content.file_id === previewFileId) || [];
  const lines = record?.lines || [];
  const issueCount =
    (record?.issues.length || 0) + lines.filter((l) => l.issues?.length).length;
  const matched = lines.filter(
    (l) => (l as typeof l & { evidence?: Evidence[] }).evidence?.length,
  ).length;
  const line = lines.find((l) => l.id === selected) || lines[0];
  const content = record?.contents.find((c) => c.id === line?.contentId);
  const file = record?.files.find((f) => f.id === content?.file_id);
  const changedFields = Object.entries(fieldLabels).filter(([key]) => {
    if (line&&fieldConflictIssues(line,key).length) return true;
    if (line?.fieldSources?.[key]?.method === 'manual' || line?.fieldSources?.[key]?.sources?.length) return true;
    if (['needByDate','quoteDeadline','dueDate'].includes(key) && line?.[key as keyof typeof line]) return true;
    const original = line?.rawFields?.[key];
    return original != null && String(original) !== String((line as Record<string, unknown>)[key]);
  });
  const evidence =
    (line as typeof line & { evidence?: Evidence[] })?.evidence || [];
  const sourceReference: ChatReference = {
    id:`content:${content?.id||''}:${line?.version||1}`,
    label:`原文 · ${file?.name||'材料'} · ${position(content?.locator)}`,
    excerpt:content?.text||'无原文',
    inquiryId:batchId,lineId:line?.id,contentId:content?.id,version:line?.version,
  };
  const evidenceReference = (entry: Evidence): ChatReference => ({
    id:`evidence:${entry.id}:${entry.matched_at||''}`,
    label:entry.source==='inventory'?'内部库存与成本':String(entry.snapshot.supplierName||'供应商报价'),
    excerpt:JSON.stringify({partNumber:line?.partNumber,source:entry.source_key,...Object.fromEntries(Object.entries(entry.snapshot).filter(([field])=>['unitPrice','lastPurchasePrice','stockQty','currency','moq','uom','condition','certType','leadDays','validUntil'].includes(field)))}),
    inquiryId:batchId,lineId:line?.id,version:line?.version,evidenceId:entry.id,matchedAt:entry.matched_at,
  });
  const resourceResult=line?evaluateQuoteLine({...line,selectedBasisId:selectedBases[`intake-${batchId}-${line.lineNo}`]},evidence,rules):null;
  const evaluatedEvidence=evidence.map(entry=>({...entry,current_match:resourceResult?.candidates.find(candidate=>candidate.id===entry.id)?.match||entry.current_match}));
  const toggle = (next: Pane) => setPane((old) => (old === next ? null : next));
  return (
    <section
      className={`inquiry-intake ${view !== undefined ? "stage-intake" : ""}`}
      aria-label="询价处理结果"
      hidden={view === null}
    >
      {pane==='files'&&record&&['failed','interrupted'].includes(record.status)&&<div className="intake-recovery-actions"><button className="btn" disabled={busy||recovering} onClick={()=>void recover()}>{recovering?'正在恢复…':'恢复处理'}</button></div>}
      {supplierImportOpen&&<SupplierImportDialog inquiryId={batchId} operator={operator} onClose={()=>setSupplierImportOpen(false)} onImported={()=>load(true)} />}
      {view === undefined && (
        <div className="intake-summary">
          <button
            className={pane === "files" ? "active" : ""}
            aria-expanded={pane === "files"}
            onClick={() => toggle("files")}
          >
            <span className="intake-step">1</span>
            <span>
              原始材料 <b>{record?.files.length ?? "—"}</b>
            </span>
            <small>
              {!record
                ? "读取中"
                : record.files.some((f) => f.status !== "parsed")
                  ? "有文件待处理"
                  : "已保存"}
            </small>
          </button>
          <button
            className={pane === "issues" ? "active" : ""}
            aria-expanded={pane === "issues"}
            onClick={() => toggle("issues")}
          >
            <span className="intake-step">2</span>
            <span>
              需求提取 <b>{lines.length}</b>
            </span>
            <small>
              {issueCount ? `${issueCount} 项待核对` : "查看提取结果"}
            </small>
          </button>
          <button
            className={pane === "evidence" ? "active" : ""}
            aria-expanded={pane === "evidence"}
            onClick={() => toggle("evidence")}
          >
            <span className="intake-step">3</span>
            <span>
              报价依据{" "}
              <b>
                {matched}/{lines.length}
              </b>
            </span>
            <small>查看匹配来源</small>
          </button>
        </div>
      )}
      {error && (
        <p className="intake-error" role="alert">
          {error} <button className="btn" onClick={()=>setReadEpoch(value=>value+1)}>重新读取</button>
        </p>
      )}
      {pane && record && (
        <div className="intake-detail">
          <div className="intake-detail-head">
            <strong>
              {pane === "files"
                ? "原始材料"
                : pane === "issues"
                  ? "提取与待核对项"
                  : "报价依据"}
            </strong>
            {view === undefined && (
              <button
                className="btn"
                aria-label="收起详情"
                onClick={() => setPane(null)}
              >
                收起
              </button>
            )}
          </div>
          {pane === "files" && (
            <>
              <div className="intake-file-strip" aria-label="原始文件">
                {record.files.map(file => (
                  <button
                    type="button"
                    className="intake-file-chip"
                    key={file.id}
                    title={`${documentTypes[file.document_type] || '待分类'} · ${fileStates[file.status] || file.status}`}
                    aria-expanded={previewFileId === file.id}
                    aria-controls={`file-preview-${batchId}`}
                    onClick={() => setPreviewFileId(current => current === file.id ? null : file.id)}
                  >
                    <span className="intake-file-icon" aria-hidden="true">{file.file_type?.toUpperCase() || file.name.split('.').pop()?.toUpperCase()}</span>
                    <b>{file.name}</b>
                    {file.status !== 'parsed' && <span className="badge badge-amber">{fileStates[file.status] || file.status}</span>}
                  </button>
                ))}
              </div>
              {previewFile && (
                <section className="intake-inline-preview" id={`file-preview-${batchId}`} aria-label={`预览 ${previewFile.name}`}>
                  <header>
                    <strong>{previewFile.name}</strong>
                    <div>
                      <a className="btn" href={appUrl(`/api/files/${encodeURIComponent(previewFile.id)}/raw`)} download>下载</a>
                      <button className="btn" type="button" onClick={() => setPreviewFileId(null)}>关闭</button>
                    </div>
                  </header>
                  <div className="intake-inline-preview-body">
                    {['png', 'jpg', 'jpeg', 'webp'].includes(previewFile.file_type) ? (
                      <img src={appUrl(`/api/files/${encodeURIComponent(previewFile.id)}/preview`)} alt={previewFile.name} />
                    ) : previewFile.file_type === 'pdf' ? (
                      <PdfPreview url={appUrl(`/api/files/${encodeURIComponent(previewFile.id)}/preview`)} name={previewFile.name} />
                    ) : previewContents.some(content => content.cells?.length) ? (
                      <table><tbody>{previewContents.map(content => <tr key={content.id}><th>{position(content.locator)}</th>{(content.cells || [content.text]).map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody></table>
                    ) : (
                      <pre>{previewContents.map(content => content.text).join('\n') || '尚无可读正文，请下载原文件核对。'}</pre>
                    )}
                  </div>
                  {previewFile.error && <p role="alert">{previewFile.error}</p>}
                </section>
              )}
            </>
          )}
          {pane === "issues" && (
            <div className="intake-issues">
              {record.issues.map((issue, i) => (
                <div className="intake-issue" key={"issue" + i}>
                  <span>待核对</span>
                  {issue}
                </div>
              ))}
              {lines
                .filter((l) => l.issues?.length)
                .map((l) => (
                  <button
                    className="intake-issue"
                    key={l.id}
                    onClick={() => {
                      setSelected(l.id);
                      setPane("evidence");
                    }}
                  >
                    <b>{l.partNumber || "件号待补充"}</b>
                    <span>{l.issues?.join(" · ")}</span>
                    <span>查看原文 ↗</span>
                  </button>
                ))}
              {!issueCount && <p>未发现提取缺口。</p>}
            </div>
          )}
          {pane === "evidence" && (
            <>
              <div className="intake-evidence-toolbar">
                <span>{matched} 行有匹配依据 · {lines.length - matched} 行待补充</span>
                <div className="intake-evidence-actions">
                  <button className="btn" onClick={()=>setSupplierImportOpen(true)}>导入供应商报价</button>
                  <button className="btn" disabled={busy} onClick={()=>void load(true)}>{busy?'查询中…':'刷新依据'}</button>
                </div>
              </div>
              {line&&selectedBases[`intake-${batchId}-${line.lineNo}`]&&onSelectBasis&&<div className="evidence-selection"><span>{resourceResult?.selected?'已指定报价依据':'已选依据待重新确认'}</span><button type="button" className="btn" disabled={selectionDisabled} onClick={()=>onSelectBasis(`intake-${batchId}-${line.lineNo}`,null)}>恢复自动选择</button></div>}
              <div className="intake-evidence-layout">
                <nav aria-label="选择物料依据">
                  {lines.map((l) => (
                    <button
                      className={line?.id === l.id ? "active" : ""}
                      key={l.id}
                      onClick={() => setSelected(l.id)}
                    >
                      <b>{l.partNumber || "件号待补"}</b>
                      <small>
                        {l.quantity ?? "—"} {l.uom || ""}
                      </small>
                    </button>
                  ))}
                </nav>
                <div className="intake-evidence-body">
                  {line ? (
                    <>
                      <section className="intake-source reference-source" aria-label="原文依据" draggable onDragStart={event=>dragReference(event,sourceReference)}>
                        <div className="intake-source-label">
                          <span>原文 · {file?.name} · {position(content?.locator)}</span><button type="button" className="reference-cite" onClick={()=>citeReference(sourceReference)}>引用</button>
                        </div>
                        <pre>{content?.text || "无原文"}</pre>
                      </section>
                      {line.rawFieldsStatus === 'legacy_unknown' && <p>历史记录的原始字段值未保留，请核对原文。</p>}
                      {changedFields.length > 0 && (
                        <div className="normalization-values">
                          <table>
                            <thead><tr><th>字段</th><th>原始值</th><th>当前值</th></tr></thead>
                            <tbody>{changedFields.map(([key, label]) => (
                              <tr key={key}>
                                <th>{label}</th>
                                <td data-label="原始值">{line.rawFields?.[key] == null ? '本行未提供' : value(line.rawFields[key])}</td>
                                <td data-label="当前值">
                                  {value((line as Record<string, unknown>)[key])}
                                  {line.fieldSources?.[key]?.method === 'manual' && <span className="badge badge-blue">人工修改</span>}
                                  {line.fieldSources?.[key]?.confirmation&&<small>已确认 · {line.fieldSources[key].confirmation.reason}</small>}
                                  {[...(line.fieldSources?.[key]?.sources||[]),...(line.fieldSources?.[key]?.rejectedSources||[]),...(line.fieldSources?.[key]?.previousSources||[])].filter((source,index,all)=>source.contentId!==line.contentId&&all.findIndex(other=>other.contentId===source.contentId&&other.value===source.value)===index).map((source,index)=>{
                                    const origin=record?.contents.find(content=>content.id===source.contentId);
                                    const originFile=record?.files.find(file=>file.id===origin?.file_id);
                                    const reference:ChatReference={id:`content:${source.contentId}:${line.version||1}`,label:`${label} · ${originFile?.name||'材料'}`,excerpt:origin?.text||String(source.value||'要求原文'),inquiryId:batchId,lineId:line.id,contentId:source.contentId||undefined,version:line.version};
                                    return <small className="reference-source" draggable onDragStart={event=>dragReference(event,reference)} key={index}>{originFile?.name} · {position(origin?.locator)} · {source.value}</small>;
                                  })}
                                </td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                      {evidence.length ? (
                        evaluatedEvidence.map((e) => (
                          <article className="evidence-card reference-source" key={e.id} draggable onDragStart={event=>dragReference(event,evidenceReference(e))}>
                            <header>
                              <strong>
                                {e.source === "inventory"
                                  ? "内部库存与成本"
                                  : (e.snapshot.supplierName ? String(e.snapshot.supplierName) : "供应商报价")}
                              </strong>
                              <div className="reference-actions">{resourceResult?.selected?.id===e.id&&<span className="badge badge-green">{selectedBases[`intake-${batchId}-${line.lineNo}`]?'已选依据':'自动选用'}</span>}<span>
                                {e.snapshot.dataSource === "official_demo"
                                  ? "演示数据"
                                  : e.source === "inventory"
                                    ? "库存记录"
                                    : "供应商报价"}
                                {e.snapshot.sourceDocument&&typeof e.snapshot.sourceDocument==='object'?` · ${String((e.snapshot.sourceDocument as Record<string,unknown>).fileName||'')}`:''}
                              </span><button type="button" className="reference-cite" aria-label={`引用依据 ${e.source_key}`} onClick={()=>citeReference(evidenceReference(e))}>引用</button></div>
                            </header>
                            {onSelectBasis&&<div className="evidence-selection"><button type="button" className="btn" disabled={selectionDisabled||e.current_match?.state!=='usable'||!!line.issues?.length||selectedBases[`intake-${batchId}-${line.lineNo}`]===e.id} aria-pressed={selectedBases[`intake-${batchId}-${line.lineNo}`]===e.id} onClick={()=>onSelectBasis(`intake-${batchId}-${line.lineNo}`,e.id)}>{selectedBases[`intake-${batchId}-${line.lineNo}`]===e.id?'已选为报价依据':'选为报价依据'}</button></div>}
                            {e.current_match && (
                              <section className="resource-checks" aria-label="候选适用条件">
                                <strong className={`badge badge-${e.current_match.state === 'usable' ? 'green' : e.current_match.state === 'conflict' ? 'red' : 'amber'}`}>
                                  {matchStates[e.current_match.state] || '待确认'}
                                </strong>
                                <ul>{e.current_match.checks.filter(check => check.state !== 'pass').map(check => <li key={check.code}>{check.message}</li>)}</ul>
                                <span>完整件号匹配{e.snapshot.sourceDocument&&typeof e.snapshot.sourceDocument==='object'?` · ${position((e.snapshot.sourceDocument as {locator?:Record<string,unknown>}).locator)}`:''}{e.matched_at&&` · 取数 ${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai'}).format(new Date(e.matched_at))}`}</span>
                              </section>
                            )}
                            <dl>
                              {(e.source === "inventory"
                                ? [
                                    ["库存数量", e.snapshot.stockQty],
                                    ["单位", e.snapshot.uom],
                                    ["件状", e.snapshot.stockCondition],
                                    [
                                      "最近采购价",
                                      `${value(e.snapshot.lastPurchasePrice)} ${value(e.snapshot.currency)}`,
                                    ],
                                    [
                                      "平均成本",
                                      `${value(e.snapshot.avgCost)} ${value(e.snapshot.currency)}`,
                                    ],
                                    ["仓库", e.snapshot.warehouse],
                                    ["更新日期", e.snapshot.costUpdateDate],
                                  ]
                                : [
                                    [
                                      "供应商单价",
                                      `${value(e.snapshot.unitPrice)} ${value(e.snapshot.currency)}`,
                                    ],
                                    ["起订量", e.snapshot.moq],
                                    ["件状", e.snapshot.condition],
                                    [
                                      "交期",
                                      e.snapshot.leadDays === null
                                        ? "—"
                                        : `${value(e.snapshot.leadDays)} 天`,
                                    ],
                                    ["有效期", e.snapshot.validUntil],
                                    ["证书", e.snapshot.certType],
                                  ]
                              ).map(([label, v]) => (
                                <div key={String(label)}>
                                  <dt>{value(label)}</dt>
                                  <dd>{value(v)}</dd>
                                </div>
                              ))}
                            </dl>
                          </article>
                        ))
                      ) : (
                        <div className="intake-no-evidence">
                          未找到精确件号依据
                        </div>
                      )}
                    </>
                  ) : (
                    <p>暂无可匹配的物料。</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
