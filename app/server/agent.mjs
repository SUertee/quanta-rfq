import { normalizeLine, normalizePartNumber } from "./normalization.mjs";
import {evaluateQuoteLine,calculateQuotePrice,RFQ_RULE_VERSION,matchResources} from '../shared/rfq-rules.mjs';
import { createAgent, tool } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { RFQ_SYSTEM_PROMPT } from './agent-prompt.mjs';
const historySchema=z.array(z.object({role:z.enum(['user','assistant']),content:z.string().trim().min(1).max(2000)}).strict()).max(12).refine(messages=>messages.reduce((n,m)=>n+m.content.length,0)<=12000,'对话历史超过总长度限制');
const inputSchema = z.object({context:z.string().max(24000).optional(),history:historySchema.optional(),instruction:z.string().trim().min(1).max(2000),lines:z.array(z.object({key:z.string().min(1).max(200),partNumber:z.string().max(100),description:z.string().max(1000).optional(),quantity:z.number().positive().finite().nullable(),uom:z.string().max(30).optional(),condition:z.string().max(30).optional(),requirement:z.string().max(4000).optional(),dueDate:z.string().max(100).optional(),urgency:z.string().max(30).optional(),needByDate:z.string().max(100).optional(),quoteDeadline:z.string().max(100).optional(),selectedBasisId:z.string().max(200).optional(),issues:z.array(z.string().max(1000)).max(50).optional()})).min(1).max(150),policy:z.object({condFnNe:z.boolean().optional(),certMutual:z.boolean().optional(),freightDays:z.number().min(0).max(3650).optional(),fxRates:z.record(z.string(),z.number().positive().finite()).optional(),unitConversions:z.record(z.string(),z.record(z.string(),z.number().positive().finite())).optional(),markupRate:z.number().min(0).max(2).optional(),marginRate:z.number().min(0).lt(1).optional(),aogPremium:z.number().min(0).max(2).optional(),bulkDiscount:z.number().min(0).max(1).optional(),bulkQty:z.number().min(0).finite().optional()}).optional()});
export function validateAgentInput(value) { const input=inputSchema.parse(value); if(new Set(input.lines.map(l=>l.key)).size!==input.lines.length) throw new Error('重复行标识'); return input; }
export function buildDraft(input,costs,resources={}) {
 const analysisOnly=/(只|仅).{0,8}(分析|检查|核对)|不要.{0,5}(报价|出价)|不生成.{0,5}(价格|报价)/.test(input.instruction);
 const lines=input.lines.map(original=>{
  const line={...normalizeLine(original),selectedBasisId:original.selectedBasisId};
  const evidence=resources[line.key]??matchResources(line.partNumber,costs);
  const inventoryOnly=/(仅|只).{0,12}(内部|库存).{0,6}成本/.test(input.instruction);
  const evaluated=evaluateQuoteLine(line,evidence,{...input.policy,inventoryOnly});
  const issues=[...new Set([...line.issues,...evaluated.issues])];
  const selected=evaluated.selected;
  const price=calculateQuotePrice(selected?.match.cost,line,input.policy);
  if(selected&&price.target==null)issues.push('定价规则未产生有效单价，请检查配置');
  const candidates=evaluated.candidates.map(resource=>({source:resource.source,sourceKey:resource.source_key,evidenceId:resource.id,...resource.match,snapshotFingerprint:createHash('sha256').update(JSON.stringify(resource.snapshot)).digest('hex')}));
  return {key:line.key,partNumber:line.partNumber,quantity:line.quantity,uom:line.uom||'',candidates,checks:selected?.match.checks||[],currency:'CNY',ruleVersion:RFQ_RULE_VERSION,
   ...(selected?{cost:price.costBase,basisId:selected.id,basisSource:selected.source,basisLabel:selected.source==='inventory'?'内部库存成本':String(selected.snapshot.supplierName||'供应商报价'),source:selected.source==='inventory'?`SQLite inventory:${selected.source_key}; costUpdateDate=${selected.snapshot.costUpdateDate||'未知'}`:`supplier_price:${selected.source_key}`} :{}),
   ...(!analysisOnly&&!issues.length&&price.target!=null?{suggestedPrice:price.target}:{}),issues};
 });
 return {mode:analysisOnly?'analysis':'draft',ruleVersion:RFQ_RULE_VERSION,lines,questions:lines.flatMap(line=>line.issues.map(issue=>`${line.partNumber||line.key}：${issue}`)),limitations:['全部结果为待审核草稿，依据与条件变化后需要重新核对。']};
}

