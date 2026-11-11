import {chatCorrectionTools} from './chat-correction.mjs';
import {createResourceCorrectionStore} from './resource-correction.mjs';
import {createExtractionReview} from './extraction-review.mjs';
import {readSchema,writeSchema} from './field-schema-store.mjs';
import {createAccountStore} from './accounts.mjs';
import {MCP_MANIFEST, callMcpTool} from './mcp-tools.mjs';
import {certificatesFor, condAliasesFor} from '../shared/field-schema.mjs';
import {createSupplierImportStore} from './supplier-import.mjs';
import {createQuoteDraftStore,validateSavedQuote} from './quote-draft.mjs';
import {matchResources} from '../shared/rfq-rules.mjs';
import {resolveChatReferences,referenceContext} from './chat-references.mjs';
import { normalizePartNumber,normalizeUnit } from "./normalization.mjs";
import {readChatFiles} from './chat-files.mjs';
import {platformChat} from './platform-chat.mjs';
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('RFQ 后端需要 Node.js 22 或以上版本；当前为 ' + process.versions.node + '。请切换 Node 22 后运行 npm run server。');
  process.exit(1);
}
const { runAgent, validateAgentInput, RFQ_AGENT_DEFINITION } = await import('./agent.mjs');
// 库存后端：Node + sql.js（WASM SQLite，免编译）。库存数据落 server/inventory.sqlite。
// 设计：核心字段为真实 SQL 列（可 SQL 管理），自定义字段进 extra(JSON)——字段不锁死。
// 自定义字段 SQL 查询示例：SELECT partNumber, json_extract(extra,'$.供应商等级') FROM inventory;
import initSqlJs from 'sql.js';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import {initIntake,seedPrices,createIntakeService,recoverInterruptedIntakes} from './intake.mjs';
import {getRuntimeConfig} from './runtime-config.mjs';
import {createAgentAuditStore} from './agent-audit-store.mjs';
import {resolveAgentScope} from './agent-scope.mjs';
import {validateQuoteReceipt} from './quote-receipt.mjs';
import { fileURLToPath } from 'node:url';
import { parseSheet } from './xlsx.mjs';
import { parsePdf } from './pdf.mjs';

const DB_PATH = process.env.RFQ_DB_PATH || fileURLToPath(new URL('./inventory.sqlite', import.meta.url));
if(existsSync(DB_PATH) && !existsSync(DB_PATH+'.pre-intake.bak')) copyFileSync(DB_PATH,DB_PATH+'.pre-intake.bak');
const SEED_PATH = fileURLToPath(new URL('../public/data/cost.json', import.meta.url));
const PORT = Number(process.env.RFQ_PORT || 3004);
const requireLogin = ['1','true'].includes(process.env.RFQ_REQUIRE_LOGIN||'');
const allowedOrigins=new Set(['http://127.0.0.1:5176','http://localhost:5176',...(process.env.RFQ_ALLOWED_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean)]);

const CORE = [
  'partNumber', 'description', 'productScope', 'uom', 'stockQty',
  'warehouse', 'stockCondition', 'stdCost', 'avgCost', 'lastPurchasePrice',
  'currency', 'lastPurchaseDate', 'preferredSupplier', 'costUpdateDate',
];
const NUMERIC = new Set(['stockQty', 'stdCost', 'avgCost', 'lastPurchasePrice']);

const SQL = await initSqlJs();
const db = existsSync(DB_PATH) ? new SQL.Database(readFileSync(DB_PATH)) : new SQL.Database();
db.run(`CREATE TABLE IF NOT EXISTS inventory (
  partNumber TEXT PRIMARY KEY,
  description TEXT DEFAULT '', productScope TEXT DEFAULT '', uom TEXT DEFAULT '',
  stockQty REAL, warehouse TEXT DEFAULT '', stockCondition TEXT DEFAULT '',
  stdCost REAL, avgCost REAL, lastPurchasePrice REAL, currency TEXT DEFAULT 'CNY',
  lastPurchaseDate TEXT DEFAULT '', preferredSupplier TEXT DEFAULT '', costUpdateDate TEXT DEFAULT '',
  extra TEXT DEFAULT '{}'
)`);
db.run(`CREATE TABLE IF NOT EXISTS unit_conv (
  pn TEXT NOT NULL, uom TEXT NOT NULL, factor REAL NOT NULL,
  PRIMARY KEY (pn, uom)
)`);
db.run(`CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT DEFAULT '', pn TEXT DEFAULT '', action TEXT DEFAULT '',
  detail TEXT DEFAULT '', operator TEXT DEFAULT '', created_at TEXT DEFAULT ''
)`);
db.run(`CREATE TABLE IF NOT EXISTS field_schema (
  account_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS quote_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT DEFAULT '', kind TEXT DEFAULT '', total REAL DEFAULT 0,
  content TEXT DEFAULT '', operator TEXT DEFAULT '', created_at TEXT DEFAULT ''
)`);

