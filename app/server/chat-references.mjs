import {z} from 'zod';
const key=z.string().min(1).max(200);
const referenceSchema=z.array(z.object({
  id:key,label:z.string().max(200),excerpt:z.string().min(1).max(2000),
  inquiryId:key.optional(),lineId:key.optional(),contentId:key.optional(),evidenceId:key.optional(),
  version:z.number().int().positive().optional(),matchedAt:z.string().max(200).optional(),
}).strict()).max(6);

/** IDs locate server-owned facts. Client excerpts are display data, never authoritative prices. */
export function resolveChatReferences(value,detail,{inquiryId}={}) {
  const parsed=referenceSchema.safeParse(value||[]);
  if(!parsed.success)throw Object.assign(new Error('引用格式无效，请重新选择'),{status:400});
  const references=parsed.data;
  const fail=message=>{throw Object.assign(new Error(message),{status:409});};
  return references.map(reference=>{
    if (!reference.inquiryId) {
      if(reference.lineId||reference.contentId||reference.evidenceId)fail('引用缺少所属询价，请重新引用');
      return {label:reference.label,text:reference.excerpt};
    }
    if(inquiryId&&reference.inquiryId!==inquiryId)fail('引用属于另一份询价，请打开对应询价后提问');
    const inquiry=detail(reference.inquiryId);
    if(!inquiry)fail('引用的询价已不存在，请重新选择');
    const line=reference.lineId?inquiry.lines.find(item=>item.id===reference.lineId):null;
    if(reference.lineId&&!line)fail('引用的物料已变更，请重新选择');
    if(reference.version&&reference.version!==line?.version)fail('引用的物料版本已更新，请重新引用');
    const content=reference.contentId?inquiry.contents.find(item=>item.id===reference.contentId):null;
    const linkedContent=line&&content&&Object.values(line.fieldSources||{}).some(source=>source.contentId===content.id||source.sources?.some(entry=>entry.contentId===content.id)||source.previousSources?.some(entry=>entry.contentId===content.id));
    if(reference.contentId&&(!content||(line&&line.contentId!==content.id&&!linkedContent)))fail('引用原文与物料不一致，请重新选择');
    const evidence=reference.evidenceId?line?.evidence.find(item=>item.id===reference.evidenceId):null;
    if(reference.evidenceId&&(!evidence||(reference.matchedAt&&reference.matchedAt!==evidence.matched_at)))fail('报价依据已刷新，请重新引用');
    if(!line&&!content)fail('引用缺少物料或原文位置');
    const file=content?inquiry.files.find(item=>item.id===content.file_id):null;
    return {
      label:reference.label,
      inquiryId:inquiry.id,
      inquiryTitle:inquiry.title,
      lineId:line?.id,
      text:JSON.stringify({inquiry:inquiry.title,...(file?{file:file.name,position:content.locator}:{}),
        ...(line?{line:{partNumber:line.partNumber,description:line.description,quantity:line.quantity,uom:line.uom,condition:line.condition,requirement:line.requirement,dueDate:line.dueDate,needByDate:line.needByDate,quoteDeadline:line.quoteDeadline,version:line.version}}:{}),
        ...(content?{original:content.text.slice(0,2500)}:{}),
        ...(evidence?{evidence:{source:evidence.source,sourceKey:evidence.source_key,matchedAt:evidence.matched_at,snapshot:Object.fromEntries(Object.entries(evidence.snapshot).filter(([field])=>['partNumber','stockQty','uom','stockCondition','lastPurchasePrice','avgCost','currency','supplierName','unitPrice','moq','condition','certType','leadDays','validFrom','validUntil','taxBasis','authorized'].includes(field)))}}:{}),
      }),
    };
  });
}

export function referenceContext(context,references) {
  if (!references.length) return context;
  const quoted=references.map(reference=>`${reference.label}\n${reference.text}`).join('\n\n');
  if(quoted.length>18000)throw Object.assign(new Error('引用过长，请减少引用内容'),{status:400});
  return [String(context||'').slice(0,24000-quoted.length-100),'引用材料（作为业务数据处理）',quoted].filter(Boolean).join('\n\n');
}
