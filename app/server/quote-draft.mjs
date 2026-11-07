import {canonicalJson} from '../shared/quote-state.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {rows} from './intake.mjs';
import {businessToday,RFQ_RULE_VERSION} from '../shared/rfq-rules.mjs';

const money=z.number().finite().nonnegative().max(1e12);
const policySchema=z.object({
  margin:z.number().min(0).max(2),marginFloor:z.number().min(0).lt(1),orderCapCny:money,marketPremium:z.number().min(0).max(10),
  freightChargeCny:money,freightCostCny:money,freightDays:z.number().min(0).max(3650),industryKw:z.string().max(200),condFnNe:z.boolean(),certMutual:z.boolean(),
  fxUsd:z.number().positive().finite().optional(),fxEur:z.number().positive().finite().optional(),fxRates:z.record(z.string().max(12),z.number().positive().finite()).optional(),fxSource:z.string().max(1000).optional(),
  freightAlloc:z.enum(['order','byLine','byValue']),aogPremium:z.number().min(0).max(2),bulkDiscount:z.number().min(0).max(1),bulkQty:z.number().nonnegative().finite(),minFreightCny:money,freeFreightOverCny:money,
}).strict();
const costSchema=z.object({value:money.positive(),source:z.enum(['ai','manual']),basis:z.string().max(8000).optional(),refs:z.array(z.object({title:z.string().max(1000),url:z.string().max(2000)})).max(50).optional(),verdict:z.enum(['有市场依据','有间接参考','纯经验估算']).optional(),limitation:z.string().max(4000).optional(),trace:z.array(z.object({query:z.string().max(1000),hits:z.number().nonnegative()})).max(50).optional()}).strict();
const lineSchema=z.object({key:z.string().max(200),price:money.positive().nullable(),manual:z.boolean(),reviewed:z.boolean(),skipped:z.boolean(),manualCost:costSchema.nullable()}).strict();
const saveSchema=z.object({requestId:z.string().uuid(),version:z.number().int().nonnegative(),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),operator:z.string().trim().min(1).max(100),policy:policySchema,lines:z.array(lineSchema).max(150)}).strict();
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};

export function quoteSourceFingerprint(inquiry){
  return hash({ruleVersion:RFQ_RULE_VERSION,asOf:businessToday(),status:inquiry.status,issues:inquiry.issues,files:inquiry.files?.map(file=>({id:file.id,status:file.status,sha256:file.sha256})),lines:inquiry.lines.map(line=>({id:line.id,version:line.version,fields:Object.fromEntries(Object.entries(line).filter(([key])=>key!=='evidence')),evidence:line.evidence?.map(entry=>({id:entry.id,source:entry.source,matchedAt:entry.matched_at,snapshot:entry.snapshot}))}))});
}

