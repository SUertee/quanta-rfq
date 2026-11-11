/** Single-process local audit ledger. No prompts, credentials or raw model/tool text. */
import initSqlJs from 'sql.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const id = value => { if(typeof value!=='string'||!/^[\p{L}\p{N}_.:-]{1,160}$/u.test(value)||/(bearer|api.?key|reasoning|sk-)/i.test(value)) throw new Error('invalid audit identifier');return value; };
const stats = value => Object.fromEntries(Object.entries(value||{}).filter(([k,v])=>['lineCount','historyCount','costCount','pricedCount','issueCount','mode','hasPolicy'].includes(k) && (typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'||k==='mode'&&['analysis','draft'].includes(v))));
const now=()=>new Date().toISOString();
export function createAgentAuditStore(db,persist) {
 db.run(`PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS agent_registry(agent_id TEXT NOT NULL,version TEXT NOT NULL,prompt_sha256 TEXT NOT NULL,tools_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,version));
 CREATE TABLE IF NOT EXISTS agent_runs(run_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,version TEXT NOT NULL,actor_id TEXT NOT NULL,inquiry_id TEXT,status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),model TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,duration_ms INTEGER,error_code TEXT,input_summary TEXT NOT NULL,result_summary TEXT,FOREIGN KEY(agent_id,version) REFERENCES agent_registry(agent_id,version));
 CREATE TABLE IF NOT EXISTS agent_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,sequence INTEGER NOT NULL,tool TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('started','done','failed','cancelled','blocked')),created_at TEXT NOT NULL,duration_ms INTEGER,arguments_summary TEXT NOT NULL,result_summary TEXT NOT NULL,UNIQUE(run_id,sequence),FOREIGN KEY(run_id) REFERENCES agent_runs(run_id));
 CREATE TRIGGER IF NOT EXISTS agent_events_no_update BEFORE UPDATE ON agent_events BEGIN SELECT RAISE(ABORT,'audit events are append-only'); END;
 CREATE TRIGGER IF NOT EXISTS agent_events_no_delete BEFORE DELETE ON agent_events BEGIN SELECT RAISE(ABORT,'audit events are append-only'); END;
 CREATE TRIGGER IF NOT EXISTS agent_registry_no_update BEFORE UPDATE ON agent_registry BEGIN SELECT RAISE(ABORT,'agent versions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_registry_no_delete BEFORE DELETE ON agent_registry BEGIN SELECT RAISE(ABORT,'agent versions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_runs_no_delete BEFORE DELETE ON agent_runs BEGIN SELECT RAISE(ABORT,'run history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_runs_terminal BEFORE UPDATE ON agent_runs WHEN OLD.status!='running' BEGIN SELECT RAISE(ABORT,'terminal run is immutable'); END;`);
 for(const name of ['input_fingerprint','cost_snapshot_fingerprint','result_fingerprint']) { if(!db.exec('PRAGMA table_info(agent_runs)')[0].values.some(row=>row[1]===name)) db.run(`ALTER TABLE agent_runs ADD COLUMN ${name} TEXT`); }
 if (!db.exec('PRAGMA table_info(agent_runs)')[0].values.some(row=>row[1]==='resource_snapshot')) db.run("ALTER TABLE agent_runs ADD COLUMN resource_snapshot TEXT NOT NULL DEFAULT '{}' ");
 function query(sql,args=[]){const stmt=db.prepare(sql);try{stmt.bind(args);const rows=[];while(stmt.step())rows.push(stmt.getAsObject());return rows;}finally{stmt.free();}}
 function write(fn){db.run('BEGIN');try{const result=fn();db.run('COMMIT');persist();return result;}catch(e){try{db.run('ROLLBACK');}catch{}throw e;}}
 const publicRun=r=>r?{runId:r.run_id,agentId:r.agent_id,version:r.version,actorId:r.actor_id,inquiryId:r.inquiry_id,status:r.status,model:r.model,startedAt:r.started_at,finishedAt:r.finished_at,durationMs:r.duration_ms,error:r.error_code?{code:r.error_code}:null,input:JSON.parse(r.input_summary),result:r.result_summary?JSON.parse(r.result_summary):null,inputFingerprint:r.input_fingerprint,costSnapshotFingerprint:r.cost_snapshot_fingerprint,resultFingerprint:r.result_fingerprint,resources:JSON.parse(r.resource_snapshot)}:null;
 const store={
 registerAgent({agentId,version,promptSha256,tools}){id(agentId);id(version);if(!/^[a-f0-9]{64}$/.test(promptSha256)||!Array.isArray(tools))throw new Error('invalid agent registration');const toolJson=JSON.stringify(tools.map(id));const old=query('SELECT * FROM agent_registry WHERE agent_id=? AND version=?',[agentId,version])[0];if(old){if(old.prompt_sha256!==promptSha256||old.tools_json!==toolJson)throw new Error('agent version conflict');return;}write(()=>db.run('INSERT INTO agent_registry VALUES(?,?,?,?,?)',[agentId,version,promptSha256,toolJson,now()]));},
 listAgents(){return query('SELECT * FROM agent_registry ORDER BY agent_id,version').map(r=>({agentId:r.agent_id,version:r.version,promptSha256:r.prompt_sha256,tools:JSON.parse(r.tools_json),createdAt:r.created_at}));},
 startRun({agentId,version,actorId='local-user',inquiryId=null,model='unconfigured',input={},inputFingerprint=null,costSnapshotFingerprint=null,resources={}}){[agentId,version,actorId,model].forEach(id);for(const hash of [inputFingerprint,costSnapshotFingerprint])if(hash!==null&&!/^[a-f0-9]{64}$/.test(hash))throw new Error('invalid fingerprint');if(inquiryId!==null)id(inquiryId);const runId=randomUUID();write(()=>db.run('INSERT INTO agent_runs(run_id,agent_id,version,actor_id,inquiry_id,status,model,started_at,input_summary,input_fingerprint,cost_snapshot_fingerprint,resource_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[runId,agentId,version,actorId,inquiryId,'running',model,now(),JSON.stringify(stats(input)),inputFingerprint,costSnapshotFingerprint,JSON.stringify(resources)]));return runId;},
 appendEvent(runId,{tool,state,argumentsSummary={},resultSummary={},durationMs=0}){id(runId);id(tool);if(!['started','done','failed','cancelled','blocked'].includes(state))throw new Error('invalid event state');return write(()=>{const run=query('SELECT status FROM agent_runs WHERE run_id=?',[runId])[0];if(!run||run.status!=='running')throw new Error('run is not active');const sequence=query('SELECT COALESCE(MAX(sequence),0)+1 n FROM agent_events WHERE run_id=?',[runId])[0].n;const eventId=randomUUID();db.run('INSERT INTO agent_events VALUES(?,?,?,?,?,?,?,?,?)',[eventId,runId,sequence,tool,state,now(),Math.max(0,Math.round(Number(durationMs)||0)),JSON.stringify(stats(argumentsSummary)),JSON.stringify(stats(resultSummary))]);return eventId;});},
 finishRun(runId,{status,errorCode=null,result={},resultFingerprint=null}){if(resultFingerprint!==null&&!/^[a-f0-9]{64}$/.test(resultFingerprint))throw new Error('invalid fingerprint');if(!['completed','failed','cancelled'].includes(status))throw new Error('invalid terminal state');if(errorCode&&!['invalid_input','model_or_tool_failed','cancelled','interrupted'].includes(errorCode))throw new Error('invalid error code');write(()=>{const r=query('SELECT * FROM agent_runs WHERE run_id=?',[id(runId)])[0];if(!r||r.status!=='running')throw new Error('run is not active');db.run('UPDATE agent_runs SET status=?,finished_at=?,duration_ms=?,error_code=?,result_summary=?,result_fingerprint=? WHERE run_id=?',[status,now(),Math.max(0,Date.now()-Date.parse(r.started_at)),errorCode,JSON.stringify(stats(result)),resultFingerprint,runId]);});},
 getRun(runId){const run=publicRun(query('SELECT * FROM agent_runs WHERE run_id=?',[id(runId)])[0]);return run?{...run,events:store.getEvents(runId)}:null;},
 listRuns({inquiryId=null,limit=30,actorId=null}={}){
  const conditions=[],params=[];
  if(inquiryId!==null){id(inquiryId);conditions.push('inquiry_id=?');params.push(inquiryId);}
  if(actorId!==null){id(actorId);conditions.push('actor_id=?');params.push(actorId);}
  limit=Math.max(1,Math.min(100,Number(limit)||30));params.push(limit);
  return query('SELECT * FROM agent_runs'+(conditions.length?' WHERE '+conditions.join(' AND '):'')+' ORDER BY started_at DESC LIMIT ?',params).map(publicRun);
 },
 getEvents(runId){return query('SELECT * FROM agent_events WHERE run_id=? ORDER BY sequence',[id(runId)]).map(r=>({eventId:r.event_id,runId:r.run_id,sequence:r.sequence,tool:r.tool,state:r.state,createdAt:r.created_at,durationMs:r.duration_ms,arguments:JSON.parse(r.arguments_summary),result:JSON.parse(r.result_summary),detail:`${r.tool} · ${r.state}`}));},
 recoverInterrupted(){const runs=query("SELECT run_id FROM agent_runs WHERE status='running'");for(const r of runs){store.appendEvent(r.run_id,{tool:'runtime',state:'failed'});store.finishRun(r.run_id,{status:'failed',errorCode:'interrupted'});}return runs.length;},
 close(){db.close();}
 };persist();return store;
}

// Isolated file helper for tests and local migration; production injects its existing DB.
export async function openAgentAuditStore({filePath}) {
 const SQL=await initSqlJs();const db=existsSync(filePath)?new SQL.Database(readFileSync(filePath)):new SQL.Database();
 const persist=()=>{mkdirSync(dirname(filePath),{recursive:true});const tmp=filePath+'.tmp';writeFileSync(tmp,Buffer.from(db.export()),{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,filePath);};
 return createAgentAuditStore(db,persist);
}
