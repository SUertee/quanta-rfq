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
import {initIntake,seedPrices,createIntakeService} from './intake.mjs';
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
const agentAudit=createAgentAuditStore(db,persist);
agentAudit.registerAgent(RFQ_AGENT_DEFINITION);
agentAudit.recoverInterrupted();
const priceSeedPath=fileURLToPath(new URL('../public/data/prices.json',import.meta.url));
seedPrices(db,existsSync(priceSeedPath)?JSON.parse(readFileSync(priceSeedPath,'utf8')):[]);
db.run("UPDATE inquiry SET status='interrupted',issues='[\"服务重启中断了处理，已保留已接收文件\"]' WHERE status='processing'");
const runtime=getRuntimeConfig();
const intake=createIntakeService(db,persist,{modelConfig:runtime.model,ocrConfig:runtime.ocr});
persist();

// 首次启动：从演示成本表播种
const count = db.exec('SELECT COUNT(*) AS c FROM inventory')[0].values[0][0];
if (count === 0 && existsSync(SEED_PATH)) {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
  for (const r of seed) upsertRow(r);
  persist();
  console.log(`[inventory] 播种 ${seed.length} 条`);
}

function persist() {
  writeFileSync(DB_PATH+'.tmp', Buffer.from(db.export()));
  renameSync(DB_PATH+'.tmp', DB_PATH);
}

function upsertRow(row) {
  const provided = {};
  const extra = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'partNumber' || v === undefined) continue;
    if (CORE.includes(k)) provided[k] = NUMERIC.has(k) ? (v === '' || v === null ? null : Number(v)) : String(v);
    else extra[k] = v;
  }
  const old = db.exec('SELECT extra FROM inventory WHERE partNumber = ?', [row.partNumber]);
  if (old.length && old[0].values.length) {
    // 已存在：只更新提供的字段，自定义字段合并保留
    const oldExtra = JSON.parse(old[0].values[0][0] || '{}');
    const merged = { ...oldExtra, ...extra };
    const keys = Object.keys(provided);
    if (keys.length) {
      db.run(`UPDATE inventory SET ${keys.map((k) => `${k} = ?`).join(', ')}, extra = ? WHERE partNumber = ?`,
        [...keys.map((k) => provided[k]), JSON.stringify(merged), row.partNumber]);
    } else {
      db.run('UPDATE inventory SET extra = ? WHERE partNumber = ?', [JSON.stringify(merged), row.partNumber]);
    }
  } else {
    // 新建：缺省字段补默认值（空字段允许）
    const cols = { ...provided };
    for (const k of CORE) if (!(k in cols) && k !== 'partNumber') cols[k] = NUMERIC.has(k) ? null : '';
    db.run(`INSERT INTO inventory (${CORE.join(',')}, extra) VALUES (${CORE.map(() => '?').join(',')}, ?)`, [
      row.partNumber,
      ...CORE.filter((c) => c !== 'partNumber').map((c) => cols[c]),
      JSON.stringify(extra),
    ]);
  }
}

