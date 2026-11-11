import {z} from 'zod';
const publicSnapshot=snapshot=>Object.fromEntries(Object.entries(snapshot).filter(([field])=>['partNumber','stockQty','uom','stockCondition','lastPurchasePrice','avgCost','currency','supplierName','unitPrice','moq','condition','certType','leadDays','validFrom','validUntil','taxBasis','authorized'].includes(field)));
const key=z.string().min(1).max(200);
const referenceSchema=z.array(z.object({
  id:key,label:z.string().max(200),excerpt:z.string().min(1).max(2000),
  inquiryId:key.optional(),lineId:key.optional(),contentId:key.optional(),evidenceId:key.optional(),
  stage:z.number().int().min(1).max(6).optional(),stageVersion:key.optional(),draftVersion:z.number().int().nonnegative().optional(),
  version:z.number().int().positive().optional(),matchedAt:z.string().max(200).optional(),
}).strict()).max(6);

/** IDs locate server-owned facts. Client excerpts are display data, never authoritative prices. */
export function resolveChatReferences(value,detail,{inquiryId,quote}={}) {
  const parsed=referenceSchema.safeParse(value||[]);
  if(!parsed.success)throw Object.assign(new Error('引用格式无效，请重新选择'),{status:400});
  const references=parsed.data;
  const fail=message=>{throw Object.assign(new Error(message),{status:409});};
  return references.map(reference=>{
    if (!reference.inquiryId) {
      if(reference.lineId||reference.contentId||reference.evidenceId||reference.stage)fail('引用缺少所属询价，请重新引用');
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
    if(reference.stage){
      if(!reference.stageVersion||reference.stageVersion!==inquiry.updated_at)fail('模块内容已更新，请重新引用');
      const draft=reference.stage>=5?quote?.(inquiry.id):null;
      if(draft&&(draft.stale||reference.draftVersion!==draft.version))fail('报价版本已更新，请重新引用');
      const data={
        stage:['接收询价','提取需求','查询依据','检查条件','报价草稿','确认导出'][reference.stage-1],status:({processing:'正在处理材料',evidence_ready:'资料提取完成，待人工核对',needs_input:'材料或字段待核对',failed:'材料处理未完成',interrupted:'处理已中断'})[inquiry.status]||'待核对',issues:inquiry.issues.slice(0,8).map(value=>value.slice(0,150)),totalLines:inquiry.lines.length,truncated:true,
        ...(reference.stage===1?{originals:inquiry.contents.slice(0,2).map(content=>({position:content.locator,text:content.text.slice(0,400)}))}:{}),
        materials:inquiry.files.slice(0,6).map(file=>({name:file.name.slice(0,100),status:file.status})),
        lines:inquiry.lines.slice(0,12).map(item=>({partNumber:item.partNumber,quantity:item.quantity,uom:item.uom,condition:item.condition,description:item.description?.slice(0,200),requirement:item.requirement?.slice(0,300),issues:item.issues?.slice(0,3),version:item.version,
          ...(reference.stage>=2?{evidenceCount:item.evidence.length,evidence:item.evidence.slice(0,1).map(entry=>({source:entry.source,sourceKey:entry.source_key,snapshot:publicSnapshot(entry.snapshot)}))}:{})})),
        ...(draft?{quote:{version:draft.version,priceMeaning:'已保存的草稿价格，尚需人工审核',lines:draft.state?.lines.slice(0,12).map(line=>({key:line.key,price:line.price,priceOrigin:line.manual?'人工填写或接受建议':'按报价规则计算',reviewed:line.reviewed,selectedBasisId:line.selectedBasisId}))||[]}}:{}),
      };
      let text=JSON.stringify(data);
      while(text.length>2600){
        data.truncated=true;
        if(data.quote?.lines.length)data.quote.lines.pop();
        else if(data.lines.length>1)data.lines.pop();
        else if(data.materials.length)data.materials.pop();
        else if(data.issues.length)data.issues.pop();
        else if(data.lines.length)data.lines.pop();
        else break;
        text=JSON.stringify(data);
      }
      if(inquiry.lines.length>data.lines.length)data.truncated=true;
      return {label:reference.label,inquiryId:inquiry.id,inquiryTitle:inquiry.title,text:JSON.stringify(data)};
    }
    if(!line&&!content)fail('引用缺少物料或原文位置');
    const file=content?inquiry.files.find(item=>item.id===content.file_id):null;
    return {
      label:reference.label,
      inquiryId:inquiry.id,
      inquiryTitle:inquiry.title,
      lineId:line?.id,
      evidenceId:evidence?.id,
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
