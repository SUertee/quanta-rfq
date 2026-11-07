import type {Dataset} from '../data';
import type {FlagCode,InquiryLine,PriceCandidate,PricedLine,PriceRow,CostRow} from '../types';
import {evaluateQuoteLine,matchResources,type ResourceCheck,type RuleEvidence} from '../../shared/rfq-rules.mjs';

export const FLAG_META:Record<FlagCode,{label:string;yellow:boolean}>={
  NO_MATCH:{label:'未匹配可用价格依据',yellow:true},UNIT_UNMAPPED:{label:'单位待核',yellow:true},
  COND_MISMATCH:{label:'件状不匹配',yellow:true},COND_EMPTY:{label:'件状空值',yellow:true},
  MOQ_SHORTAGE:{label:'起订量待核对',yellow:true},EXPIRED:{label:'有效期不满足',yellow:true},
  CERT_MISMATCH:{label:'证书要求待核对',yellow:true},PARSE_ISSUE:{label:'需求信息待核对',yellow:true},
  LATE_DELIVERY:{label:'交期不满足或待确认',yellow:true},STOCK_SHORTAGE:{label:'库存数量不满足',yellow:true},
  RESOURCE_REVIEW:{label:'依据条件待确认',yellow:true},FX_DEMO:{label:'参考汇率',yellow:false},PRICE_PENDING:{label:'等待确认单价',yellow:false},
};
const checkFlags:Record<string,FlagCode>={part_number:'NO_MATCH',unit:'UNIT_UNMAPPED',condition:'COND_MISMATCH',quantity:'STOCK_SHORTAGE',moq:'MOQ_SHORTAGE',valid_until:'EXPIRED',valid_from:'EXPIRED',certificate:'CERT_MISMATCH',delivery:'LATE_DELIVERY',price:'NO_MATCH',requested_quantity:'PARSE_ISSUE',quantity_precision:'PARSE_ISSUE'};
const flagsFor=(checks:ResourceCheck[]):FlagCode[]=>[...new Set(checks.filter(check=>check.state!=='pass').map(check=>check.code==='condition'&&check.state==='unknown'?'COND_EMPTY':checkFlags[check.code]||'RESOURCE_REVIEW'))];
export const isYellow=(line:PricedLine)=>line.flags.some(flag=>FLAG_META[flag].yellow);
export interface PriceOpts {freightDays?:number;condFnNe?:boolean;certMutual?:boolean;fxOverride?:Record<string,number>;asOf?:string;}

export function priceLine(line:InquiryLine,ds:Dataset,opts:PriceOpts={}):PricedLine {
  const resources:RuleEvidence[]=line.resourceEvidence??matchResources(line.partNumber,ds.cost||[...ds.costIdx.values()],ds.prices||[...ds.priceIdx.values()].flat());
  const result=evaluateQuoteLine(line,resources,{...opts,fxRates:opts.fxOverride,unitConversions:ds.units});
  const candidates:PriceCandidate[]=result.candidates.filter(entry=>entry.source!=='inventory').map(entry=>({row:entry.snapshot as PriceRow,cnyPrice:entry.match.cost??0,flags:flagsFor(entry.match.checks)}));
  const excluded=candidates.filter(candidate=>candidate.flags.includes('LATE_DELIVERY'));
  const kept=candidates.filter(candidate=>!excluded.includes(candidate));
  const flags=new Set<FlagCode>();
  if(!result.selected){
    if(!resources.length)flags.add('NO_MATCH');
    for(const entry of result.candidates)for(const flag of flagsFor(entry.match.checks))flags.add(flag);
    if(result.issues.some(issue=>issue.includes('不唯一')))flags.add('RESOURCE_REVIEW');
  }
  if(line.issues.length)flags.add('PARSE_ISSUE');
  flags.add('PRICE_PENDING');
  const stock=result.candidates.find(entry=>entry.source==='inventory');
  return {line,matchLevel:resources.length?1:0,cost:stock?.snapshot as CostRow|undefined,candidates:kept,excluded,flags:[...flags],
    ruleVersion:result.ruleVersion,basisCost:result.selected?.match.cost??undefined,basisSource:result.selected?.source,
    basisId:result.selected?.id,basisResource:result.selected?.snapshot,ruleIssues:result.issues,resourceChecks:result.selected?.match.checks||result.candidates.flatMap(entry=>entry.match.checks)};
}
export const priceAll=(lines:InquiryLine[],ds:Dataset,opts:PriceOpts={})=>lines.map(line=>priceLine(line,ds,opts));
export const cleanCandidates=(line:PricedLine)=>line.candidates.filter(candidate=>!candidate.flags.some(flag=>FLAG_META[flag].yellow));
export function referencePrice(line:PricedLine):number|undefined {
  const candidates=cleanCandidates(line);return candidates.length?Math.min(...candidates.map(candidate=>candidate.cnyPrice)):undefined;
}
export function stats(lines:PricedLine[]){return {total:lines.length,matched:lines.filter(line=>line.matchLevel>0).length,quotable:lines.filter(line=>!isYellow(line)).length,byLevel:[0,1,2,3].map(level=>lines.filter(line=>line.matchLevel===level).length)};}