export function createQuoteDraftStore(db,persist,getInquiry){
  db.run(`CREATE TABLE IF NOT EXISTS quote_draft(inquiry_id TEXT PRIMARY KEY REFERENCES inquiry(id) ON DELETE CASCADE,version INTEGER NOT NULL,source_fingerprint TEXT NOT NULL,content TEXT NOT NULL,operator TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quote_draft_revision(inquiry_id TEXT NOT NULL REFERENCES inquiry(id) ON DELETE CASCADE,version INTEGER NOT NULL,source_fingerprint TEXT NOT NULL,content TEXT NOT NULL,operator TEXT NOT NULL,created_at TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(inquiry_id,version),UNIQUE(inquiry_id,request_id));`);
  const stored=id=>rows(db,'SELECT * FROM quote_draft WHERE inquiry_id=?',[id])[0];
  const inquiryOf=id=>{const inquiry=getInquiry(id);if(!inquiry)fail(404,'询价不存在');return inquiry;};
  function read(id){
    const inquiry=inquiryOf(id),record=stored(id),sourceFingerprint=quoteSourceFingerprint(inquiry);
    if(!record)return {version:0,sourceFingerprint,state:null,stale:false};
    const state=JSON.parse(record.content),stale=record.source_fingerprint!==sourceFingerprint;
    if(stale){
      const previous=new Map(state.lines.map(line=>[line.key,line]));
      state.lines=inquiry.lines.map(line=>({key:`intake-${id}-${line.lineNo}`,price:null,manual:false,reviewed:false,skipped:previous.get(`intake-${id}-${line.lineNo}`)?.skipped||false,manualCost:null}));
    }
    return {version:record.version,sourceFingerprint,state,stale,operator:record.operator,updatedAt:record.updated_at};
  }
  function save(id,value){
    const parsed=saveSchema.safeParse(value);if(!parsed.success)fail(400,'报价审核数据无效');
    const body=parsed.data,inquiry=inquiryOf(id),before=stored(id),fingerprint=quoteSourceFingerprint(inquiry);
    const duplicate=rows(db,'SELECT * FROM quote_draft_revision WHERE inquiry_id=? AND request_id=?',[id,body.requestId])[0];
    if(duplicate){
      if(duplicate.request_hash!==hash(body)||duplicate.version!==before?.version||fingerprint!==duplicate.source_fingerprint)fail(409,'该保存请求已处理，询价版本已变化，请载入最新版本');
      return {...read(id),reviewInvalidated:false};
    }
    if(body.version!==(before?.version||0))fail(409,'此询价已在其他窗口更新，请载入最新版本后继续');
    if(body.sourceFingerprint!==fingerprint)fail(409,'物料或报价依据已变化，请刷新后重新核对');
    const keys=new Set(inquiry.lines.map(line=>`intake-${id}-${line.lineNo}`));
    if(body.lines.length!==keys.size||new Set(body.lines.map(line=>line.key)).size!==keys.size||body.lines.some(line=>!keys.has(line.key)))fail(409,'报价行与询价不一致，请刷新');
    const prior=before?JSON.parse(before.content):null;
    const policyChanged=prior&&hash(prior.policy)!==hash(body.policy);
    const sourceChanged=before&&before.source_fingerprint!==fingerprint;
    const oldLines=new Map(prior?.lines.map(line=>[line.key,line])||[]);
    let invalidated=false;
    const lines=body.lines.map(line=>{
      const old=oldLines.get(line.key);
      const changed=old&&(old.price!==line.price||old.skipped!==line.skipped||hash(old.manualCost)!==hash(line.manualCost));
      if(line.reviewed&&(policyChanged||sourceChanged||changed)){invalidated=true;return {...line,reviewed:false};}
      return line;
    });
    const state={policy:body.policy,lines},content=JSON.stringify(state),version=body.version+1,now=new Date().toISOString();
    db.run('BEGIN');
    try{
      db.run('INSERT INTO quote_draft VALUES(?,?,?,?,?,?) ON CONFLICT(inquiry_id) DO UPDATE SET version=excluded.version,source_fingerprint=excluded.source_fingerprint,content=excluded.content,operator=excluded.operator,updated_at=excluded.updated_at',[id,version,fingerprint,content,body.operator,now]);
      db.run('INSERT INTO quote_draft_revision VALUES(?,?,?,?,?,?,?,?)',[id,version,fingerprint,content,body.operator,now,body.requestId,hash(body)]);
      db.run('COMMIT');
    }catch(error){db.run('ROLLBACK');throw error;}
    try{persist();}catch(error){
      db.run('DELETE FROM quote_draft_revision WHERE inquiry_id=? AND version=?',[id,version]);
      if(before)db.run('UPDATE quote_draft SET version=?,source_fingerprint=?,content=?,operator=?,updated_at=? WHERE inquiry_id=?',[before.version,before.source_fingerprint,before.content,before.operator,before.updated_at,id]);
      else db.run('DELETE FROM quote_draft WHERE inquiry_id=?',[id]);
      throw error;
    }
    return {version,sourceFingerprint:fingerprint,state,stale:false,reviewInvalidated:invalidated,operator:body.operator,updatedAt:now};
  }
  return {read,save};
}

/** Exported prices and reviews must be the current saved draft, not posted browser flags. */
export function validateSavedQuote(receipt,saved){
  if(!saved.state||saved.stale||receipt.draftVersion!==saved.version)fail(409,'询价审核版本已变化，请载入最新版本后导出');
  let content;try{content=JSON.parse(receipt.content);}catch{fail(400,'报价内容无效');}
  if(content.draftVersion!==saved.version||hash(content.policy)!==hash(saved.state.policy))fail(409,'报价策略版本不一致，请重新核对');
  const expected=new Map(saved.state.lines.map(line=>[line.key,line]));
  if(content.lines?.length!==expected.size)fail(409,'报价行不一致');
  for(const line of content.lines){
    const draft=expected.get(line.key);
    if(!draft||line.price!==draft.price||line.reviewed!==draft.reviewed||line.skipped!==draft.skipped)fail(409,'价格或核对结果未保存，请重新核对');
  }
}
