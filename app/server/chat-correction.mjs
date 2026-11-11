import {tool} from 'langchain';
import {z} from 'zod';

const values=z.object({supplierName:z.string().max(200).optional(),unitPrice:z.number().nonnegative().optional(),currency:z.string().max(10).optional(),uom:z.string().max(30).optional(),condition:z.string().max(30).optional(),moq:z.number().nonnegative().optional(),leadDays:z.number().nonnegative().optional(),validFrom:z.string().max(10).optional(),validUntil:z.string().max(10).optional(),certType:z.string().max(200).optional(),taxBasis:z.enum(['inclusive','exclusive']).optional(),authorized:z.boolean().optional(),remark:z.string().max(1000).optional()}).strict();

/** The model prepares a proposal. The existing correction endpoint performs the confirmed write. */
export function chatCorrectionTools(references,store,ctx,guardInquiry) {
  const targets=references.filter(item=>item.inquiryId&&item.evidenceId);
  let proposal;
  const correction=tool(async({target,changes,reason})=>{
    const reference=targets[target];
    if(!reference)return JSON.stringify({error:'请先引用需要处理的供应商报价'});
    guardInquiry(reference.inquiryId,true);
    const current=store.read(reference.inquiryId,reference.evidenceId,ctx);
    if(!changes||!Object.keys(changes).length)return JSON.stringify({target,label:reference.label,...current});
    const differences=Object.entries(changes).filter(([key,value])=>value!==current.resource[key]).map(([field,after])=>({field,before:current.resource[field]??null,after}));
    if(!differences.length)return JSON.stringify({message:'这些字段与当前报价一致，请检查实际需要处理的条件'});
    if(!reason?.trim())return JSON.stringify({error:'请补充这些修改的核实依据'});
    proposal={inquiryId:reference.inquiryId,evidenceId:reference.evidenceId,version:current.version,label:reference.label,partNumber:current.demand.partNumber,values:changes,reason,differences};
    return JSON.stringify({message:'已生成待确认修改卡片，等待用户点击确认保存。尚未写入。',differences});
  },{name:'prepare_supplier_correction',description:'读取当前引用的供应商报价，或把用户明确提供且已核实的字段修改生成待确认卡片。target 是本轮引用列表中的编号。省略 changes 时只读取。不得自行降低起订量、补造日期、证书或授权。不能修改客户需求数量。',schema:z.object({target:z.number().int().nonnegative(),changes:values.optional(),reason:z.string().max(2000).optional()})});
  return {tools:targets.length?[correction]:[],targets:targets.map((item,index)=>({target:index,label:item.label})),proposal:()=>proposal};
}
