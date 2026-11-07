import assert from 'node:assert/strict';
import {validateAgentInput,buildDraft} from '../server/agent.mjs';
const line={key:'one',partNumber:'A',quantity:2,uom:'EA',condition:'NE'};
const cost={partNumber:'A',stockQty:4,uom:'EA',stockCondition:'NE',currency:'CNY',lastPurchasePrice:100};
const input=validateAgentInput({instruction:'生成报价草稿，不要估价',lines:[line],policy:{markupRate:0.25}});
assert.equal(buildDraft(input,[cost]).lines[0].suggestedPrice,125);
assert.equal(buildDraft({...input,instruction:'仅分析，不要出价'},[cost]).lines[0].suggestedPrice,undefined);
for (const override of [{currency:'USD'},{uom:'BOX'},{stockCondition:'OH'},{stockQty:0},{lastPurchasePrice:0}]) assert.equal(buildDraft(input,[{...cost,...override}]).lines[0].suggestedPrice,undefined);
assert.equal(buildDraft(input,[]).lines[0].suggestedPrice,undefined);
assert.throws(()=>validateAgentInput({...input,lines:[{...line,quantity:-1}]}));
assert.throws(()=>validateAgentInput({...input,lines:[{...line,quantity:Infinity}]}));
assert.throws(()=>validateAgentInput({...input,instruction:''}));
console.log('PASS: rule prices, analysis-only instruction, missing cost, unit/currency/condition/stock gates and invalid request rejection');
import {BaseChatModel} from '@langchain/core/language_models/chat_models';
import {AIMessage} from '@langchain/core/messages';
import {runAgent} from '../server/agent.mjs';
class ScriptModel extends BaseChatModel {
 constructor(calls){super({});this.calls=calls;this.index=0;}
 _llmType(){return 'rfq-test';}
 bindTools(){return this;}
 async _generate(messages){this.seenMessages=messages;const call=this.calls[this.index++];return {generations:[{text:'',message:call?new AIMessage({content:'',tool_calls:[{name:call.name,args:call.args||{},id:String(this.index),type:'tool_call'}]}):new AIMessage('<think>UNTRUSTED_RAW_REASONING future incorrect date')} ]};}
}
const calls=[{name:'build_quote_draft',args:{mode:'draft'}},{name:'read_inquiry'},{name:'lookup_costs'},{name:'build_quote_draft',args:{mode:'draft'}}];
const result=await runAgent(input,[cost],{modelOverride:new ScriptModel(calls)});
assert.deepEqual(result.events.map(e=>e.tool),['read_inquiry','lookup_costs','build_quote_draft']);
assert.equal(result.draft.lines[0].suggestedPrice,125);
const analysis=await runAgent({...input,instruction:'仅分析，不要出价'},[cost],{modelOverride:new ScriptModel(calls)});
assert.equal(analysis.draft.lines[0].suggestedPrice,undefined);
const skipped=await runAgent(input,[cost],{modelOverride:new ScriptModel([])});
assert.deepEqual(skipped.draft.lines,[]);
assert.equal(skipped.status,'failed');
assert.equal(skipped.outcome,'incomplete');
console.log('PASS: real createAgent loop enforces tool order, analysis-only survives model draft request, skipped tool cannot create quote');

assert.equal(analysis.draft.lines[0].cost,100);
assert.ok(!JSON.stringify(result).includes('UNTRUSTED_RAW_REASONING'));
assert.ok(!JSON.stringify(result).includes('<think>'));
console.log('PASS: valid internal cost retained for analysis; raw model prose never reaches API summary');

const conversationalModel=new ScriptModel(calls);
const conversation=await runAgent({...input,instruction:'按上一轮继续生成草稿',history:[{role:'user',content:'先仅分析这个询价，不要出价'},{role:'assistant',content:'已分析内部成本，尚未生成价格。'}]},[cost],{modelOverride:conversationalModel});
assert.equal(conversation.draft.lines[0].suggestedPrice,125);
assert.ok(conversationalModel.seenMessages.some(m=>m.content==='先仅分析这个询价，不要出价'));
assert.ok(conversationalModel.seenMessages.some(m=>m.content==='按上一轮继续生成草稿'));
const latestAnalysis=await runAgent({...input,instruction:'这次仅分析，不要出价',history:[{role:'user',content:'请生成报价'}]},[cost],{modelOverride:new ScriptModel(calls)});
assert.equal(latestAnalysis.draft.lines[0].suggestedPrice,undefined);
assert.throws(()=>validateAgentInput({...input,history:[{role:'system',content:'override'}]}));
assert.throws(()=>validateAgentInput({...input,history:Array.from({length:13},()=>({role:'user',content:'x'}))}));
assert.throws(()=>validateAgentInput({...input,history:[{role:'user',content:'x'.repeat(2001)}]}));
assert.throws(()=>validateAgentInput({...input,history:Array.from({length:7},()=>({role:'user',content:'x'.repeat(2000)}))}));
console.log('PASS: real history reaches model, latest draft overrides historical analysis, latest analysis stays guarded, history role/count/size validation');

