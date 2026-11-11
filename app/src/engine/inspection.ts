import type {Dataset} from '../data';
import type {TaskSummary} from '../task';
import {linesOf} from '../task';
import type {EstCost,InquiryLine} from '../types';
import type {Source} from '../App';
import {isYellow,priceAll} from './pricing';
import {suggestPrice,type PricingPolicy} from './pricingPolicy';
import {certificatesFor,condAliasesFor} from './fieldSchema';
import {FLAG_PLAIN} from '../plain';

export type IssueType='过期价'|'缺证书'|'毛利不足'|'未命中'|'待报价滞留'|'未核对'|'未定价';
export type InspectionStatus='待处理'|'处理中'|'待确认'|'已解决'|'处理失败';
export interface InspectionRow {
  key:string;taskKey:string;taskTitle:string;pn:string;desc:string;source:Source;lineNo:number;lineKey:string;
  issues:{type:IssueType;detail:string}[];status:InspectionStatus;suggestedPrice?:number;error?:string;
}
export interface InspectionState {
  policy:PricingPolicy;priceBook:Record<string,number>;estCost:Record<string,EstCost>;resolved:Set<string>;skipped:Set<string>;
  addedLines:Record<string,InquiryLine[]>;lineEdits:Record<string,Partial<InquiryLine>>;selectedBases:Record<string,string>;
}

/** One record per task/material, even when several conditions need attention. */
export function inspectTask(task:TaskSummary,ds:Dataset,state:InspectionState):InspectionRow[] {
  const {policy,priceBook,estCost,resolved,skipped,addedLines,lineEdits,selectedBases}=state;
  const sourceKey=task.source.kind==='email'?`email:${task.source.id}`:`kanban:${task.source.rfqId}`;
  const base=linesOf(ds,task.source).lines;
  const lines=[...base,...(addedLines[sourceKey]||[])].map(line=>({...line,...lineEdits[line.key],selectedBasisId:selectedBases[line.key]}));
  const priced=priceAll(lines,ds,{freightDays:policy.freightDays,condFnNe:policy.condFnNe,certMutual:policy.certMutual,certificates:certificatesFor(ds.fieldSchema),condAliases:condAliasesFor(ds.fieldSchema),fxOverride:{...(policy.fxUsd?{USD:policy.fxUsd}:{}),...(policy.fxEur?{EUR:policy.fxEur}:{}),...(policy.fxRates||{})}});
  return priced.map(item=>{
    const line=item.line,key=line.key,issues:InspectionRow['issues']=[];
    const add=(type:IssueType,detail:string)=>issues.push({type,detail});
    const suggestion=suggestPrice(item,policy,estCost[key]?.value);
    if(skipped.has(key))add('待报价滞留','已暂缓报价，需要确认后续处理方式');
    else {
      if(item.flags.includes('EXPIRED'))add('过期价','候选报价有效期不满足当前需求');
      if(item.flags.includes('CERT_MISMATCH'))add('缺证书','候选证书不满足需求');
      if(item.flags.includes('NO_MATCH')&&!estCost[key])add('未命中','尚无可用库存成本或供应商报价');
      if(!resolved.has(key))add('未核对',isYellow(item)?item.flags.filter(flag=>flag!=='PRICE_PENDING'&&flag!=='FX_DEMO').map(flag=>FLAG_PLAIN[flag]).join('；')||'供货条件待人工核对':'供货条件待人工核对');
      if(priceBook[key]==null)add('未定价','报价单价待确认');
      else if(suggestion.floor!=null&&priceBook[key]<suggestion.floor)add('毛利不足',`单价 ${priceBook[key]} 低于报价底线 ${suggestion.floor}`);
    }
    return {key:`${task.key}:${key}`,taskKey:task.key,taskTitle:task.title,pn:line.partNumber||'件号待补',desc:line.description,source:task.source,lineNo:line.lineNo,lineKey:key,issues,status:issues.length?'待处理':'已解决',suggestedPrice:item.ruleIssues?.length?undefined:suggestion.target} satisfies InspectionRow;
  });
}

export async function checkInspectionSelection(selected:InspectionRow[],tasks:TaskSummary[],ds:Dataset,state:InspectionState,options:{signal:AbortSignal;onProgress:(row:InspectionRow)=>void;fetcher:typeof fetch}) {
  const results:InspectionRow[]=[];
  for(const taskKey of new Set(selected.map(row=>row.taskKey))) {
    options.signal.throwIfAborted();
    const chosen=selected.filter(row=>row.taskKey===taskKey),task=tasks.find(task=>task.key===taskKey);
    if(!task)continue;
    chosen.forEach(row=>options.onProgress({...row,status:'处理中'}));
    try {
      let dataset=ds,currentState=state;
      if(task.source.kind==='email'&&task.source.id.startsWith('intake-')) {
        const id=task.source.id.slice(7);
        const response=await options.fetcher(`/api/inquiries/${encodeURIComponent(id)}/evidence`,{method:'POST',signal:options.signal});
        const batch=await response.json();if(!response.ok)throw Error(batch.error||'依据刷新失败');
        const {batchEmail}=await import('./intake');
        const email=batchEmail(batch);
        dataset={...ds,emails:ds.emails.map(item=>item.id===email.id?email:item)};
        const quoteResponse=await options.fetcher(`/api/inquiries/${encodeURIComponent(id)}/quote`,{signal:options.signal});
        const quote=await quoteResponse.json();if(!quoteResponse.ok)throw Error(quote.error||'审核状态读取失败');
        const saved=quote.state as import('./useInquiryQuote').QuoteDraftState|null;
        currentState={
          ...state,
          policy:saved?.policy||state.policy,
          lineEdits:{},
          resolved:new Set(saved?.lines.filter(line=>line.reviewed&&!quote.stale).map(line=>line.key)),
          skipped:new Set(saved?.lines.filter(line=>line.skipped).map(line=>line.key)),
          priceBook:Object.fromEntries(saved?.lines.filter(line=>line.price!=null&&!quote.stale).map(line=>[line.key,line.price!])||[]),
          selectedBases:Object.fromEntries(saved?.lines.filter(line=>line.selectedBasisId).map(line=>[line.key,line.selectedBasisId!])||[]),
          estCost:Object.fromEntries(saved?.lines.filter(line=>line.manualCost&&!quote.stale).map(line=>[line.key,line.manualCost!])||[]),
        };
      }
      const updated=inspectTask(task,dataset,currentState);
      for(const row of chosen) {
        const result=updated.find(item=>item.lineKey===row.lineKey);
        const receipt:InspectionRow=result?{...result,status:result.issues.length?'待确认':'已解决'}:{...row,status:'处理失败',error:'物料已变化，请打开询价核对'};
        results.push(receipt);options.onProgress(receipt);
      }
    }catch(error) {
      if(options.signal.aborted)throw error;
      for(const row of chosen){const receipt:InspectionRow={...row,status:'处理失败',error:error instanceof Error?error.message:'检查失败'};results.push(receipt);options.onProgress(receipt);}
    }
  }
  return results;
}
