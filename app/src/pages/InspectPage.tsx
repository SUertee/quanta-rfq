import {Modal} from '../components/Modal';
import {IntakeRecord} from '../components/IntakeRecord';
import type {InquiryStage} from '../engine/workflow';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset } from '../data';
import type { EstCost, InquiryLine } from '../types';
import type { TaskSummary } from '../task';
import { certificatesFor, condAliasesFor } from '../engine/fieldSchema';
import type {PricingPolicy} from '../engine/pricingPolicy';
import {inspectTask,checkInspectionSelection,type InspectionRow,type InspectionStatus} from '../engine/inspection';
import {appFetch} from '../engine/appUrl';
import { Badge, DataTable, FilterTabs, RecordToolbar } from '../components/ui';
import type { Source } from '../App';

const STATUS_OPTIONS: (InspectionStatus|'全部')[]=['全部','待处理','处理中','待确认','已解决','处理失败'];

/** 异常处理中心：跨任务聚合全部打开任务的风险行 */
export function InspectPage({
  tasks, ds, policy, priceBook, estCost, resolved, skipped, addedLines, lineEdits, onOpenTask, selectedBases={},onDataRefresh,onConfigureRules,onBatchAssistant,
}: {
  tasks: TaskSummary[];
  ds: Dataset;
  policy: PricingPolicy;
  priceBook: Record<string, number>;
  estCost: Record<string, EstCost>;
  resolved: Set<string>;
  skipped: Set<string>;
  addedLines: Record<string, InquiryLine[]>;
  lineEdits: Record<string, Partial<InquiryLine>>;
  selectedBases?:Record<string,string>;
  onDataRefresh?:()=>void;
  onBatchAssistant?:(text?:string,context?:string)=>void;
  onConfigureRules?:()=>void;
  onOpenTask: (s: Source,stage?:InquiryStage,lineKey?:string) => void;
}) {
  const [activeIssue,setActiveIssue]=useState<InspectionRow|null>(null);
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [receipts,setReceipts]=useState<Record<string,InspectionRow>>({});
  const [statusFilter,setStatusFilter]=useState<InspectionStatus|'全部'>('全部');
  const [running,setRunning]=useState(false);
  const [batchNotice,setBatchNotice]=useState('');
  const operation=useRef<AbortController|null>(null);
  useEffect(()=>()=>operation.current?.abort(),[]);
  const state={policy,priceBook,estCost,resolved,skipped,addedLines,lineEdits,selectedBases};
  const currentRows=useMemo(()=>tasks.flatMap(task=>inspectTask(task,ds,state)).filter(row=>row.issues.length),[tasks,ds,policy,priceBook,estCost,resolved,skipped,addedLines,lineEdits,selectedBases]);
  const rows=useMemo(()=>{
    const live=new Map(currentRows.map(row=>[row.key,row]));
    for(const receipt of Object.values(receipts)) {
      if(tasks.some(task=>task.key===receipt.taskKey))live.set(receipt.key,receipt);
    }
    return [...live.values()];
  },[currentRows,receipts,tasks]);
  const runBatch=async()=>{
    const chosen=rows.filter(row=>selected.has(row.key));
    if(!chosen.length||operation.current)return;
    const controller=new AbortController();operation.current=controller;setRunning(true);setBatchNotice('');
    setReceipts(old=>({...old,...Object.fromEntries(chosen.map(row=>[row.key,{...row,status:'待处理' as const}]))}));
    onBatchAssistant?.();
    try {
      const result=await checkInspectionSelection(chosen,tasks,ds,state,{signal:controller.signal,fetcher:appFetch,onProgress:row=>setReceipts(old=>({...old,[row.key]:row}))});
      onDataRefresh?.();
      const counts={resolved:result.filter(row=>row.status==='已解决').length,confirmation:result.filter(row=>row.status==='待确认').length,failed:result.filter(row=>row.status==='处理失败').length};
      const summary=`已检查 ${result.length} 项物料，${counts.resolved} 项已解决，${counts.confirmation} 项待确认，${counts.failed} 项处理失败。`;
      setBatchNotice(summary);
      const context=JSON.stringify({checkedAt:new Date().toISOString(),total:result.length,...counts,truncated:result.length>12,results:result.slice(0,12).map(row=>({inquiry:row.taskTitle.slice(0,150),partNumber:row.pn,status:row.status,issues:row.issues.map(issue=>({type:issue.type,detail:issue.detail.slice(0,250)})),suggestedPriceCny:row.suggestedPrice,error:row.error})),meaning:'已刷新依据并执行规则检查。建议单价为预览，最终价格与人工核对需要用户在对应询价确认。'});
      onBatchAssistant?.(`检查这 ${result.length} 项物料的异常，告诉我还需要处理什么。`,context);
    }catch(error){if(controller.signal.aborted){setBatchNotice('批量检查已停止，已完成的结果已保留。');setReceipts(old=>Object.fromEntries(Object.entries(old).map(([key,row])=>[key,row.status==='处理中'?{...row,status:'待处理'}:row])));}else setBatchNotice(error instanceof Error?error.message:'检查失败，请重试');}
    finally{setRunning(false);operation.current=null;}
  };

  const shown=rows.filter(row=>(statusFilter==='全部'||row.status===statusFilter)&&`${row.taskTitle} ${row.pn} ${row.desc} ${row.issues.map(issue=>issue.type).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const allSelected=shown.length>0&&shown.every(row=>selected.has(row.key));
  const toggle=(key:string)=>setSelected(old=>{const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;});

  return (
    <div className="page-inspect">
      <div className="page-heading"><div><h1>异常处理</h1></div></div>
      <RecordToolbar filters={<FilterTabs label="处理状态" value={statusFilter} onChange={setStatusFilter} items={STATUS_OPTIONS.map(status=>({value:status,label:status}))}/> }>
        <input className="search-input" aria-label="搜索风险物料" placeholder="搜索询价、件号、问题…" value={query} onChange={event=>setQuery(event.target.value)}/>
        <button className="btn primary" disabled={running||!rows.some(row=>selected.has(row.key))} onClick={()=>void runBatch()}>交给助手{selected.size?` · ${rows.filter(row=>selected.has(row.key)).length}`:''}</button>
        {running&&<button className="btn" onClick={()=>operation.current?.abort()}>停止</button>}
      </RecordToolbar>
      <div className="inspection-batch-bar"><label><input type="checkbox" aria-label="选择全部筛选结果" checked={allSelected} disabled={running||!shown.length} onChange={()=>setSelected(old=>{const next=new Set(old);shown.forEach(row=>allSelected?next.delete(row.key):next.add(row.key));return next;})}/>全选筛选结果</label><span>{shown.length} 项物料</span><span role="status">{running?`正在检查 · 已完成 ${Object.values(receipts).filter(row=>selected.has(row.key)&&row.status!=='处理中'&&row.status!=='待处理').length} / ${rows.filter(row=>selected.has(row.key)).length}`:batchNotice}</span></div>
      <div className="panel">
        <DataTable
          rows={shown}
          rowKey={(r) => r.key}
          onRowClick={row=>{if(!running)setActiveIssue(row);}}
          rowClass={() => ''}
          mobileRender={row=><article className="inspection-mobile-record">
            <header><label><input type="checkbox" aria-label={`选择 ${row.taskTitle} ${row.pn}`} disabled={running} checked={selected.has(row.key)} onChange={()=>toggle(row.key)}/><strong>{row.pn}</strong></label><Badge text={row.status} tone={row.status==='已解决'?'green':row.status==='处理失败'?'red':'amber'}/></header>
            <span className="table-cell-lines">{row.taskTitle}</span>
            <div className="inspection-problems"><div>{row.issues.map(issue=><Badge key={issue.type} text={issue.type} tone="amber"/>)}</div></div>
            <footer><span>{row.suggestedPrice!=null?`建议单价 CNY ${row.suggestedPrice.toFixed(2)}`:''}</span><button className="btn" disabled={running} onClick={()=>setActiveIssue(row)}>处理</button></footer>
          </article>}
          cols={[
            {title:'选择',w:'52px',render:row=><input type="checkbox" aria-label={`选择 ${row.taskTitle} ${row.pn}`} disabled={running} checked={selected.has(row.key)} onClick={event=>event.stopPropagation()} onChange={()=>toggle(row.key)}/>},
            {title:'问题',w:'30%',render:row=><div className="inspection-problems"><div>{row.issues.map(issue=><Badge key={issue.type} text={issue.type} tone={['过期价','缺证书','毛利不足'].includes(issue.type)?'red':'amber'}/>)}</div></div>},
            {title:'询价 / 物料',render:row=><div className="task-identity"><strong>{row.pn}</strong><span className="task-name" title={row.taskTitle}>{row.taskTitle}</span></div>},
            {title:'状态',w:'110px',render:row=><Badge text={row.status} tone={row.status==='已解决'?'green':row.status==='处理失败'?'red':row.status==='处理中'?'blue':'amber'}/>},
            {title:'操作',w:'90px',render:row=><button className="btn" disabled={running} onClick={event=>{event.stopPropagation();setActiveIssue(row);}}>处理</button>},
          ]}
        />
      </div>
      {activeIssue&&<Modal title={`${activeIssue.pn} · ${activeIssue.issues.map(issue=>issue.type).join("、")||activeIssue.status}`} className="inspection-resolution-dialog" onClose={()=>setActiveIssue(null)}>
        <p className="inspection-task-title">{activeIssue.taskTitle}</p>{activeIssue.suggestedPrice!=null&&<p>建议单价 CNY {activeIssue.suggestedPrice.toFixed(2)}</p>}
        {activeIssue.error&&<p role="alert">{activeIssue.error}</p>}<ul className="inspection-issue-list">{activeIssue.issues.map(issue=><li key={issue.type}>{issue.detail}</li>)}</ul>
        {activeIssue.source.kind==='email'&&activeIssue.source.id.startsWith('intake-')&&<IntakeRecord key={activeIssue.key} batchId={activeIssue.source.id.slice(7)} view="evidence" initialLineNo={activeIssue.lineNo} selectedBases={selectedBases} onConfigureRules={onConfigureRules} onEvidenceRefresh={()=>{setReceipts(old=>{const next={...old};delete next[activeIssue.key];return next;});onDataRefresh?.();}} rules={{condFnNe:policy.condFnNe,certMutual:policy.certMutual,freightDays:policy.freightDays,fxRates:{...(policy.fxUsd?{USD:policy.fxUsd}:{}),...(policy.fxEur?{EUR:policy.fxEur}:{}),...(policy.fxRates||{})},unitConversions:ds.units,certificates:certificatesFor(ds.fieldSchema),condAliases:condAliasesFor(ds.fieldSchema)}}/>}
        <footer className="app-dialog-actions"><button className="btn" onClick={()=>setActiveIssue(null)}>关闭</button><button className="btn primary" onClick={()=>{const stage:InquiryStage=activeIssue.issues.some(issue=>issue.type==='未定价'||issue.type==='毛利不足')?5:activeIssue.issues.some(issue=>issue.type==='未核对')?4:3;onOpenTask(activeIssue.source,stage,activeIssue.lineKey);setActiveIssue(null);}}>打开对应审核位置</button></footer>
      </Modal>}
    </div>
  );
}