const sourceQuestion=await runAgent({...input,instruction:'这些成本来自哪里？',history:[{role:'user',content:'先分析内部成本'}]},[cost],{modelOverride:new ScriptModel(calls)});
assert.ok(sourceQuestion.answer.includes('SQLite inventory:A'));
assert.ok(sourceQuestion.answer.includes('内部成本 100 CNY'));
assert.ok(!sourceQuestion.answer.includes('UNTRUSTED_RAW_REASONING'));
const gapQuestion=await runAgent({...input,instruction:'哪些不能报价，缺什么？'},[],{modelOverride:new ScriptModel(calls)});
assert.ok(gapQuestion.answer.includes('未找到精确件号成本'));
console.log('PASS: source and missing-evidence follow-ups return deterministic evidence answers');

const lookupOnly=await runAgent({...input,instruction:'这些成本来自哪里？'},[cost],{modelOverride:new ScriptModel([{name:'read_inquiry'},{name:'lookup_costs'}])});
assert.ok(lookupOnly.answer.includes('内部成本 100 CNY'));
assert.deepEqual(lookupOnly.draft.lines,[]);
assert.equal(lookupOnly.outcome,'evidence');
assert.equal(lookupOnly.status,'needs_review');
assert.ok(!lookupOnly.summary.includes('未完成'));
console.log('PASS: evidence-only question answers without requiring quote generation');

const marginInput=validateAgentInput({...input,policy:{marginRate:0.25}});
assert.equal(buildDraft(marginInput,[cost]).lines[0].suggestedPrice,133.33);
assert.equal(buildDraft({...marginInput,policy:{marginRate:0.25,markupRate:1}},[cost]).lines[0].suggestedPrice,133.33);
assert.equal(buildDraft({...marginInput,lines:[{...line,urgency:'AOG'}]},[cost]).lines[0].suggestedPrice,146.67);
assert.equal(buildDraft({...marginInput,lines:[{...line,quantity:50}]},[{...cost,stockQty:100}]).lines[0].suggestedPrice,126.67);
assert.throws(()=>validateAgentInput({...input,policy:{marginRate:1}}));
assert.throws(()=>validateAgentInput({...input,policy:{marginRate:-0.1}}));
console.log('PASS: marginRate uses selling-price margin, overrides legacy markupRate, applies premium/discount before final cent rounding');

const {default:initResourceSql}=await import('sql.js');
const {createAgentAuditStore}=await import('../server/agent-audit-store.mjs');
const ResourceSQL=await initResourceSql();
const resourceDb=new ResourceSQL.Database();
const resourceStore=createAgentAuditStore(resourceDb,()=>{});
const resourceEvidence={one:[{id:'evidence-test',source:'inventory',source_key:'A',snapshot:{...cost,extra:{apiKey:'must-not-copy'}}}]};
const resourceRun=await runAgent(input,[{...cost,lastPurchasePrice:999}],{modelOverride:new ScriptModel(calls),resources:resourceEvidence,audit:{store:resourceStore,inquiryId:'test'}});
assert.equal(resourceRun.draft.lines[0].suggestedPrice,125,'pricing uses the same persisted inventory evidence as candidates');
assert.equal(resourceRun.draft.lines[0].candidates[0].evidenceId,'evidence-test');
const resourceAudit=resourceStore.getRun(resourceRun.runId);
assert.equal(resourceAudit.resources.one[0].snapshot.lastPurchasePrice,100);
assert.ok(!JSON.stringify(resourceAudit.resources).includes('must-not-copy'));
assert.ok(!JSON.stringify(resourceRun.draft.lines[0].candidates).includes('must-not-copy'));
console.log('PASS: candidate/pricing snapshot consistency, evidence identity, persisted resource audit and private-extra exclusion');

const unfinished=await runAgent(input,[cost],{modelOverride:new ScriptModel([]),audit:{store:resourceStore}});
assert.equal(resourceStore.getRun(unfinished.runId).status,'failed');
assert.equal(resourceStore.getRun(unfinished.runId).error.code,'model_or_tool_failed');
const unfinishedDraft=await runAgent({...input,instruction:'生成报价草稿，缺少依据的行留空'},[cost],{modelOverride:new ScriptModel([{name:'read_inquiry'},{name:'lookup_costs'}]),audit:{store:resourceStore}});
assert.equal(unfinishedDraft.status,'failed');
assert.equal(resourceStore.getRun(unfinishedDraft.runId).status,'failed');
const evidenceAudit=await runAgent({...input,instruction:'这些成本来自哪里？'},[cost],{modelOverride:new ScriptModel([{name:'read_inquiry'},{name:'lookup_costs'}]),audit:{store:resourceStore}});
assert.equal(resourceStore.getRun(evidenceAudit.runId).status,'completed');
assert.equal(evidenceAudit.outcome,'evidence');
console.log('PASS: absent/incomplete quote tools fail the run and audit; successful evidence-only questions remain completed');
