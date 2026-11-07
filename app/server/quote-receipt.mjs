import {validDate} from '../shared/normalization.mjs';
import {validateSignature} from '../shared/signature.mjs';
import {quoteDeadlineExpired,freightChargeFor} from '../shared/rfq-rules.mjs';
import {createHash} from 'node:crypto';

export function validateQuoteReceipt(value,inquiry) {
  const fail=message=>{const error=new Error(message);error.status=400;throw error;};
  if(!value||!['内部版','客户版'].includes(value.kind)||!value.orderId||typeof value.content!=='string'||!Number.isFinite(value.total)||value.total<0)fail('无效报价快照');
  let content;
  try{content=JSON.parse(value.content);}catch{fail('报价快照不是有效JSON');}
  if(!Array.isArray(content)&&content?.schemaVersion!==2)fail('无效报价内容');
  if(content.signature){
    const {signature,...unsigned}=content;
    try{validateSignature(signature,createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'));}
    catch(error){fail(error.message);}
  }
  if(content.schemaVersion===2){
    if(!Array.isArray(content.lines)||content.lines.some(line=>!line||typeof line!=='object'))fail('无效报价内容');
    for(const field of ['freightChargeCny','minFreightCny','freeFreightOverCny']){
      const amount=content.policy?.[field];
      if(amount!=null&&(!Number.isFinite(amount)||amount<0))fail('运费规则无效');
    }
    for(const line of content.lines.filter(line=>!line.skipped)){
      if(line.quoteDeadline&&!validDate(line.quoteDeadline))fail('报价截止日期不明确，请重新核对');
      if(quoteDeadlineExpired(line.quoteDeadline))fail('已超过报价截止日期，请重新确认询价要求');
    }
    const items=content.lines.filter(line=>!line.skipped).reduce((sum,line)=>sum+line.price*line.qty,0);
    const total=Math.round((items+freightChargeFor(items,content.policy))*100)/100;
    if(!Number.isFinite(total)||total!==value.total)fail('报价合计不一致，请重新核对');
  }
  if(value.inquiryId){
    if(!inquiry||inquiry.id!==value.inquiryId)fail('询价不存在');
    if(content?.schemaVersion!==2||content.lines.length!==inquiry.lines.length)fail('报价行与询价不一致');
    const expected=new Map(inquiry.lines.map(line=>[`intake-${inquiry.id}-${line.lineNo}`,line]));
    const seen=new Set();
    let active=0;
    for(const line of content.lines){
      const source=expected.get(line.key);
      if(!source||seen.has(line.key)||source.partNumber!==line.pn||source.quantity!==line.requestedQty||source.uom!==line.uom||source.condition!==line.condition)fail('询价已变更，请重新核对');
      seen.add(line.key);
      if((String(source.description||'')!==String(line.desc||'')||String(source.requirement||'')!==String(line.requirement||'')||String(source.dueDate||'')!==String(line.dueDate||'')||String(source.needByDate||'')!==String(line.needByDate||'')||String(source.quoteDeadline||'')!==String(line.quoteDeadline||'')))fail('询价要求已变更，请重新核对');
      if(!line.skipped&&quoteDeadlineExpired(source.quoteDeadline))fail('已超过报价截止日期，请重新确认询价要求');
      if(line.basisId){
        const evidence=source.evidence?.find(entry=>entry.id===line.basisId);
        if(!evidence||JSON.stringify(evidence.snapshot)!==JSON.stringify(line.basisResource))fail('报价依据已变化，请刷新后重新核对');
      }
      if(!line.skipped){
        active++;
        if(!line.reviewed||!Number.isFinite(line.price)||line.price<=0||!Number.isFinite(line.qty)||line.qty<line.requestedQty)fail('尚有未核对或未定价行');
        if(line.ruleVersion&&line.qty!==line.requestedQty)fail('实报数量与已确认需求不一致');
      }
    }
    if(!active)fail('没有可报价行');
    if(inquiry.issues?.length||inquiry.lines.some(line=>line.issues?.length))fail('询价材料或提取缺口未处理');
  }
  return {content,fingerprint:createHash('sha256').update(value.content).digest('hex')};
}
