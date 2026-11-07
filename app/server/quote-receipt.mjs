import {createHash} from 'node:crypto';
export function validateQuoteReceipt(value,inquiry) {
 const fail=message=>{const e=new Error(message);e.status=400;throw e;};
 if(!value||!['内部版','客户版'].includes(value.kind)||!value.orderId||typeof value.content!=='string'||!Number.isFinite(value.total)||value.total<0)fail('无效报价快照');
 let content;try{content=JSON.parse(value.content);}catch{fail('报价快照不是有效JSON');}
 if(value.inquiryId){
  if(!inquiry||inquiry.id!==value.inquiryId)fail('询价不存在');
  if(content?.schemaVersion!==2||!Array.isArray(content.lines)||content.lines.length!==inquiry.lines.length)fail('报价行与询价不一致');
  const expected=new Map(inquiry.lines.map(l=>[`intake-${inquiry.id}-${l.lineNo}`,l]));const seen=new Set();let active=0;
  for(const l of content.lines){const source=expected.get(l.key);if(!source||seen.has(l.key)||source.partNumber!==l.pn||source.quantity!==l.requestedQty||source.uom!==l.uom||source.condition!==l.condition)fail('询价已变更，请重新核对');seen.add(l.key);
   if(!l.skipped){active++;if(!l.reviewed||!Number.isFinite(l.price)||l.price<=0||!Number.isFinite(l.qty)||l.qty<l.requestedQty)fail('尚有未核对或未定价行');}
  }
  if(!active)fail('没有可报价行');
  if(inquiry.issues?.length||inquiry.lines.some(l=>l.issues?.length))fail('询价材料或提取缺口未处理');
 }else if(!Array.isArray(content)&&content?.schemaVersion!==2)fail('无效报价内容');
 return {content,fingerprint:createHash('sha256').update(value.content).digest('hex')};
}