function config() {
 let local={};
 try { for(const line of readFileSync(fileURLToPath(new URL('../.env.local',import.meta.url)),'utf8').split(/\r?\n/)){ const at=line.indexOf('=');if(at>0)local[line.slice(0,at)]=line.slice(at+1); } } catch {}
 const get=k=>process.env[k]||local[k];
 const apiKey=get('RFQ_LLM_API_KEY'),baseURL=get('RFQ_LLM_BASE_URL'),model=get('VITE_LLM_MODEL');
 if(!apiKey||!baseURL||!model)throw new Error('本机模型配置缺失');
 if(new URL(baseURL).protocol!=='https:')throw new Error('模型地址必须使用 HTTPS');
 return {apiKey,baseURL,model};
}
async function executeAgent(value,costs,{signal,modelOverride,onAuditEvent,resources={}}={}) {
 const input=validateAgentInput(value); const events=[]; let phase=0; let draft=null; let evidenceLines=null;
 const record=(name,detail)=>events.push({tool:name,state:'done',detail});
 const read=tool(async()=>{phase=Math.max(phase,1);record('read_inquiry',`读取 ${input.lines.length} 行`);const {history,...current}=input;return JSON.stringify(current);},{name:'read_inquiry',description:'读取询价与委托，必须先调用',schema:z.object({})});
 const lookup=tool(async()=>{
  if(phase<1) return JSON.stringify({error:'必须先调用 read_inquiry'});
  phase=Math.max(phase,2);const evidence=buildDraft(input,costs,resources).lines.map(({suggestedPrice,...l})=>l); evidenceLines=evidence;
  record('lookup_costs',`核对 ${evidence.filter(l=>l.source).length} 个精确件号`);return JSON.stringify(evidence);
 },{name:'lookup_costs',description:'读取精确件号的成本依据及缺口；不返回建议价',schema:z.object({})});
 const build=tool(async({mode})=>{
  if(phase<2) return JSON.stringify({error:'必须先读取询价并查询成本'});
  const effective=mode==='analysis'?{...input,instruction:'仅分析，不要出价。'+input.instruction}:input;
  draft=buildDraft(effective,costs,resources);phase=3;record('build_quote_draft',`${draft.mode==='analysis'?'仅分析':'生成草稿'} ${draft.lines.length} 行；全部待审核`);return JSON.stringify(draft);
 },{name:'build_quote_draft',description:'按用户要求选择 analysis 仅分析无价格，或 draft 生成规则价格草稿；不得审批写入',schema:z.object({mode:z.enum(['analysis','draft'])})});
 const tools=[read,lookup,build].map(original=>tool(async(args)=>{
  const began=performance.now();
  onAuditEvent?.({tool:original.name,state:'started',argumentsSummary:args});
  try {
   if(signal?.aborted) throw new Error('cancelled');
   const result=await original.invoke(args);
   const blocked=typeof result==='string' && result.includes('"error":');
   onAuditEvent?.({tool:original.name,state:blocked?'blocked':'done',durationMs:performance.now()-began,resultSummary:{lineCount:input.lines.length,pricedCount:draft?.lines.filter(l=>Number.isFinite(l.suggestedPrice)).length||0,issueCount:draft?.lines.filter(l=>l.issues.length).length||0}});
   return result;
  } catch(error) {onAuditEvent?.({tool:original.name,state:signal?.aborted?'cancelled':'failed',durationMs:performance.now()-began});throw error;}
 },{name:original.name,description:original.description,schema:original.schema}));
 const cfg=modelOverride?{model:'offline-test'}:config();
 const model=modelOverride||new ChatOpenAI({model:cfg.model,apiKey:cfg.apiKey,configuration:{baseURL:cfg.baseURL},temperature:0,maxTokens:1600,timeout:45000,maxRetries:0});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const agent=createAgent({model,tools,systemPrompt:RFQ_SYSTEM_PROMPT+'\n本次运行日期（Asia/Shanghai）：'+today+'。不要推断成本已过期；无明确有效期时标记需人工核实。'});
 await agent.invoke({messages:[...(input.history||[]),{role:'user',content:input.instruction}]},{signal,recursionLimit:12});
 // Never return raw model prose: upstream gateways may mix reasoning text into content.
 const finalDraft=draft||{mode:'analysis',lines:[],questions:['Agent 未完成工具流程，未生成报价，请检查委托后重试。'],limitations:[]};
 const evidenceQuestion=/(来源|来自哪里|哪来的|依据|出处|缺什么|缺少什么|缺哪些|哪些.*(不能|无法|缺)|不能报价|信息缺口|风险)/.test(input.instruction);
 const requestsDraft=!/(只|仅).{0,8}(分析|检查|核对)|不要.{0,5}(报价|出价)|不生成.{0,5}(价格|报价)/.test(input.instruction)&&/(生成|形成|输出|制作|出具|计算|填入).{0,12}(报价|草稿|价格|单价)/.test(input.instruction);
 const evidenceComplete=!draft&&!!evidenceLines&&evidenceQuestion&&!requestsDraft;
 if(evidenceComplete)finalDraft.questions=[];
 const incomplete=!draft&&!evidenceComplete;
 const priced=finalDraft.lines.filter(l=>Number.isFinite(l.suggestedPrice)).length;
 const unresolved=finalDraft.lines.filter(l=>l.issues.length>0).length;
 const summary=incomplete?'本次处理未完成，请重试。':evidenceComplete?'已查询当前物料的报价依据。':`已${finalDraft.mode==='analysis'?'分析':'处理'} ${finalDraft.lines.length} 行，生成建议价 ${priced} 行，存在信息缺口 ${unresolved} 行。${finalDraft.mode==='analysis'?'本次仅分析，不生成价格。':''}全部结果待人工核对，未写入或发送报价。`;
 let answer=summary;
 const answerLines=draft?.lines||evidenceLines;
 if(answerLines && /(来源|来自哪里|哪来的|依据|出处)/.test(input.instruction)) {
  answer='本次报价依据来自已保存的库存或供应商资源：\n'+answerLines.map(l=>`${l.partNumber||l.key}：${l.source||'未找到精确件号成本记录'}；${Number.isFinite(l.cost)?`${l.basisSource==='supplier_price'?'供应商成本':'内部成本'} ${l.cost} CNY`:'没有可用的人民币成本'}。`).join('\n')+'\n采用的资源及适用条件已列出，最终报价仍待人工核对。';
 } else if(answerLines && /(缺什么|缺少什么|缺哪些|哪些.*(不能|无法|缺)|不能报价|信息缺口|风险)/.test(input.instruction)) {
  const gaps=answerLines.filter(l=>l.issues.length);
  answer=gaps.length?'以下行仍有信息缺口：\n'+gaps.map(l=>`${l.partNumber||l.key}：${l.issues.join('；')}。`).join('\n'):'本次精确件号成本检查未发现阻断项；证书、交期、报价有效期及最终售价尚需人工核实，不能视为全部业务条件通过。';
 }
 return {runId:randomUUID(),status:incomplete?'failed':'needs_review',outcome:incomplete?'incomplete':draft?'draft':'evidence',summary,answer,model:cfg.model,draft:finalDraft,events};
}