if(db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='rfq_batch'").length && !existsSync(DB_PATH+'.pre-names.bak'))copyFileSync(DB_PATH,DB_PATH+'.pre-names.bak');
for(const [name,type] of [['inquiry_id','TEXT'],['content_sha256','TEXT']]){
 if(!db.exec('PRAGMA table_info(quote_snapshot)')[0].values.some(row=>row[1]===name))db.run(`ALTER TABLE quote_snapshot ADD COLUMN ${name} ${type}`);
}
initIntake(db);
// 多账户：accounts-v1 迁移（加列/重建 field_schema/种子 admin/回填存量），须先于服务工厂创建
const accounts=createAccountStore(db,persist,{dbPath:DB_PATH});
// Legacy records receive ownership before any account-scoped API can read them.
db.run('BEGIN');
try {
  for (const table of ['review_log', 'quote_snapshot']) {
    const columns = db.exec(`PRAGMA table_info(${table})`)[0].values.map(row => row[1]);
    if (!columns.includes('account_id')) db.run(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`);
    if (table === 'review_log' && !columns.includes('inquiry_id')) {
      db.run('ALTER TABLE review_log ADD COLUMN inquiry_id TEXT');
      db.run('UPDATE review_log SET inquiry_id=task WHERE task IN (SELECT id FROM inquiry)');
    }
    db.run(`UPDATE ${table} SET account_id=COALESCE((SELECT owner_id FROM inquiry WHERE inquiry.id=${table}.inquiry_id),(SELECT id FROM account WHERE role='master' ORDER BY created_at LIMIT 1)) WHERE account_id IS NULL`);
  }
  db.run('COMMIT');
} catch (error) {
  db.run('ROLLBACK');
  throw error;
}

db.run('BEGIN');
try {
  for(const [table,primary] of [['inventory','account_id,partNumber'],['unit_conv','account_id,pn,uom']]) {
    const info=db.exec(`PRAGMA table_info(${table})`)[0].values;
    if(info.some(row=>row[1]==='account_id'&&row[5]))continue;
    const original=db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[table])[0].values[0][0];
    const columns=info.map(row=>`"${row[1]}"`).join(',');
    let create=original.replace(/CREATE TABLE[^()]+/i,`CREATE TABLE ${table}_scoped `);
    create=create.replace(/partNumber TEXT PRIMARY KEY/i,'partNumber TEXT NOT NULL').replace(/,?\s*PRIMARY KEY\s*\(pn, uom\)/i,'');
    create=create.replace(/\)\s*$/,`, PRIMARY KEY (${primary}))`);
    db.run(create);
    db.run(`INSERT INTO ${table}_scoped (${columns}) SELECT ${columns} FROM ${table}`);
    db.run(`DROP TABLE ${table}`);
    db.run(`ALTER TABLE ${table}_scoped RENAME TO ${table}`);
  }
  db.run('CREATE INDEX IF NOT EXISTS inventory_normalized_part ON inventory(normalized_part_number)');
  db.run('COMMIT');
} catch(error) {db.run('ROLLBACK');throw error;}
// 配置文件同步子账户/邮箱绑定（默认 app/config/accounts.json，可用 RFQ_ACCOUNTS_CONFIG 覆盖；文件无效只告警不阻断启动）
const ACCOUNTS_CONFIG=process.env.RFQ_ACCOUNTS_CONFIG||fileURLToPath(new URL('../config/accounts.json',import.meta.url));
if(existsSync(ACCOUNTS_CONFIG)){
  try{
    const sync=accounts.syncFromConfig(JSON.parse(readFileSync(ACCOUNTS_CONFIG,'utf8')));
    console.log(`[accounts] 配置同步：新建 ${sync.created.length} 个${sync.created.length?`（${sync.created.join('、')}）`:''}，更新 ${sync.updated.length} 个`);
  }catch(error){console.error(`[accounts] 配置文件无效，已跳过同步：${error.message}`);}
}
const masterAccountId=accounts.masterId();
const agentAudit=createAgentAuditStore(db,persist);
agentAudit.registerAgent(RFQ_AGENT_DEFINITION);
agentAudit.recoverInterrupted();
const priceSeedPath=fileURLToPath(new URL('../public/data/prices.json',import.meta.url));
seedPrices(db,existsSync(priceSeedPath)?JSON.parse(readFileSync(priceSeedPath,'utf8')):[]);
// 迁移之后才播种的数据同样归初始 master
for(const table of ['price_resource','inventory','unit_conv'])db.run(`UPDATE "${table}" SET account_id=? WHERE account_id IS NULL`,[masterAccountId]);
recoverInterruptedIntakes(db);
const runtime=getRuntimeConfig();
const schemaOf=scope=>readSchema(db,scope?.accountId);
const intake=createIntakeService(db,persist,{modelConfig:runtime.model,ocrConfig:runtime.ocr,getSchema:schemaOf});
const extractionReview=createExtractionReview(db,persist,id=>intake.detail(id));
const unitConversionsFor=accountId=>{
  const conversions={};
  const result=accountId?db.exec('SELECT pn,uom,factor FROM unit_conv WHERE account_id=?',[accountId]):db.exec('SELECT pn,uom,factor FROM unit_conv');
  for(const [pn,uom,factor] of result[0]?.values||[]){conversions[normalizePartNumber(pn)]??={};conversions[normalizePartNumber(pn)][normalizeUnit(uom)]=factor;}
  return conversions;
};
const quoteDrafts=createQuoteDraftStore(db,persist,id=>intake.detail(id),id=>unitConversionsFor(intake.ownerOf(id)||masterAccountId));
const supplierImports=createSupplierImportStore(db,persist,id=>intake.detail(id),{modelConfig:runtime.model,ocrConfig:runtime.ocr,getSchema:schemaOf});
persist();

// 首次启动：从演示成本表播种
const count = db.exec('SELECT COUNT(*) AS c FROM inventory')[0].values[0][0];
if (count === 0 && existsSync(SEED_PATH)) {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
  for (const r of seed) upsertRow(r, masterAccountId);
  persist();
  console.log(`[inventory] 播种 ${seed.length} 条`);
}

function persist() {
  writeFileSync(DB_PATH+'.tmp', Buffer.from(db.export()));
  renameSync(DB_PATH+'.tmp', DB_PATH);
}

function upsertRow(row, accountId) {
  row = {...row};
  delete row.account_id;
  delete row.accountId;
  // 库存按账号隔离：同标准件号的查重与更新都限定在目标账号内
  const matches = db.exec('SELECT partNumber FROM inventory WHERE normalized_part_number=? AND account_id=?', [normalizePartNumber(row.partNumber), accountId])[0]?.values || [];
  if (matches.length > 1) throw Object.assign(new Error('标准件号对应多条库存，请先处理重复资源'), {status:409});
  if (matches.length === 1) row = {...row,partNumber:matches[0][0]};
  const provided = {};
  const extra = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'partNumber' || v === undefined) continue;
    if (CORE.includes(k)) provided[k] = NUMERIC.has(k) ? (v === '' || v === null ? null : Number(v)) : String(v);
    else extra[k] = v;
  }
  const old = db.exec('SELECT extra FROM inventory WHERE partNumber = ? AND account_id=?', [row.partNumber, accountId]);
  if (old.length && old[0].values.length) {
    // 已存在：只更新提供的字段，自定义字段合并保留
    const oldExtra = JSON.parse(old[0].values[0][0] || '{}');
    const merged = { ...oldExtra, ...extra };
    const keys = Object.keys(provided);
    if (keys.length) {
      db.run(`UPDATE inventory SET ${keys.map((k) => `${k} = ?`).join(', ')}, extra = ? WHERE partNumber = ? AND account_id=?`,
        [...keys.map((k) => provided[k]), JSON.stringify(merged), row.partNumber, accountId]);
    } else {
      db.run('UPDATE inventory SET extra = ? WHERE partNumber = ? AND account_id=?', [JSON.stringify(merged), row.partNumber, accountId]);
    }
  } else {
    // 新建：缺省字段补默认值（空字段允许）
    const cols = { ...provided };
    for (const k of CORE) if (!(k in cols) && k !== 'partNumber') cols[k] = NUMERIC.has(k) ? null : '';
    db.run(`INSERT INTO inventory (${CORE.join(',')}, extra, account_id) VALUES (${CORE.map(() => '?').join(',')}, ?, ?)`, [
      row.partNumber,
      ...CORE.filter((c) => c !== 'partNumber').map((c) => cols[c]),
      JSON.stringify(extra),
      accountId,
    ]);
  }
  db.run("UPDATE inventory SET normalized_part_number=? WHERE partNumber=? AND account_id=?", [normalizePartNumber(row.partNumber), row.partNumber,accountId]);
}

function allRows(ctx) {
  const scoped = ctx && ctx.role !== 'master';
  const res = db.exec(
    `SELECT ${CORE.join(',')}, extra, account_id FROM inventory${scoped ? ' WHERE account_id=?' : ''} ORDER BY partNumber`,
    scoped ? [ctx.accountId] : [],
  );
  const customFields = new Set();
  const accountNames = new Map(accounts.listAccounts().map(account=>[account.id,account.displayName]));
  const cost = res.length
    ? res[0].values.map((v) => {
        const row = {};
        CORE.forEach((c, i) => { row[c] = v[i] ?? (NUMERIC.has(c) ? 0 : ''); });
        const extra = JSON.parse(v[v.length - 2] || '{}');
        Object.keys(extra).forEach((k) => customFields.add(k));
        row.extra = extra;
        row.account_id = v[v.length - 1];
        if(ctx?.role==='master')row.account_name=accountNames.get(row.account_id)||'';
        return row;
      })
    : [];
  return { cost, customFields: [...customFields] };
}

function readBody(req, limit = Infinity) {
  return new Promise((resolve, reject) => {
    let b = '', size = 0, failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; const error = new Error('request too large'); error.status = 413; reject(error); return; }
      b += c;
    });
    req.on('error', reject);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  const origin=req.headers.origin;
  if(origin&&!allowedOrigins.has(origin)){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'访问来源不被允许'}));return;}
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');
  // 鉴权：除登录/健康检查/静态资源（非 /api 路径）外，一律要求 Bearer 令牌
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  const isPublicApi = url.pathname === '/api/health' || (url.pathname === '/api/auth/session' && req.method === 'GET') || (url.pathname === '/api/auth/login' && req.method === 'POST');
  let ctx = null;
  if (isApi && !isPublicApi) {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim();
    const token = bearer || url.searchParams.get('token') || '';
    ctx = token ? accounts.authenticate(token) : null;
    if (!ctx) { res.writeHead(401); res.end(JSON.stringify({ error: '未登录或会话已过期' })); return; }
    ctx.token = token;
  }
  const needMaster = () => { if (ctx.role !== 'master') throw Object.assign(new Error('需要总账户权限'), { status: 403 }); };
  // 询价归属守卫：子账户可读自己+待认领池，写（改行/删除/改价/导出/恢复）仅限自己的单
  const guardInquiry = (id, write = false) => {
    const owner = intake.ownerOf(id);
    if (owner === undefined) throw Object.assign(new Error('询价不存在'), { status: 404 });
    if (ctx.role === 'master') return;
    if (write ? owner !== ctx.accountId : owner && owner !== ctx.accountId)
      throw Object.assign(new Error(write ? '无权操作他人询价' : '询价不存在'), { status: write ? 403 : 404 });
  };
  // 基础数据写入目标账号：master 可用 body.accountId 指定，子账户永远是自己
  const resolveTargetAccount = (accountId) => {
    if (ctx.role !== 'master' || !accountId) return ctx.accountId;
    if (!accounts.listAccounts().some((a) => a.id === accountId)) throw Object.assign(new Error('目标账户不存在'), { status: 400 });
    return accountId;
  };
  const legacyIntakeList=url.pathname==='/api/intake/batches';
  if(url.pathname.startsWith('/api/intake/batches'))url.pathname=url.pathname.replace('/api/intake/batches','/api/inquiries');
  if(url.pathname.startsWith('/api/intake/files'))url.pathname=url.pathname.replace('/api/intake/files','/api/files');
  const pnMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)$/);
  try {
    // —— 鉴权与账户管理 ——
    if(url.pathname==='/api/auth/session'&&req.method==='GET'){
      if(requireLogin){res.end(JSON.stringify({loginRequired:true}));return;}
      const token=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization||''))?.[1]?.trim();
      res.end(JSON.stringify({loginRequired:false,...accounts.workspaceSession(token)}));return;
    }
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
      const {username,password}=await readBody(req,50000);
      const result=accounts.verifyLogin(username,password);
      if(!result){res.writeHead(401);res.end(JSON.stringify({error:'用户名或密码不正确'}));return;}
      res.end(JSON.stringify(result));return;
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){accounts.logout(ctx.token);res.end(JSON.stringify({ok:true}));return;}
    if(url.pathname==='/api/model-config'&&req.method==='GET'){res.end(JSON.stringify({configured:!!runtime.model,model:runtime.model?.model||''}));return;}
    if(url.pathname==='/api/auth/me'&&req.method==='GET'){res.end(JSON.stringify(accounts.listAccounts().find(a=>a.id===ctx.accountId)||null));return;}
    if(url.pathname==='/api/auth/change-password'&&req.method==='POST'){
      const {oldPassword,newPassword}=await readBody(req,50000);
      accounts.changePassword(ctx.accountId,oldPassword,newPassword);
      res.end(JSON.stringify({ok:true}));return;
    }
    if(url.pathname==='/api/accounts'&&req.method==='GET'){needMaster();res.end(JSON.stringify({accounts:accounts.listAccounts()}));return;}
    if(url.pathname==='/api/accounts'&&req.method==='POST'){needMaster();res.end(JSON.stringify(accounts.createSubAccount(await readBody(req,50000))));return;}
    const accountPath=url.pathname.match(/^\/api\/accounts\/([^/]+)(\/reset-password|\/disabled|\/email-bindings)?$/);
    if(accountPath){
      const targetId=decodeURIComponent(accountPath[1]),action=accountPath[2]||'',self=targetId===ctx.accountId;
      if(!self)needMaster();
      if(action==='/reset-password'&&req.method==='POST'){needMaster();const {newPassword}=await readBody(req,50000);accounts.resetPassword(targetId,newPassword);res.end(JSON.stringify({ok:true}));return;}
      if(action==='/disabled'&&req.method==='POST'){
        needMaster();
        if(self)throw Object.assign(new Error('不能禁用当前登录账户'),{status:400});
        const body=await readBody(req,50000);
        accounts.setDisabled(targetId,!!body.disabled);
        res.end(JSON.stringify({ok:true}));return;
      }
      if(action==='/email-bindings'&&req.method==='GET'){res.end(JSON.stringify({bindings:accounts.getEmailBindings(targetId)}));return;}
      if(action==='/email-bindings'&&req.method==='PUT'){const body=await readBody(req,50000);const list=Array.isArray(body)?body:body?.bindings;res.end(JSON.stringify({bindings:accounts.setEmailBindings(targetId,list)}));return;}
      throw Object.assign(new Error('无效账户操作'),{status:400});
    }
    // —— 询价认领/指派 ——
    const claimPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/claim$/);
    if(claimPath&&req.method==='POST'){
      const id=decodeURIComponent(claimPath[1]);
      const owner=intake.ownerOf(id);
      if(owner===undefined)throw Object.assign(new Error('询价不存在'),{status:404});
      intake.setOwner(id,ctx.accountId,{claim:true});
      res.end(JSON.stringify(intake.detail(id,ctx)));return;
    }
    const assignPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/assign$/);
    if(assignPath&&req.method==='POST'){
      needMaster();
      const id=decodeURIComponent(assignPath[1]);
      if(intake.ownerOf(id)===undefined)throw Object.assign(new Error('询价不存在'),{status:404});
      const {ownerId}=await readBody(req,50000);
      const target=accounts.listAccounts().find(a=>a.id===ownerId&&!a.disabled);
      if(!target)throw Object.assign(new Error('目标账户不存在或已禁用'),{status:400});
      intake.setOwner(id,ownerId);
      res.end(JSON.stringify(intake.detail(id,ctx)));return;
    }
    const correctionPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/evidence\/([^/]+)\/correction$/);
    if(correctionPath&&['GET','POST'].includes(req.method)){
      const [,inquiryId,evidenceId]=correctionPath;
      guardInquiry(inquiryId,true);
      const corrections=createResourceCorrectionStore(db,persist,intake);
      const result=req.method==='GET'?corrections.read(inquiryId,evidenceId,ctx):corrections.save(inquiryId,evidenceId,await readBody(req,50000),ctx);
      res.end(JSON.stringify(result));return;
    }
    const supplierPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/supplier-imports(?:\/([^/]+))?(\/(?:confirm|retry))?$/);
    if(supplierPath){
      const [,inquiryId,importId,operation]=supplierPath;
      if(req.method==='GET'){guardInquiry(inquiryId);res.end(JSON.stringify(importId?supplierImports.read(inquiryId,importId):{imports:supplierImports.list(inquiryId)}));return;}
      if(req.method==='POST'){
        guardInquiry(inquiryId,true);
        let result;
        if(importId&&operation==='/retry') {
          result=await supplierImports.retry(inquiryId,importId,await readBody(req,50000));
        } else if(importId&&operation==='/confirm') {
          result=supplierImports.confirm(inquiryId,importId,await readBody(req,1_000_000));
        } else if(!importId) {
          result=await supplierImports.create(inquiryId,await readBody(req,12_100_000));
        }
        if(!result)throw Object.assign(new Error('无效报价导入操作'),{status:400});
        res.end(JSON.stringify(result));return;
      }
    }
    const recoveryPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/recovery$/);
    if(recoveryPath&&req.method==='GET'){guardInquiry(recoveryPath[1]);res.end(JSON.stringify(intake.recovery(recoveryPath[1],ctx)));return;}
    if(recoveryPath&&req.method==='POST'){guardInquiry(recoveryPath[1],true);res.end(JSON.stringify(await intake.recover(recoveryPath[1],await readBody(req,50000),{background:true},ctx)));return;}
    const extractionReviewPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/extraction-review$/);
    if(extractionReviewPath&&req.method==='GET'){guardInquiry(extractionReviewPath[1]);res.end(JSON.stringify(extractionReview.read(extractionReviewPath[1])));return;}
    if(extractionReviewPath&&req.method==='POST'){guardInquiry(extractionReviewPath[1],true);res.end(JSON.stringify(extractionReview.confirm(extractionReviewPath[1],await readBody(req,50000))));return;}
    const quotePath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/quote$/);
    if(quotePath&&req.method==='GET'){guardInquiry(quotePath[1]);res.end(JSON.stringify(quoteDrafts.read(quotePath[1])));return;}
    if(quotePath&&req.method==='PUT'){guardInquiry(quotePath[1],true);res.end(JSON.stringify(quoteDrafts.save(quotePath[1],await readBody(req,1_000_000))));return;}
    const addLinePath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/lines$/);
    if(addLinePath&&req.method==='POST'){res.end(JSON.stringify(intake.addLine(addLinePath[1],await readBody(req,50000),ctx)));return;}
    const linePath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/lines\/([^/]+)$/);
    if(linePath&&req.method==='PATCH'){res.end(JSON.stringify(intake.updateLine(linePath[1],linePath[2],await readBody(req,50000),ctx)));return;}
    if(url.pathname==='/api/inquiries' && req.method==='POST'){
      const input = await readBody(req, 36_000_000);
      if (req.headers.accept?.includes('application/x-ndjson')) {
        let streaming = false;
        const write = event => {
          if (res.destroyed) return;
          if (!streaming) {
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('X-Accel-Buffering', 'no');
            streaming = true;
          }
          res.write(JSON.stringify(event) + '\n');
        };
        try {
          const result = await intake.create(input, (stage, batch) => write({type:'progress', stage, batch}), ctx);
          write({type:'done', result});
        } catch (error) {
          if (!streaming) throw error;
          write({type:'error', error:error.message});
        }
        res.end();
      } else {
        res.end(JSON.stringify(await intake.create(input, undefined, ctx)));
      }
      return;
    }
    if(url.pathname==='/api/inquiries' && req.method==='GET'){res.end(JSON.stringify({[legacyIntakeList?'batches':'inquiries']:intake.list(Object.fromEntries(url.searchParams),ctx)}));return;}
    if(url.pathname==='/api/price-resources' && req.method==='GET'){res.end(JSON.stringify({prices:intake.prices(ctx)}));return;}
    if(url.pathname==='/api/price-resources' && req.method==='POST'){
      const { row, accountId } = await readBody(req, 200000);
      if (!row?.partNumber || !row?.id) { res.writeHead(400); res.end(JSON.stringify({error:'partNumber 与 id 必填'})); return; }
      const targetAccount=resolveTargetAccount(accountId);
      const holder=db.exec('SELECT account_id FROM price_resource WHERE id=?',[String(row.id)])[0]?.values?.[0]?.[0];
      if(holder!==undefined&&holder!==targetAccount){res.writeHead(403);res.end(JSON.stringify({error:'该价格资源属于其他账户，无权修改'}));return;}
      db.run('INSERT OR REPLACE INTO price_resource(id,part_number,data,source,updated_at,normalized_part_number,account_id) VALUES(?,?,?,?,?,?,?)',
        [String(row.id), String(row.partNumber), JSON.stringify(row), row.source || 'supplier_price', new Date().toISOString(), normalizePartNumber(row.partNumber), targetAccount]);
      persist();
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const priceMatch = url.pathname.match(/^\/api\/price-resources\/([^/]+)$/);
    if (priceMatch && req.method === 'DELETE') {
      if(ctx.role==='master')db.run('DELETE FROM price_resource WHERE id = ?', [decodeURIComponent(priceMatch[1])]);
      else db.run('DELETE FROM price_resource WHERE id = ? AND account_id = ?', [decodeURIComponent(priceMatch[1]), ctx.accountId]);
      persist();
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const batchPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)(\/evidence)?$/);
    if(batchPath && (req.method==='GET'||(req.method==='POST'&&batchPath[2]))){if(batchPath[2])guardInquiry(batchPath[1],true);const result=batchPath[2]?intake.refresh(batchPath[1],ctx):intake.detail(batchPath[1],ctx);if(!result)res.writeHead(404);res.end(JSON.stringify(result||{error:'批次不存在'}));return;}
    const rawPath = url.pathname.match(/^\/api\/files\/([^/]+)\/(raw|preview)$/);
    if (rawPath && req.method === 'GET') {
      const fileOwner=db.exec('SELECT i.owner_id FROM file f JOIN inquiry i ON i.id=f.inquiry_id WHERE f.id=?',[rawPath[1]])[0]?.values?.[0]?.[0];
      if(ctx.role!=='master'&&fileOwner&&fileOwner!==ctx.accountId){res.writeHead(404);res.end(JSON.stringify({error:'文件不存在'}));return;}
      const file = intake.rawFile(rawPath[1]);
      if (!file) { res.writeHead(404); res.end(JSON.stringify({ error: '文件不存在' })); return; }
      const inline = rawPath[2] === 'preview';
      const extension = file.name.split('.').pop().toLowerCase();
      const previewTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
      res.setHeader('Content-Type', inline ? previewTypes[extension] || 'text/plain; charset=utf-8' : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', inline && extension === 'pdf' ? "frame-ancestors 'self'" : "default-src 'none'; frame-ancestors 'self'; sandbox");
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      res.end(Buffer.from(file.raw));
      return;
    }
    if(req.method==='GET'&&url.pathname==='/api/agents'){res.end(JSON.stringify({agents:agentAudit.listAgents()}));return;}
    if(req.method==='POST'&&url.pathname==='/api/assistant/files'){res.end(JSON.stringify(await readChatFiles(await readBody(req,36_000_000))));return;}
    if(req.method==='POST'&&url.pathname==='/api/assistant/chat'){
      const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      const body=await readBody(req,100000),streaming=req.headers.accept?.includes('application/x-ndjson');
      const references=resolveChatReferences(body.references,id=>intake.detail(id,ctx),{inquiryId:body.inquiryId,quote:id=>quoteDrafts.read(id)});
      body.context=referenceContext(body.context,references);
      const referencedInquiries=new Set(references.filter(reference=>reference.inquiryId).map(reference=>reference.inquiryId));
      if(referencedInquiries.size===1)body.inquiryTitle=references.find(reference=>reference.inquiryId)?.inquiryTitle;
      const correction=chatCorrectionTools(references,createResourceCorrectionStore(db,persist,intake),ctx,guardInquiry);
      const chatOptions={signal:controller.signal,correction};
      if(!streaming){res.end(JSON.stringify(await platformChat(body,chatOptions)));return;}
      res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
      const write=event=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(event)+'\n');};
      try{const result=await platformChat(body,{...chatOptions,onDelta:text=>write({type:'delta',text})});write({type:'done',...result});}
      catch{write({type:'error',error:'回复中断或模型连接失败，请重试。'});}
      if(!res.writableEnded)res.end();return;
    }
    if(req.method==='GET'&&url.pathname==='/api/agent/runs'){res.end(JSON.stringify({runs:agentAudit.listRuns({inquiryId:url.searchParams.get('inquiryId'),limit:url.searchParams.get('limit')||30,actorId:ctx.role==='master'?null:ctx.accountId})}));return;}
    const auditPath=url.pathname.match(/^\/api\/agent\/runs\/([a-zA-Z0-9_.:-]+)$/);
    if(req.method==='GET'&&auditPath){const run=agentAudit.getRun(auditPath[1]);if(!run || (ctx.role!=='master' && run.actorId!==ctx.accountId)){res.writeHead(404);res.end(JSON.stringify({error:'运行记录不存在'}));return;}res.end(JSON.stringify(run));return;}
    if (req.method === 'POST' && url.pathname === '/api/agent/run') {
      const origin = req.headers.origin;
      if (Number(req.headers['content-length'] || 0) > 300000) { res.writeHead(413); res.end(JSON.stringify({error:'请求过大'})); return; }
      let input, inquiryId=null, resources={}, dataAccount=ctx.accountId;
      try {
        let body=await readBody(req,300000);
        if(body.inquiryId||body.batchId){
          guardInquiry(body.inquiryId||body.batchId);
          const inquiry=intake.detail(body.inquiryId||body.batchId);
          if(!inquiry)throw new Error('询价不存在');
          inquiryId=inquiry.id;
          const saved=quoteDrafts.read(inquiry.id);
          if(body.draftVersion!=null&&body.draftVersion!==saved.version){
            throw Object.assign(new Error('询价审核已在其他窗口更新，请载入最新版本'),{status:409});
          }
          if(saved.stale)throw Object.assign(new Error('询价依据已变化，请刷新并保存后重试'),{status:409});
          body=resolveAgentScope(body,inquiry,saved);
          const selectedKeys=new Set(body.lines.map(line=>line.key));
          resources=Object.fromEntries(inquiry.lines
            .filter(line=>selectedKeys.has(`intake-${inquiry.id}-${line.lineNo}`))
            .map(line=>[`intake-${inquiry.id}-${line.lineNo}`,line.evidence]));
        }
        body.context=referenceContext(body.context,resolveChatReferences(body.references,id=>intake.detail(id,ctx),{inquiryId,quote:id=>quoteDrafts.read(id)}));
        dataAccount=inquiryId?intake.ownerOf(inquiryId)||ctx.accountId:ctx.accountId;
        const unitConversions=unitConversionsFor(dataAccount);
        const schema=readSchema(db,dataAccount);
        body.policy={...body.policy,unitConversions,certificates:body.policy?.certificates??certificatesFor(schema),condAliases:body.policy?.condAliases??condAliasesFor(schema)};
        input = validateAgentInput(body);
        if(!inquiryId){const scope={role:'sub',accountId:dataAccount};const prices=intake.prices(scope),costs=allRows(scope).cost;resources=Object.fromEntries(input.lines.map(line=>[line.key,matchResources(line.partNumber,costs,prices)]));}
      }
      catch (error) { if (!res.destroyed && !res.writableEnded) { const pass=[409,403,404].includes(error?.status); if (!res.headersSent) res.writeHead(error?.status === 413 ? 413 : pass?error.status:400); res.end(JSON.stringify({ error: pass?error.message:error?.status === 413 ? '请求超过 300KB 限制' : '指令或询价数据无效：需 1–150 行、正数数量及有效指令' })); } return; }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const timer = setTimeout(() => controller.abort(), 90000);
      const streaming=req.headers.accept?.includes('application/x-ndjson');
      const write=event=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(event)+'\n');};
      if(streaming){res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();}
      try {
        const result=await runAgent(input,allRows({role:'sub',accountId:dataAccount}).cost,{signal:controller.signal,resources,audit:{store:agentAudit,actorId:ctx.accountId,inquiryId},onAuditEvent:streaming?event=>write({type:'progress',tool:event.tool,state:event.state}):undefined});
        if(streaming){write({type:'done',result});res.end();}else res.end(JSON.stringify(result));
      } catch(error) {
        const failure={error:'Agent 执行失败或超时，请检查模型工具调用能力后重试',runId:error.auditRunId||null};
        if(streaming){write({type:'error',...failure});if(!res.writableEnded)res.end();}
        else if(!res.destroyed&&!res.writableEnded){if(!res.headersSent)res.writeHead(502);res.end(JSON.stringify(failure));}
      } finally {clearTimeout(timer);}
      return;
    }  else if (req.method === 'GET' && url.pathname === '/') {
      const { cost, customFields } = allRows();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>库存后端</title>
<body style="font-family:'Microsoft YaHei',sans-serif;max-width:640px;margin:48px auto;line-height:1.9;color:#1c2434">
<h2>库存后端运行中 ✓</h2>
<p>物料 <b>${cost.length}</b> 条 · 自定义字段 <b>${customFields.length}</b> 个 · 库文件 <code>server/inventory.sqlite</code></p>
<p>这是数据服务，不是网页。报价页面请开 <a href="http://localhost:5173">http://localhost:5173</a>（需先运行 启动前端.bat）。</p>
<h3>可用接口</h3>
<ul>
<li><a href="/api/health">/api/health</a> 健康检查</li>
<li><a href="/api/inventory">/api/inventory</a> 全部物料（GET/POST）</li>
<li>/api/inventory/:件号（PUT 改 / DELETE 删）</li>
<li>/api/inventory/import（POST 批量导入）</li>
<li>/api/parse-xlsx（POST 解析 xlsx/csv）</li>
</ul></body></html>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/inventory') {
      res.end(JSON.stringify(allRows(ctx)));
    } else if (req.method === 'POST' && url.pathname === '/api/inventory') {
      const { row, accountId } = await readBody(req);
      if (!row?.partNumber) { res.writeHead(400); res.end(JSON.stringify({ error: 'partNumber 必填' })); return; }
      upsertRow(row, resolveTargetAccount(accountId)); persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'POST' && url.pathname === '/api/inventory/import') {
      const { rows, accountId } = await readBody(req);
      if (!Array.isArray(rows) || !rows.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'rows 为空' })); return; }
      const targetAccount = resolveTargetAccount(accountId);
      let ok = 0, skip = 0;
      db.run('BEGIN');
      try {
        for (const r of rows) {
          if (r?.partNumber) { upsertRow(r, targetAccount); ok++; } else skip++;
        }
        db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); throw error; }
      persist();
      res.end(JSON.stringify({ ok, skip }));
    } else if (req.method === 'PUT' && pnMatch) {
      const pn = decodeURIComponent(pnMatch[1]);
      const {patch,accountId}=await readBody(req);
      upsertRow({...patch,partNumber:pn},resolveTargetAccount(accountId));persist();
      res.end(JSON.stringify({ok:true}));
    } else if (req.method === 'DELETE' && pnMatch) {
      const target=resolveTargetAccount(url.searchParams.get('accountId'));
      db.run('DELETE FROM inventory WHERE partNumber=? AND account_id=?',[decodeURIComponent(pnMatch[1]),target]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'POST' && url.pathname === '/api/parse-xlsx') {
      const { fileName, base64 } = await readBody(req);
      if (!base64) { res.writeHead(400); res.end(JSON.stringify({ error: 'base64 为空' })); return; }
      const buf = Buffer.from(base64, 'base64');
      res.end(JSON.stringify(parseSheet(fileName || 'x.xlsx', buf)));
    } else if (req.method === 'POST' && url.pathname === '/api/parse-pdf') {
      const { base64 } = await readBody(req);
      if (!base64) { res.writeHead(400); res.end(JSON.stringify({ error: 'base64 为空' })); return; }
      res.end(JSON.stringify(parsePdf(Buffer.from(base64, 'base64'))));
    } else if (req.method === 'GET' && url.pathname === '/api/mcp/manifest') {
      res.end(JSON.stringify(MCP_MANIFEST()));
    } else if (req.method === 'POST' && url.pathname === '/api/mcp/tools/call') {
      const { name, arguments: args = {} } = await readBody(req, 500000);
      try { res.end(JSON.stringify(await callMcpTool(name, args, ctx))); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); }
    } else if (req.method === 'GET' && url.pathname === '/api/fields') {
      res.end(JSON.stringify({ schema: readSchema(db, ctx.accountId) }));
    } else if (req.method === 'PUT' && url.pathname === '/api/fields') {
      const { schema } = await readBody(req);
      if (!schema || !Array.isArray(schema.fields)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'schema.fields 必须是数组' })); return;
      }
      writeSchema(db, ctx.accountId, schema);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'GET' && url.pathname === '/api/units') {
      const scoped = ctx.role !== 'master';
      const r = db.exec(`SELECT pn, uom, factor, account_id FROM unit_conv${scoped ? ' WHERE account_id=?' : ''} ORDER BY pn`, scoped ? [ctx.accountId] : []);
      const rows = r.length ? r[0].values.map((v) => ({ pn: v[0], uom: v[1], factor: v[2], account_id: v[3] })) : [];
      res.end(JSON.stringify({ rows }));
    } else if (req.method === 'POST' && url.pathname === '/api/units') {
      const { pn, uom, factor, accountId } = await readBody(req);
      if (!pn || !uom || !(Number(factor) > 0)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'pn/uom/factor 必填，factor>0' })); return;
      }
      const targetAccount = resolveTargetAccount(accountId);
      db.run('INSERT OR REPLACE INTO unit_conv (pn, uom, factor, account_id) VALUES (?, ?, ?, ?)', [pn, uom, Number(factor), targetAccount]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/units/')) {
      const [, , , pn, uom] = url.pathname.split('/');
      db.run('DELETE FROM unit_conv WHERE pn=? AND uom=? AND account_id=?',[decodeURIComponent(pn),decodeURIComponent(uom),resolveTargetAccount(url.searchParams.get('accountId'))]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'GET' && url.pathname === '/api/review') {
      const task = url.searchParams.get('task') ?? '';
      const inquiryId = url.searchParams.get('inquiry_id') ?? '';
      const clauses=[],params=[];
      if(task||inquiryId){clauses.push('(task IN (?, ?) OR inquiry_id=?)');params.push(task||inquiryId,inquiryId||task,inquiryId||task);}
      if(ctx.role!=='master'){
        clauses.push('(inquiry_id IN (SELECT id FROM inquiry WHERE owner_id=?) OR (inquiry_id IS NULL AND account_id=?))');
        params.push(ctx.accountId,ctx.accountId);
      }
      const r=db.exec('SELECT * FROM review_log'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY id DESC LIMIT 500',params);
      const cols = r.length ? r[0].columns : [];
      const rows = r.length ? r[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]]))) : [];
      res.end(JSON.stringify({ rows }));
    } else if (req.method === 'POST' && url.pathname === '/api/review') {
      const { task = '', pn = '', action = '', detail = '', inquiryId: suppliedInquiryId } = await readBody(req);
      const inquiryId=suppliedInquiryId||(intake.ownerOf(task)!==undefined?task:null);
      if(inquiryId)guardInquiry(inquiryId,true);
      db.run('INSERT INTO review_log (task,pn,action,detail,operator,created_at,inquiry_id,account_id) VALUES (?,?,?,?,?,?,?,?)',
        [task,pn,action,detail,ctx.name,new Date().toISOString(),inquiryId,ctx.accountId]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'GET' && url.pathname === '/api/snapshots') {
      const orderId = url.searchParams.get('order_id') ?? '';
      const clauses=[],params=[];
      if(orderId){clauses.push('order_id=?');params.push(orderId);}
      if(ctx.role!=='master'){
        clauses.push('(inquiry_id IN (SELECT id FROM inquiry WHERE owner_id=?) OR (inquiry_id IS NULL AND account_id=?))');
        params.push(ctx.accountId,ctx.accountId);
      }
      const r=db.exec('SELECT id,order_id,kind,total,operator,created_at,inquiry_id,content_sha256 FROM quote_snapshot'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY id DESC LIMIT 50',params);
      const cols = r.length ? r[0].columns : [];
      const rows = r.length ? r[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]]))) : [];
      res.end(JSON.stringify({ rows }));
    } else if (req.method === 'POST' && url.pathname === '/api/snapshots') {
      const body=await readBody(req,2_000_000);
      if(body.inquiryId)guardInquiry(body.inquiryId,true);
      const inquiry=body.inquiryId?intake.detail(body.inquiryId):null;
      if(body.inquiryId)validateSavedQuote(body,quoteDrafts.read(body.inquiryId));
      const {fingerprint}=validateQuoteReceipt(body,inquiry);
      db.run('INSERT INTO quote_snapshot (order_id,kind,total,content,operator,created_at,inquiry_id,content_sha256,account_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [body.orderId,body.kind,body.total,body.content,ctx.name,new Date().toISOString(),body.inquiryId||null,fingerprint,ctx.accountId]);
      const id=db.exec('SELECT last_insert_rowid()')[0].values[0][0];persist();
      res.end(JSON.stringify({ok:true,id,fingerprint}));
    } else if (req.method === 'GET' && url.pathname === '/api/health') {
      res.end(JSON.stringify({ ok: true, rows: allRows().cost.length }));
    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
    }
  } catch (e) {
    if(!res.destroyed&&!res.writableEnded){const status=e.status||500;if(!res.headersSent)res.writeHead(status);res.end(JSON.stringify({error:status<500?String(e.message||'请求无效'):'服务执行失败，请检查输入或本机运行环境'}));}
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[inventory] 库存后端运行中: http://localhost:${PORT}（库文件 server/inventory.sqlite）`));
