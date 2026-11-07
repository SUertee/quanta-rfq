import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import initSqlJs from 'sql.js';
import {createAgentAuditStore,openAgentAuditStore} from '../server/agent-audit-store.mjs';
import {runAgent,RFQ_AGENT_DEFINITION} from '../server/agent.mjs';
import {BaseChatModel} from '@langchain/core/language_models/chat_models';
import {AIMessage} from '@langchain/core/messages';
const dir=mkdtempSync(join(tmpdir(),'rfq-agent-audit-'));const filePath=join(dir,'audit.sqlite');
const secret='sk-PRIVATE_SENTINEL';
class ScriptModel extends BaseChatModel {
 constructor({fail=false,cancel}={}){super({});this.index=0;this.fail=fail;this.cancel=cancel;}
 _llmType(){return 'audit-script';}bindTools(){return this;}
 async _generate(){if(this.cancel){this.cancel.abort();throw new Error(secret);}if(this.fail)throw new Error(secret+' Authorization bearer hidden');const names=['read_inquiry','lookup_costs','build_quote_draft'];const name=names[this.index++];return {generations:[{text:'',message:name?new AIMessage({content:'',tool_calls:[{id:String(this.index),type:'tool_call',name,args:name==='build_quote_draft'?{mode:'analysis'}:{}}]}):new AIMessage('<think>'+secret)}]};}
}
const value={instruction:'仅分析 '+secret,history:[{role:'user',content:'reasoning: '+secret}],lines:[{key:'line1',partNumber:'PART',quantity:1,uom:'EA',condition:'NE'}]};
const costs=[{partNumber:'PART',currency:'CNY',uom:'EA',stockCondition:'NE',stockQty:10,lastPurchasePrice:100}];
try {
 let store=await openAgentAuditStore({filePath});
 const result=await runAgent(value,costs,{modelOverride:new ScriptModel(),audit:{store,actorId:'local-user',inquiryId:'inquiry-1'}});
 let run=store.getRun(result.runId);assert.equal(run.status,'completed');assert.equal(run.actorId,'local-user');assert.equal(run.inquiryId,'inquiry-1');assert.equal(run.events.length,6);assert.equal(run.events[0].state,'started');assert.equal(run.events[5].state,'done');assert.equal(run.result.mode,'analysis');assert.ok(run.durationMs>=0);assert.equal(run.version,RFQ_AGENT_DEFINITION.version);assert.match(run.inputFingerprint,/^[a-f0-9]{64}$/);assert.match(run.costSnapshotFingerprint,/^[a-f0-9]{64}$/);assert.match(run.resultFingerprint,/^[a-f0-9]{64}$/);
 const changed=await runAgent(value,[{...costs[0],lastPurchasePrice:200}],{modelOverride:new ScriptModel(),audit:{store}});assert.notEqual(store.getRun(changed.runId).costSnapshotFingerprint,run.costSnapshotFingerprint);assert.notEqual(store.getRun(changed.runId).resultFingerprint,run.resultFingerprint);
 assert.throws(()=>store.finishRun(result.runId,{status:'failed'}));assert.throws(()=>store.appendEvent(result.runId,{tool:'runtime',state:'done'}));
 assert.throws(()=>store.registerAgent({...RFQ_AGENT_DEFINITION,promptSha256:'a'.repeat(64)}));
 let failedId;try{await runAgent(value,costs,{modelOverride:new ScriptModel({fail:true}),audit:{store}});}catch(e){failedId=e.auditRunId;assert.ok(!e.message.includes(secret));}
 assert.equal(store.getRun(failedId).status,'failed');assert.equal(store.getRun(failedId).error.code,'model_or_tool_failed');
 const controller=new AbortController();let cancelId;try{await runAgent(value,costs,{modelOverride:new ScriptModel({cancel:controller}),signal:controller.signal,audit:{store}});}catch(e){cancelId=e.auditRunId;}
 assert.equal(store.getRun(cancelId).status,'cancelled');
 let invalidId;try{await runAgent({...value,lines:[]},costs,{modelOverride:new ScriptModel(),audit:{store}});}catch(e){invalidId=e.auditRunId;}assert.equal(store.getRun(invalidId).error.code,'invalid_input');
 const orphan=store.startRun({...RFQ_AGENT_DEFINITION,actorId:'local-user',model:'test',input:{instruction:secret,lineCount:1}});store.appendEvent(orphan,{tool:'read_inquiry',state:'started',argumentsSummary:{apiKey:secret,reasoning:secret,mode:'analysis'},resultSummary:{content:secret}});
 store.close();store=await openAgentAuditStore({filePath});assert.equal(store.getRun(result.runId).events.length,6);assert.equal(store.recoverInterrupted(),1);assert.equal(store.getRun(orphan).error.code,'interrupted');
 const serialized=JSON.stringify(store.listRuns().map(r=>store.getRun(r.runId)));assert.ok(!serialized.includes(secret));assert.ok(!readFileSync(filePath).includes(Buffer.from(secret)));store.close();
 // Verify append-only guarantees are enforced by SQLite, not only JS methods.
 const SQL=await initSqlJs();const db=new SQL.Database(readFileSync(filePath));assert.throws(()=>db.run('UPDATE agent_events SET state=\'failed\''));assert.throws(()=>db.run('DELETE FROM agent_events'));assert.throws(()=>db.run('DELETE FROM agent_runs'));db.close();
 console.log('PASS: registration immutability, append-only SQL triggers, actual createAgent tool audit, reopen persistence, actor/inquiry/version/time linkage, failures/cancellation/invalid input/interruption, secret and reasoning non-retention');
}finally{rmSync(dir,{recursive:true,force:true});}