export const RFQ_AGENT_DEFINITION=Object.freeze({agentId:'rfq-quote',version:'1.4.1',promptSha256:createHash('sha256').update(RFQ_SYSTEM_PROMPT).digest('hex'),tools:['read_inquiry','lookup_costs','build_quote_draft']});
export async function runAgent(value,costs,options={}) {
 const audit=options.audit;
 if(!audit) return executeAgent(value,costs,options);
 const {store,actorId='local-user',inquiryId=null}=audit;
 store.registerAgent(RFQ_AGENT_DEFINITION);
 let model='unconfigured';
 try {model=options.modelOverride?'offline-test':config().model;}catch{}
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const inputFingerprint=hash({lines:value?.lines??null,policy:value?.policy??null,instruction:value?.instruction??null,context:value?.context??null,resources:options.resources??{}});
 const partNumbers=new Set(Array.isArray(value?.lines)?value.lines.map(l=>normalizePartNumber(l?.partNumber)):[]);
 const costSnapshotFingerprint=hash({costs:costs.filter(c=>partNumbers.has(normalizePartNumber(c.partNumber))),resources:options.resources||{}});
 const resourceSnapshot=Object.fromEntries(Object.entries(options.resources||{}).map(([key,entries])=>[key,entries.map(entry=>({id:entry.id,source:entry.source,source_key:entry.source_key,snapshot:Object.fromEntries(Object.entries(entry.snapshot||{}).filter(([field])=>['partNumber','uom','stockCondition','condition','stockQty','lastPurchasePrice','avgCost','currency','costUpdateDate','unitPrice','moq','validFrom','validUntil','taxBasis','authorized','leadDays','certType','supplierName','dataSource','dataUpdatedAt'].includes(field)))}))]));
 const runId=store.startRun({...RFQ_AGENT_DEFINITION,actorId,inquiryId,model,inputFingerprint,costSnapshotFingerprint,resources:resourceSnapshot,input:{lineCount:Array.isArray(value?.lines)?value.lines.length:0,historyCount:Array.isArray(value?.history)?value.history.length:0,hasPolicy:!!value?.policy}});
 try {
  validateAgentInput(value);
  if(options.signal?.aborted)throw new Error('cancelled');
  const result=await executeAgent(value,costs,{...options,onAuditEvent:event=>{store.appendEvent(runId,event);options.onAuditEvent?.(event);}});
  if(options.signal?.aborted)throw new Error('cancelled');
  store.finishRun(runId,{status:result.status==='failed'?'failed':'completed',errorCode:result.status==='failed'?'model_or_tool_failed':null,resultFingerprint:hash(result.draft),result:{lineCount:result.draft.lines.length,pricedCount:result.draft.lines.filter(l=>Number.isFinite(l.suggestedPrice)).length,issueCount:result.draft.lines.filter(l=>l.issues.length).length,mode:result.draft.mode}});
  return {...result,runId};
 } catch(error) {
  const cancelled=!!options.signal?.aborted;
  let invalid=false;try{validateAgentInput(value);}catch{invalid=true;}
  store.finishRun(runId,{status:cancelled?'cancelled':'failed',errorCode:cancelled?'cancelled':invalid?'invalid_input':'model_or_tool_failed'});
  const safe=new Error(cancelled?'Agent execution cancelled':'Agent execution failed');safe.auditRunId=runId;throw safe;
 }
}
