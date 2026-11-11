// Personal Agent 接入接口（MCP 预埋）：stdio MCP server 与 HTTP manifest/call 共用同一份工具表。
// 纪律：只开放只读工具；所有写意图返回 requiresHumanConfirmation，绝不落库、不定价、不发送。
import { businessToday, evaluateQuoteLine, matchResources } from '../shared/rfq-rules.mjs';
import { certificatesFor, condAliasesFor, customFieldDefs, validateValue } from '../shared/field-schema.mjs';

const API_BASE = () => (process.env.QUANTA_MCP_API_BASE || 'http://127.0.0.1:3004').replace(/\/$/, '');

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_INFO = { name: 'quanta-rfq-personal-agent', version: '0.1.0' };
export const MCP_BOUNDARY = '只读工具直接读当前工作区数据；写意图只返回待人工确认建议，Agent 不得自行定价、改字段、导出或发送。';

export const MCP_TOOLS = [
  { name: 'quanta_health', description: '检查 Quanta 后端是否可用，返回库存条数。', inputSchema: { type: 'object', properties: {} } },
  { name: 'quanta_list_fields', description: '读取企业字段定义（内置+自定义字段、类型、环节开关）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'quanta_list_inquiries', description: '列出全部询价任务（任务ID、标题、状态、行数、日期）。', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '最多返回条数，默认 50' } } } },
  { name: 'quanta_get_inquiry', description: '读取单个询价任务详情：原始材料、行项目、自定义字段、提取问题。', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '询价任务 ID' } }, required: ['id'] } },
  { name: 'quanta_get_quote', description: '读取任务当前报价草稿（确认单价、核对与导出状态）。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'quanta_list_inventory', description: '读取库存与成本（含企业自定义字段 extra）。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'quanta_list_price_resources', description: '读取供应商价格资源（价格、有效期、证书、税基）。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'quanta_inspect_risks', description: '跨任务风险巡检：提取问题、自定义字段必填缺失、过期供应商报价。', inputSchema: { type: 'object', properties: {} } },
  // 以下为写意图工具：只返回待人工确认建议，不执行任何写操作
  { name: 'quanta_propose_price', description: '（写意图·预埋）给出单价建议，返回待人工确认载荷；不写入报价。', inputSchema: { type: 'object', properties: { inquiryId: { type: 'string' }, partNumber: { type: 'string' }, price: { type: 'number' }, reason: { type: 'string' } }, required: ['inquiryId', 'partNumber', 'price'] } },
  { name: 'quanta_propose_field', description: '（写意图·预埋）建议新增/修改企业字段定义，返回待人工确认载荷；不写 schema。', inputSchema: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' }, scope: { type: 'string' } }, required: ['key', 'label'] } },
  { name: 'quanta_request_export', description: '（写意图·预埋）请求导出报价单，返回待人工确认载荷；不生成文件、不发送。', inputSchema: { type: 'object', properties: { inquiryId: { type: 'string' }, kind: { type: 'string', enum: ['内部版', '客户版'] } }, required: ['inquiryId'] } },
];

async function api(path, ctx) {
  const headers = ctx?.token ? { authorization: `Bearer ${ctx.token}` } : {};
  const r = await fetch(API_BASE() + path, { headers, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

/** 写意图工具的目标归属校验：sub 操作他人询价直接拒绝（服务端按令牌过滤后不可见即越权）。 */
async function assertInquiryTarget(inquiryId, ctx) {
  if (ctx === undefined || !inquiryId) return;
  if (!ctx) throw new Error('未授权');
  try {
    await api(`/api/inquiries/${encodeURIComponent(inquiryId)}`, ctx);
  } catch {
    throw new Error('未授权：无法访问该询价（不存在或属于其他账户）');
  }
}

const humanGate = (action, payload, extra = {}) => ({
  requiresHumanConfirmation: true,
  action,
  payload,
  message: '该操作已记录为建议，必须由报价员在 Quanta 工作台确认后执行；Personal Agent 不得代为定价、改字段、导出或发送。',
  ...extra,
});

export async function callMcpTool(name, args = {}, ctx) {
  if (ctx === null) throw new Error('未授权');
  const a = args && typeof args === 'object' ? args : {};
  const limit = Math.max(1, Math.min(Number(a.limit) || 50, 200));
  switch (name) {
    case 'quanta_health':
      return { ok: true, apiBase: API_BASE(), ...(await api('/api/health', ctx)) };
    case 'quanta_list_fields': {
      const { schema } = await api('/api/fields', ctx);
      return { schema, customFields: { inquiry: customFieldDefs(schema, 'inquiry'), inventory: customFieldDefs(schema, 'inventory'), supplier: customFieldDefs(schema, 'supplier') } };
    }
    case 'quanta_list_inquiries': {
      const data = await api('/api/inquiries', ctx);
      const list = data.inquiries || data.batches || [];
      return { total: list.length, inquiries: list.slice(0, limit).map((x) => ({ id: x.id, title: x.title || x.subject, status: x.status, lineCount: x.lines?.length ?? x.lineCount, updatedAt: x.updated_at || x.updatedAt, issues: x.issues, owner: x.owner_name ?? null })) };
    }
    case 'quanta_get_inquiry': {
      if (!a.id) throw new Error('缺少 id');
      const detail = await api(`/api/inquiries/${encodeURIComponent(a.id)}`, ctx);
      return { id: a.id, title: detail.title, status: detail.status, issues: detail.issues, lines: (detail.lines || []).map((l) => ({ partNumber: l.partNumber, description: l.description, quantity: l.quantity, uom: l.uom, condition: l.condition, issues: l.issues, customFields: l.customFields })) };
    }
    case 'quanta_get_quote': {
      if (!a.id) throw new Error('缺少 id');
      return { id: a.id, quote: await api(`/api/inquiries/${encodeURIComponent(a.id)}/quote`, ctx) };
    }
    case 'quanta_list_inventory': {
      const data = await api('/api/inventory', ctx);
      return { total: data.cost?.length ?? 0, customFields: data.customFields, rows: (data.cost || []).slice(0, limit) };
    }
    case 'quanta_list_price_resources': {
      const data = await api('/api/price-resources', ctx);
      return { total: data.prices?.length ?? 0, rows: (data.prices || []).slice(0, limit) };
    }
    case 'quanta_inspect_risks': {
      const [{ schema }, inquiriesData, priceData, inventoryData] = await Promise.all([
        api('/api/fields', ctx), api('/api/inquiries', ctx), api('/api/price-resources', ctx), api('/api/inventory', ctx),
      ]);
      const costs = inventoryData.cost || [];
      const prices = priceData.prices || [];
      const rules = { certificates: certificatesFor(schema), condAliases: condAliasesFor(schema) };
      const pricingRisks = [];
      for (const t of inquiriesData.inquiries || inquiriesData.batches || []) {
        for (const l of t.lines || []) {
          if (!l.partNumber) continue;
          const evidence = matchResources(l.partNumber, costs, prices);
          const evaluated = evaluateQuoteLine(l, evidence, rules);
          const conflicts = evaluated.candidates.flatMap((c) => c.match.checks.filter((x) => x.state === 'conflict').map((x) => ({ code: x.code, message: x.message })));
          const review = evaluated.candidates.flatMap((c) => c.match.checks.filter((x) => x.state === 'unknown').map((x) => ({ code: x.code, message: x.message })));
          if (conflicts.length || review.length) pricingRisks.push({ id: t.id, partNumber: l.partNumber, conflicts, needsReview: review });
        }
      }
      const today = businessToday();
      const defs = customFieldDefs(schema, 'inquiry');
      const extractionIssues = [];
      const customIssues = [];
      for (const t of inquiriesData.inquiries || inquiriesData.batches || []) {
        for (const l of t.lines || []) {
          if (l.issues?.length) extractionIssues.push({ id: t.id, partNumber: l.partNumber, issues: l.issues });
          for (const def of defs) {
            const problems = validateValue(def, l.customFields?.[def.key]);
            if (problems.length) customIssues.push({ id: t.id, partNumber: l.partNumber, field: def.label, problems });
          }
        }
      }
      const expired = (priceData.prices || []).filter((p) => p.validUntil && String(p.validUntil).slice(0, 10) < today);
      return { asOf: today, extractionIssues, customFieldIssues: customIssues, pricingRisks, expiredPrices: expired.map((p) => ({ id: p.id, partNumber: p.partNumber, validUntil: p.validUntil })), summary: { extractionIssues: extractionIssues.length, customFieldIssues: customIssues.length, expiredPrices: expired.length, pricingRisks: pricingRisks.length } };
    }
    case 'quanta_propose_price':
      await assertInquiryTarget(a.inquiryId, ctx);
      return humanGate('confirm_price', { inquiryId: a.inquiryId, partNumber: a.partNumber, price: a.price, reason: a.reason || '' });
    case 'quanta_propose_field':
      return humanGate('save_field_schema', { key: a.key, label: a.label, type: a.type || 'text', scope: a.scope || 'inquiry' });
    case 'quanta_request_export':
      await assertInquiryTarget(a.inquiryId, ctx);
      return humanGate('export_quote', { inquiryId: a.inquiryId, kind: a.kind || '客户版' });
    default:
      throw new Error(`未知工具 ${name}`);
  }
}

export const MCP_MANIFEST = () => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  serverInfo: MCP_SERVER_INFO,
  boundary: MCP_BOUNDARY,
  transports: {
    stdio: { command: 'node', args: ['server/mcp.mjs'], env: { QUANTA_MCP_API_BASE: API_BASE() } },
    http: { manifest: '/api/mcp/manifest', call: '/api/mcp/tools/call' },
  },
  tools: MCP_TOOLS,
});
