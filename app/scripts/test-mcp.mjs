// MCP 接口预埋离线验证：manifest、只读工具、写意图人工确认闸、stdio JSON-RPC 协议。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MCP_MANIFEST, MCP_TOOLS, callMcpTool } from '../server/mcp-tools.mjs';
import { DEFAULT_SCHEMA, INDUSTRY_TEMPLATES, applyTemplate } from '../shared/field-schema.mjs';

const manifest = MCP_MANIFEST();
assert.equal(manifest.protocolVersion, '2024-11-05');
assert.equal(manifest.serverInfo.name, 'quanta-rfq-personal-agent');
assert.ok(manifest.transports.stdio.args.includes('server/mcp.mjs'));
assert.ok(MCP_TOOLS.some((t) => t.name === 'quanta_list_fields'));
assert.ok(MCP_TOOLS.some((t) => t.name === 'quanta_inspect_risks'));
for (const gate of ['quanta_propose_price', 'quanta_propose_field', 'quanta_request_export']) {
  assert.ok(MCP_TOOLS.some((t) => t.name === gate), `${gate} 必须预埋`);
  const result = await callMcpTool(gate, { inquiryId: 'X', partNumber: 'PN-1', price: 100, key: 'lotNo', label: '批次号' });
  assert.equal(result.requiresHumanConfirmation, true, `${gate} 不得直接执行写操作`);
  assert.ok(result.action);
}

// 只读工具走本地 HTTP；用 mock fetch 验证字段定义能透出企业自定义字段
const food = applyTemplate(DEFAULT_SCHEMA, '食品与生鲜');
assert.ok(INDUSTRY_TEMPLATES['食品与生鲜'].fields.some((f) => f.key === 'shelfLifeDays'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/fields')) return { ok: true, json: async () => ({ schema: food }) };
  if (String(url).includes('/api/health')) return { ok: true, json: async () => ({ ok: true, rows: 3 }) };
  throw new Error(`意外请求 ${url}`);
};
try {
  const fields = await callMcpTool('quanta_list_fields');
  assert.ok(fields.customFields.inquiry.some((f) => f.key === 'productionDate'));
  assert.ok(fields.customFields.supplier.some((f) => f.key === 'foodLicense'));
  const health = await callMcpTool('quanta_health');
  assert.equal(health.ok, true);

  // 风险巡检接完整核价规则：过期价与自定义必填都会被抓到
  const mockInquiry = { inquiries: [{ id: 'q1', title: 'QA', lines: [{ partNumber: 'PN-1', quantity: 1, uom: 'EA', condition: 'FN', customFields: { lotNo: '' } }] }] };
  const mockPrices = { prices: [{ id: 'p1', partNumber: 'PN-1', unitPrice: 10, currency: 'CNY', condition: 'FN', validUntil: '2000-01-01', moq: 1, leadDays: 1 }] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/fields')) return { ok: true, json: async () => ({ schema: food }) };
    if (u.includes('/api/inquiries')) return { ok: true, json: async () => mockInquiry };
    if (u.includes('/api/price-resources')) return { ok: true, json: async () => mockPrices };
    if (u.includes('/api/inventory')) return { ok: true, json: async () => ({ cost: [] }) };
    throw new Error(`意外请求 ${u}`);
  };
  const risks = await callMcpTool('quanta_inspect_risks');
  assert.ok(risks.pricingRisks.length >= 1, '过期价应被规则引擎抓出');
  assert.equal(risks.expiredPrices.length, 1);
  assert.ok(risks.customFieldIssues.some((x) => x.partNumber === 'PN-1' && x.field === '批次号'), '必填批次号缺失应被巡检抓出');
  assert.ok(risks.summary.pricingRisks >= 1);
} finally { globalThis.fetch = originalFetch; }

// stdio MCP：initialize / tools/list / ping 不需要令牌；tools/call 无 QUANTA_MCP_TOKEN 一律"未授权"
const lines = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'quanta_propose_price', arguments: { inquiryId: 'X', partNumber: 'PN-1', price: 100 } } }),
].join('\n') + '\n';
const env = { ...process.env };
delete env.QUANTA_MCP_TOKEN;
const child = spawnSync(process.execPath, ['server/mcp.mjs'], { input: lines, encoding: 'utf8', env });
assert.equal(child.status, 0, child.stderr);
const replies = child.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
assert.equal(replies.length, 4);
assert.equal(replies[0].result.serverInfo.name, 'quanta-rfq-personal-agent');
assert.ok(replies[1].result.tools.length >= 11);
assert.deepEqual(replies[2].result, {});
assert.equal(replies[3].result.isError, true, '无令牌调用必须被拒绝');
assert.match(JSON.parse(replies[3].result.content[0].text).error, /未授权/);

console.log('PASS: MCP manifest/stdio JSON-RPC, read-only tools, write-intent human-confirmation gate, token required');
