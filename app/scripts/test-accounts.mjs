process.env.RFQ_BOOTSTRAP_PASSWORD = 'admin123'; // Isolated test database only.
// 多账户（总账户/子账户）端到端验证：真鉴权、归属隔离、待认领池认领、master 汇总与改单、字段定义隔离、MCP 令牌边界。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import initSqlJs from 'sql.js';

const free = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const temp = mkdtempSync(join(tmpdir(), 'rfq-accounts-'));
const dbPath = join(temp, 'test.sqlite');
const port = await free();
const base = `http://127.0.0.1:${port}`;

async function start(extraEnv = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], {
    env: { ...process.env, RFQ_DB_PATH: dbPath, RFQ_PORT: String(port), RFQ_INTAKE_MODEL: 'off', RFQ_LLM_BASE_URL:'http://disabled.invalid', RFQ_LLM_API_KEY:'offline-test', VITE_LLM_MODEL:'offline-test', QUANTA_MCP_API_BASE: base, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try { const r = await fetch(base + '/api/health'); if (r.ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('test server startup timeout ' + log);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const put = (path, body, token) => fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const patch = (path, body, token) => fetch(base + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const get = (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const login = async (username, password) => {
  const r = await post('/api/auth/login', { username, password });
  return { status: r.status, body: await r.json() };
};

let child;
try {
  // —— 首次启动：种子 admin ——
  child = await start();
  assert.equal((await get('/api/inquiries')).status, 401, '无令牌访问业务接口必须 401');
  assert.equal((await login('admin', 'wrong-pass')).status, 401, '密码错误必须 401');
  const adminLogin = await login('admin', 'admin123');
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.body.account.role, 'master');
  assert.equal(adminLogin.body.account.mustChangePwd, true, '种子 admin 必须改密');
  assert.ok(adminLogin.body.token);
  child.kill();
  await once(child, 'exit');

  // —— 注入一条待认领池询价（owner_id NULL，模拟后续邮件自动进件） ——
  const SQL = await initSqlJs();
  const seedDb = new SQL.Database(readFileSync(dbPath));
  seedDb.run(
    "INSERT INTO inquiry(id,request_id,payload_hash,source,operator,title,status,created_at,updated_at,issues,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)",
    ['pool-1', 'pool-request-1', 'poolhash', 'manual_upload', 'mail-bot', '待认领池询价', 'evidence_ready', new Date().toISOString(), new Date().toISOString(), '[]'],
  );
  writeFileSync(dbPath, Buffer.from(seedDb.export()));
  seedDb.close();

  child = await start();
  const master = (await login('admin', 'admin123')).body.token;

  // —— master 建子账户 ——
  const alice = await (await post('/api/accounts', { username: 'alice', password: 'alice-pass-1', displayName: '爱丽丝' }, master)).json();
  const bob = await (await post('/api/accounts', { username: 'bob', password: 'bob-pass-1', displayName: '鲍勃' }, master)).json();
  assert.equal(alice.role, 'sub');
  const accountList = await (await get('/api/accounts', master)).json();
  assert.equal(accountList.accounts.length, 3);
  const aliceToken = (await login('alice', 'alice-pass-1')).body.token;
  const bobToken = (await login('bob', 'bob-pass-1')).body.token;
  assert.ok(aliceToken && bobToken);
  assert.equal((await post('/api/accounts', { username: 'eve', password: 'eve-pass-1' }, aliceToken)).status, 403, '子账户不得建账户');
  assert.equal((await get('/api/auth/me', aliceToken).then((r) => r.json())).mustChangePwd, true, '新建子账户首次登录须改密');

  // —— 子账户 A 建询价，归属 A ——
  const csv = Buffer.from('件号,描述,数量,单位,件状\nPN-A100,"FILTER, AIR",2,EA,FN\n').toString('base64');
  const created = await (await post('/api/inquiries', { requestId: 'alice-inquiry-01', operator: '爱丽丝', files: [{ name: 'parts.csv', base64: csv }] }, aliceToken)).json();
  assert.ok(created.id);
  const aliceLine = created.lines[0];
  assert.ok(aliceLine?.id);

  // —— 隔离：B 列表看不到 A 的单（看得到待认领池），读/改 A 的单被拒 ——
  const bobList = await (await get('/api/inquiries', bobToken)).json();
  assert.ok(!bobList.inquiries.some((i) => i.id === created.id), 'B 不得看到 A 的询价');
  assert.ok(bobList.inquiries.some((i) => i.id === 'pool-1'), 'B 应看到待认领池');
  assert.equal((await get(`/api/inquiries/${created.id}`, bobToken)).status, 404);
  assert.equal((await patch(`/api/inquiries/${created.id}/lines/${aliceLine.id}`, { version: aliceLine.version, patch: { description: '越权改' } }, bobToken)).status, 403);
  assert.equal((await get(`/api/inquiries/${created.id}/quote`, bobToken)).status, 404, 'B 不得读 A 的报价');

  assert.equal((await post('/api/review',{task:created.id,action:'private-alice'},aliceToken)).status,200);
  assert.equal((await post('/api/review',{task:created.id,action:'forged'},bobToken)).status,403);
  assert.ok((await (await get('/api/review',aliceToken)).json()).rows.some(row=>row.action==='private-alice'));
  assert.ok(!(await (await get('/api/review',bobToken)).json()).rows.some(row=>row.action==='private-alice'));
  assert.ok(!(await (await get('/api/review?task='+created.id,bobToken)).json()).rows.length);
  assert.equal((await get('/api/snapshots',bobToken)).status,200);
  assert.equal((await get('/api/agent/runs',bobToken)).status,200);

  // —— 认领：原子认领，重复认领 409 ——
  const claimed = await post('/api/inquiries/pool-1/claim', {}, bobToken);
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).owner_id, bob.id);
  assert.equal((await post('/api/inquiries/pool-1/claim', {}, bobToken)).status, 409, '重复认领必须 409');
  assert.equal((await post('/api/inquiries/pool-1/claim', {}, aliceToken)).status, 409);

  // —— master 汇总视图带归属人名；master 直接改 A 的行，A 刷新即见 ——
  const masterList = await (await get('/api/inquiries', master)).json();
  const masterA = masterList.inquiries.find((i) => i.id === created.id);
  assert.equal(masterA.owner_name, '爱丽丝');
  assert.ok(masterList.inquiries.some((i) => i.id === 'pool-1' && i.owner_name === '鲍勃'));
  const masterEdit = await patch(`/api/inquiries/${created.id}/lines/${aliceLine.id}`, { version: aliceLine.version, patch: { description: 'master 改价备注' } }, master);
  assert.equal(masterEdit.status, 200);
  const aliceDetail = await (await get(`/api/inquiries/${created.id}`, aliceToken)).json();
  assert.equal(aliceDetail.lines.find((l) => l.id === aliceLine.id).description, 'master 改价备注', 'master 改同一行，子账户刷新即见');

  // —— master 指派 ——
  assert.equal((await post(`/api/inquiries/${created.id}/assign`, { ownerId: bob.id }, aliceToken)).status, 403, '子账户不得指派');
  const assigned = await post(`/api/inquiries/${created.id}/assign`, { ownerId: alice.id }, master);
  assert.equal(assigned.status, 200);

  // —— 字段定义按账号隔离 ——
  const customSchema = { version: 1, industry: '通用', fields: [{ key: 'qaSecretField', label: '隔离字段', type: 'text', scope: 'inquiry' }] };
  assert.equal((await put('/api/fields', { schema: customSchema }, aliceToken)).status, 200);
  const aliceSchema = await (await get('/api/fields', aliceToken)).json();
  assert.ok(aliceSchema.schema.fields.some((f) => f.key === 'qaSecretField'));
  const bobSchema = await (await get('/api/fields', bobToken)).json();
  assert.ok(!bobSchema.schema.fields.some((f) => f.key === 'qaSecretField'), 'B 不得读到 A 的字段定义');

  // —— 价格资源/库存按账号隔离，master 汇总带账号 ——
  assert.equal((await post('/api/price-resources', { row: { id: 'price-a1', partNumber: 'PN-A100', unitPrice: 88, currency: 'CNY' } }, aliceToken)).status, 200);
  const bobPrices = await (await get('/api/price-resources', bobToken)).json();
  assert.ok(!bobPrices.prices.some((p) => p.id === 'price-a1'));
  const masterPrices = await (await get('/api/price-resources', master)).json();
  const seen = masterPrices.prices.find((p) => p.id === 'price-a1');
  assert.ok(seen && seen.account_name === '爱丽丝' && seen.account_id === alice.id, 'master 汇总须带归属账号');
  assert.equal((await post('/api/inventory', { row: { partNumber: 'STOCK-A1', stockQty: 3 } }, aliceToken)).status, 200);
  const bobStock = await (await get('/api/inventory', bobToken)).json();
  assert.ok(!bobStock.cost.some((r) => r.partNumber === 'STOCK-A1'));
  const masterStock = await (await get('/api/inventory', master)).json();
  assert.ok(masterStock.cost.some((r) => r.partNumber === 'STOCK-A1' && r.account_id === alice.id));
  assert.equal((await post('/api/inventory', { row: { partNumber: 'STOCK-A1', stockQty: 9 } }, bobToken)).status, 200);
  const aliceStockAfter=await (await get('/api/inventory',aliceToken)).json();
  assert.equal(aliceStockAfter.cost.find(row=>row.partNumber==='STOCK-A1').stockQty,3);
  assert.equal((await (await get('/api/inventory',bobToken)).json()).cost.find(row=>row.partNumber==='STOCK-A1').stockQty,9);
  assert.equal((await post('/api/units',{pn:'STOCK-A1',uom:'BOX',factor:10},aliceToken)).status,200);
  assert.equal((await post('/api/units',{pn:'STOCK-A1',uom:'BOX',factor:20},bobToken)).status,200);
  assert.equal((await (await get('/api/units',aliceToken)).json()).rows.find(row=>row.pn==='STOCK-A1').factor,10);
  assert.equal((await (await get('/api/units',bobToken)).json()).rows.find(row=>row.pn==='STOCK-A1').factor,20);


  const sharedStock={partNumber:'PN-A100',stockQty:10,uom:'EA',stockCondition:'FN',currency:'CNY'};
  assert.equal((await post('/api/inventory',{row:{...sharedStock,lastPurchasePrice:11}},aliceToken)).status,200);
  assert.equal((await post('/api/inventory',{row:{...sharedStock,lastPurchasePrice:22}},bobToken)).status,200);
  const toBob=await post(`/api/inquiries/${created.id}/assign`,{ownerId:bob.id},master);
  assert.equal(toBob.status,200);
  const bobEvidence=(await toBob.json()).lines[0].evidence.filter(row=>row.source==='inventory');
  assert.equal(bobEvidence.length,1);
  assert.equal(bobEvidence[0].snapshot.account_id,bob.id);
  assert.equal(bobEvidence[0].snapshot.lastPurchasePrice,22);
  const toAlice=await post(`/api/inquiries/${created.id}/assign`,{ownerId:alice.id},master);
  assert.equal(toAlice.status,200);
  assert.equal((await toAlice.json()).lines[0].evidence.find(row=>row.source==='inventory').snapshot.lastPurchasePrice,11);

  const customPatch=await put('/api/inventory/STOCK-A1',{patch:{lotTag:'B-LOT'}},bobToken);
  assert.equal(customPatch.status,200);
  assert.equal((await (await get('/api/inventory',bobToken)).json()).cost.find(row=>row.partNumber==='STOCK-A1').extra.lotTag,'B-LOT');
  assert.equal((await (await get('/api/inventory',aliceToken)).json()).cost.find(row=>row.partNumber==='STOCK-A1').extra.lotTag,undefined);
  const failedAgent=await post('/api/agent/run',{inquiryId:created.id,instruction:'只检查需求',lines:[{key:`intake-${created.id}-1`,partNumber:'PN-A100',quantity:2,uom:'EA',condition:'FN'}]},aliceToken);
  assert.equal(failedAgent.status,502);
  const failedRun=await failedAgent.json();
  assert.ok(failedRun.runId,'unconfigured model must still produce an actor-scoped audit record');
  assert.equal((await get('/api/agent/runs/'+failedRun.runId,aliceToken)).status,200);
  assert.equal((await get('/api/agent/runs/'+failedRun.runId,bobToken)).status,404);
  assert.ok(!(await (await get('/api/agent/runs',bobToken)).json()).runs.some(run=>run.runId===failedRun.runId));

  // —— MCP：无令牌 401；B 令牌查 A 的单被拒 ——
  assert.equal((await post('/api/mcp/tools/call', { name: 'quanta_list_inquiries', arguments: {} })).status, 401);
  const denied = await post('/api/mcp/tools/call', { name: 'quanta_get_inquiry', arguments: { id: created.id } }, bobToken);
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /404|未授权/);
  const deniedWrite = await post('/api/mcp/tools/call', { name: 'quanta_propose_price', arguments: { inquiryId: created.id, partNumber: 'PN-A100', price: 1 } }, bobToken);
  assert.equal(deniedWrite.status, 400);
  assert.match((await deniedWrite.json()).error, /未授权/);
  const bobMcp = await post('/api/mcp/tools/call', { name: 'quanta_list_inquiries', arguments: {} }, bobToken);
  assert.equal(bobMcp.status, 200);
  assert.ok(!(await bobMcp.json()).inquiries.some((i) => i.id === created.id), 'MCP 列表不得越权');

  // —— 邮箱绑定（本期只存配置）——
  assert.equal((await put(`/api/accounts/${alice.id}/email-bindings`, { bindings: [{ email: 'alice@example.com', purpose: 'inquiry_intake' }] }, aliceToken)).status, 200);
  assert.equal((await put(`/api/accounts/${alice.id}/email-bindings`, { bindings: [] }, bobToken)).status, 403, 'B 不得改 A 的邮箱绑定');
  const bindings = await (await get(`/api/accounts/${alice.id}/email-bindings`, master)).json();
  assert.deepEqual(bindings.bindings, [{ email: 'alice@example.com', purpose: 'inquiry_intake' }]);

  // —— 改密/重置/禁用 ——
  assert.equal((await post('/api/auth/change-password', { oldPassword: 'bad', newPassword: 'alice-pass-2' }, aliceToken)).status, 400);
  assert.equal((await post('/api/auth/change-password', { oldPassword: 'alice-pass-1', newPassword: 'alice-pass-2' }, aliceToken)).status, 200);
  assert.equal((await login('alice', 'alice-pass-2')).status, 200);
  assert.equal((await post(`/api/accounts/${bob.id}/reset-password`, { newPassword: 'bob-pass-2' }, master)).status, 200);
  assert.equal((await get('/api/auth/me', bobToken)).status, 401, '重置后旧令牌必须失效');
  assert.equal((await login('bob', 'bob-pass-1')).status, 401);
  const bobToken2 = (await login('bob', 'bob-pass-2')).body.token;
  assert.ok(bobToken2);
  assert.equal((await post(`/api/accounts/${bob.id}/disabled`, { disabled: true }, master)).status, 200);
  assert.equal((await get('/api/auth/me', bobToken2)).status, 401, '禁用后令牌立即失效');
  assert.equal((await login('bob', 'bob-pass-2')).status, 401, '禁用账户不得登录');

  // —— config/accounts.json 配置同步：新建子账户+邮箱绑定、幂等、不覆盖已改密码 ——
  child.kill();
  await once(child, 'exit');
  const configPath = join(temp, 'accounts.json');
  writeFileSync(configPath, JSON.stringify({
    master: { username: 'admin', displayName: '老板' },
    subAccounts: [
      { username: 'configli', displayName: '配置小李', password: 'config-pass-1', emailBindings: [{ email: 'li@example.com', purpose: '接收询价' }] },
    ],
  }));
  child = await start({ RFQ_ACCOUNTS_CONFIG: configPath });
  const confLogin = await login('configli', 'config-pass-1');
  assert.equal(confLogin.status, 200, '配置创建的子账户必须能登录');
  assert.equal(confLogin.body.account.displayName, '配置小李');
  assert.equal(confLogin.body.account.mustChangePwd, true, '配置新建账户默认强制改密');
  const confMe = await (await get('/api/auth/me', confLogin.body.token)).json();
  assert.deepEqual(confMe.emailBindings, [{ email: 'li@example.com', purpose: '接收询价' }]);
  const adminMe = await (await get('/api/auth/me', master)).json();
  assert.equal(adminMe.displayName, '老板', 'master 的 displayName 应被配置更新');
  assert.equal((await post('/api/auth/change-password', { oldPassword: 'config-pass-1', newPassword: 'config-pass-2' }, confLogin.body.token)).status, 200);
  child.kill();
  await once(child, 'exit');
  child = await start({ RFQ_ACCOUNTS_CONFIG: configPath });
  assert.equal((await login('configli', 'config-pass-2')).status, 200, '二次同步不得覆盖已改密码');
  assert.equal((await login('configli', 'config-pass-1')).status, 401, '初始密码同步后必须失效');
  const accountCount = (await (await get('/api/accounts', master)).json()).accounts.length;
  assert.equal(accountCount, 4, '二次同步不得重复建号（admin/alice/bob/configli）');

  console.log('PASS: 多账户鉴权/隔离/认领/指派/master 改单/字段与基础数据隔离/MCP 令牌边界/改密重置禁用/配置文件同步');
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
  rmSync(temp, { recursive: true, force: true });
}

// First-start credentials stay private and a leftover credential file supports retry.
const {createAccountStore}=await import('../server/accounts.mjs');
const bootstrapTemp=mkdtempSync(join(tmpdir(),'rfq-bootstrap-'));
const bootstrapDbPath=join(bootstrapTemp,'fresh.sqlite');
const configuredPassword=process.env.RFQ_BOOTSTRAP_PASSWORD;
delete process.env.RFQ_BOOTSTRAP_PASSWORD;
try {
  const SQL=await initSqlJs();
  const firstDb=new SQL.Database();
  const firstStore=createAccountStore(firstDb,()=>{},{dbPath:bootstrapDbPath});
  const credentials=JSON.parse(readFileSync(bootstrapDbPath+'.bootstrap.json','utf8'));
  assert.ok(credentials.password.length>=24);
  assert.notEqual(credentials.password,'admin123');
  assert.ok(firstStore.verifyLogin('admin',credentials.password));
  firstDb.close();
  const retryDb=new SQL.Database();
  const retryStore=createAccountStore(retryDb,()=>{},{dbPath:bootstrapDbPath});
  assert.ok(retryStore.verifyLogin('admin',credentials.password));
  retryDb.close();
  console.log('PASS: randomized initial credentials and retry with an existing bootstrap file');
} finally {
  if(configuredPassword===undefined)delete process.env.RFQ_BOOTSTRAP_PASSWORD;
  else process.env.RFQ_BOOTSTRAP_PASSWORD=configuredPassword;
  rmSync(bootstrapTemp,{recursive:true,force:true});
}
