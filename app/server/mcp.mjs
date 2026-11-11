// Quanta Personal Agent MCP server（stdio JSON-RPC 2.0）。
// 用法：node server/mcp.mjs（由 IDE / Claude Desktop / 个人 Agent 通过 stdio 拉起）。
// 日志一律走 stderr，stdout 只输出 JSON-RPC 消息；写意图工具返回人工确认载荷，不落库。
// 多账户：env QUANTA_MCP_TOKEN 必填（账户令牌），initialize 时用 /api/auth/me 解析身份；失败则 tools/call 一律"未授权"。
import readline from 'node:readline';
import { MCP_PROTOCOL_VERSION, MCP_SERVER_INFO, MCP_BOUNDARY, MCP_TOOLS, callMcpTool } from './mcp-tools.mjs';

const API_BASE = () => (process.env.QUANTA_MCP_API_BASE || 'http://127.0.0.1:3004').replace(/\/$/, '');
let ctxPromise = null;
function resolveCtx() {
  ctxPromise ??= (async () => {
    const token = process.env.QUANTA_MCP_TOKEN;
    if (!token) return null;
    try {
      const r = await fetch(API_BASE() + '/api/auth/me', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const me = await r.json();
      if (!me?.id) return null;
      return { token, accountId: me.id, role: me.role, name: me.displayName || me.username };
    } catch { return null; }
  })();
  return ctxPromise;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;
  // 通知类消息没有 id，不回复
  if (method?.startsWith('notifications/')) return;
  try {
    switch (method) {
      case 'initialize':
        void resolveCtx();
        ok(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: MCP_SERVER_INFO, instructions: MCP_BOUNDARY });
        break;
      case 'ping':
        ok(id, {});
        break;
      case 'tools/list':
        ok(id, { tools: MCP_TOOLS });
        break;
      case 'tools/call': {
        const ctx = await resolveCtx();
        if (!ctx) { ok(id, { content: [{ type: 'text', text: JSON.stringify({ error: '未授权：请配置有效的 QUANTA_MCP_TOKEN' }) }], isError: true }); break; }
        const name = params?.name;
        const args = params?.arguments ?? {};
        const result = await callMcpTool(name, args, ctx);
        ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
        break;
      }
      case 'resources/list':
        ok(id, { resources: [
          { uri: 'quanta://fields', name: '企业字段定义', mimeType: 'application/json' },
          { uri: 'quanta://health', name: '服务状态', mimeType: 'application/json' },
        ] });
        break;
      case 'resources/read': {
        const ctx = await resolveCtx();
        if (!ctx) { err(id, -32000, '未授权：请配置有效的 QUANTA_MCP_TOKEN'); break; }
        const uri = params?.uri;
        const data = uri === 'quanta://fields' ? await callMcpTool('quanta_list_fields', {}, ctx)
          : uri === 'quanta://health' ? await callMcpTool('quanta_health', {}, ctx)
            : null;
        if (!data) { err(id, -32602, `未知资源 ${uri}`); break; }
        ok(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] });
        break;
      }
      default:
        err(id, -32601, `不支持的方法 ${method}`);
    }
  } catch (e) {
    if (method === 'tools/call') {
      ok(id, { content: [{ type: 'text', text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true });
    } else err(id, -32000, e instanceof Error ? e.message : String(e));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch { /* 非法 JSON 忽略，MCP 客户端会重发 */ }
});
process.stderr.write('Quanta MCP personal-agent bridge ready (stdio)\n');