function allRows() {
  const res = db.exec(`SELECT ${CORE.join(',')}, extra FROM inventory ORDER BY partNumber`);
  const customFields = new Set();
  const cost = res.length
    ? res[0].values.map((v) => {
        const row = {};
        CORE.forEach((c, i) => { row[c] = v[i] ?? (NUMERIC.has(c) ? 0 : ''); });
        const extra = JSON.parse(v[v.length - 1] || '{}');
        Object.keys(extra).forEach((k) => customFields.add(k));
        row.extra = extra;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');
  const legacyIntakeList=url.pathname==='/api/intake/batches';
  if(url.pathname.startsWith('/api/intake/batches'))url.pathname=url.pathname.replace('/api/intake/batches','/api/inquiries');
  if(url.pathname.startsWith('/api/intake/files'))url.pathname=url.pathname.replace('/api/intake/files','/api/files');
  const pnMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)$/);
  try {
    const addLinePath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/lines$/);
    if(addLinePath&&req.method==='POST'){res.end(JSON.stringify(intake.addLine(addLinePath[1],await readBody(req,50000))));return;}
    const linePath=url.pathname.match(/^\/api\/inquiries\/([^/]+)\/lines\/([^/]+)$/);
    if(linePath&&req.method==='PATCH'){res.end(JSON.stringify(intake.updateLine(linePath[1],linePath[2],await readBody(req,50000))));return;}
    if(url.pathname==='/api/inquiries' && req.method==='POST'){
      const result=await intake.create(await readBody(req,36_000_000));res.end(JSON.stringify(result));return;
    }
    if(url.pathname==='/api/inquiries' && req.method==='GET'){res.end(JSON.stringify({[legacyIntakeList?'batches':'inquiries']:intake.list(Object.fromEntries(url.searchParams))}));return;}
    if(url.pathname==='/api/price-resources' && req.method==='GET'){res.end(JSON.stringify({prices:intake.prices()}));return;}
    const batchPath=url.pathname.match(/^\/api\/inquiries\/([^/]+)(\/evidence)?$/);
    if(batchPath && (req.method==='GET'||(req.method==='POST'&&batchPath[2]))){const result=batchPath[2]?intake.refresh(batchPath[1]):intake.detail(batchPath[1]);if(!result)res.writeHead(404);res.end(JSON.stringify(result||{error:'批次不存在'}));return;}
    const rawPath=url.pathname.match(/^\/api\/files\/([^/]+)\/raw$/);
    if(rawPath&&req.method==='GET'){const f=intake.rawFile(rawPath[1]);if(!f){res.writeHead(404);res.end(JSON.stringify({error:'文件不存在'}));return;}res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);res.end(Buffer.from(f.raw));return;}
    if(req.method==='GET'&&url.pathname==='/api/agents'){res.end(JSON.stringify({agents:agentAudit.listAgents()}));return;}
    if(req.method==='POST'&&url.pathname==='/api/assistant/files'){res.end(JSON.stringify(await readChatFiles(await readBody(req,36_000_000))));return;}
    if(req.method==='POST'&&url.pathname==='/api/assistant/chat'){
      const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      const body=await readBody(req,100000),streaming=req.headers.accept?.includes('application/x-ndjson');
      if(!streaming){res.end(JSON.stringify(await platformChat(body,{signal:controller.signal})));return;}
      res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
      const write=event=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(event)+'\n');};
      try{const result=await platformChat(body,{signal:controller.signal,onDelta:text=>write({type:'delta',text})});write({type:'done',...result});}
      catch{write({type:'error',error:'回复中断或模型连接失败，请重试。'});}
      if(!res.writableEnded)res.end();return;
    }
    if(req.method==='GET'&&url.pathname==='/api/agent/runs'){res.end(JSON.stringify({runs:agentAudit.listRuns({inquiryId:url.searchParams.get('inquiryId'),limit:url.searchParams.get('limit')||30})}));return;}
    const auditPath=url.pathname.match(/^\/api\/agent\/runs\/([a-zA-Z0-9_.:-]+)$/);
    if(req.method==='GET'&&auditPath){const run=agentAudit.getRun(auditPath[1]);if(!run)res.writeHead(404);res.end(JSON.stringify(run||{error:'运行记录不存在'}));return;}
    if (req.method === 'POST' && url.pathname === '/api/agent/run') {
      const origin = req.headers.origin;
      if (Number(req.headers['content-length'] || 0) > 300000) { res.writeHead(413); res.end(JSON.stringify({error:'请求过大'})); return; }
      let input, inquiryId=null;
      try {
        let body=await readBody(req,300000);
        if(body.inquiryId||body.batchId){const b=intake.detail(body.inquiryId||body.batchId);if(!b)throw new Error('询价不存在');inquiryId=b.id;body=resolveAgentScope(body,b);}
        input = validateAgentInput(body);
      }
      catch (error) { if (!res.destroyed && !res.writableEnded) { if (!res.headersSent) res.writeHead(error?.status === 413 ? 413 : 400); res.end(JSON.stringify({ error: error?.status === 413 ? '请求超过 300KB 限制' : '指令或询价数据无效：需 1–150 行、正数数量及有效指令' })); } return; }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const timer = setTimeout(() => controller.abort(), 90000);
      try { res.end(JSON.stringify(await runAgent(input, allRows().cost, { signal: controller.signal, audit:{store:agentAudit,actorId:'local-user',inquiryId} }))); }
      catch (error) { if (!res.destroyed && !res.writableEnded) { if (!res.headersSent) res.writeHead(502); res.end(JSON.stringify({error:'Agent 执行失败或超时，未写入任何报价；请检查模型工具调用能力后重试',runId:error.auditRunId||null})); } }
      finally { clearTimeout(timer); }
      return;
    }  else if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api')) {
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
      res.end(JSON.stringify(allRows()));
    } else if (req.method === 'POST' && url.pathname === '/api/inventory') {
      const { row } = await readBody(req);
      if (!row?.partNumber) { res.writeHead(400); res.end(JSON.stringify({ error: 'partNumber 必填' })); return; }
      upsertRow(row); persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'POST' && url.pathname === '/api/inventory/import') {
      const { rows } = await readBody(req);
      if (!Array.isArray(rows) || !rows.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'rows 为空' })); return; }
      let ok = 0, skip = 0;
      for (const r of rows) {
        if (r?.partNumber) { upsertRow(r); ok++; } else skip++;
      }
      persist();
      res.end(JSON.stringify({ ok, skip }));
    } else if (req.method === 'PUT' && pnMatch) {
      const pn = decodeURIComponent(pnMatch[1]);
      const { patch } = await readBody(req);
      upsertRow({ ...patch, partNumber: pn }); persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'DELETE' && pnMatch) {
      db.run('DELETE FROM inventory WHERE partNumber = ?', [decodeURIComponent(pnMatch[1])]); persist();
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
    } else if (req.method === 'GET' && url.pathname === '/api/units') {
      const r = db.exec('SELECT pn, uom, factor FROM unit_conv ORDER BY pn');
      const rows = r.length ? r[0].values.map((v) => ({ pn: v[0], uom: v[1], factor: v[2] })) : [];
      res.end(JSON.stringify({ rows }));
    } else if (req.method === 'POST' && url.pathname === '/api/units') {
      const { pn, uom, factor } = await readBody(req);
      if (!pn || !uom || !(Number(factor) > 0)) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'pn/uom/factor 必填，factor>0' })); return;
      }
      db.run('INSERT OR REPLACE INTO unit_conv (pn, uom, factor) VALUES (?, ?, ?)', [pn, uom, Number(factor)]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'DELETE' && url.pathname.startsWith('/api/units/')) {
      const [, , , pn, uom] = url.pathname.split('/');
      db.run('DELETE FROM unit_conv WHERE pn = ? AND uom = ?', [decodeURIComponent(pn), decodeURIComponent(uom)]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'GET' && url.pathname === '/api/review') {
      const task = url.searchParams.get('task') ?? '';
      const r = task
        ? db.exec('SELECT * FROM review_log WHERE task = ? ORDER BY id DESC LIMIT 500', [task])
        : db.exec('SELECT * FROM review_log ORDER BY id DESC LIMIT 500');
      const cols = r.length ? r[0].columns : [];
      const rows = r.length ? r[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]]))) : [];
      res.end(JSON.stringify({ rows }));
    } else if (req.method === 'POST' && url.pathname === '/api/review') {
      const { task = '', pn = '', action = '', detail = '', operator = '' } = await readBody(req);
      db.run('INSERT INTO review_log (task, pn, action, detail, operator, created_at) VALUES (?,?,?,?,?,?)',
        [task, pn, action, detail, operator, new Date().toISOString()]);
      persist();
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'GET' && url.pathname === '/api/snapshots') {
      const orderId = url.searchParams.get('order_id') ?? '';
      const r = orderId
        ? db.exec('SELECT id, order_id, kind, total, operator, created_at, inquiry_id, content_sha256 FROM quote_snapshot WHERE order_id = ? ORDER BY id DESC LIMIT 50', [orderId])
        : db.exec('SELECT id, order_id, kind, total, operator, created_at, inquiry_id, content_sha256 FROM quote_snapshot ORDER BY id DESC LIMIT 50');
      const cols = r.length ? r[0].columns : [];
      const rows = r.length ? r[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]]))) : [];
      res.end(JSON.stringify({ rows }));
    } else if (req.method === 'POST' && url.pathname === '/api/snapshots') {
      const body=await readBody(req,2_000_000);
      const inquiry=body.inquiryId?intake.detail(body.inquiryId):null;
      const {fingerprint}=validateQuoteReceipt(body,inquiry);
      db.run('INSERT INTO quote_snapshot (order_id,kind,total,content,operator,created_at,inquiry_id,content_sha256) VALUES (?,?,?,?,?,?,?,?)',
        [body.orderId,body.kind,body.total,body.content,String(body.operator||'local-user'),new Date().toISOString(),body.inquiryId||null,fingerprint]);
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
