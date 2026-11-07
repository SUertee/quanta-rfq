import {appFetch as fetch} from './appUrl';
// LLM 接入层（B1）：MOI Genesis，OpenAI 兼容协议。
// 分工纪律（15 号文档 §4）：LLM 只做"理解"——语义归一、异常兜底、采购要求解读；
// 产出必须过 schema 校验才允许进入结构化行，不直接落库；算账一律在规则引擎。
import type { RawRow } from './parse';
import type { EstCost, InquiryLine } from '../types';
import { getAiConfig } from './config';
import { searchConfigured, webSearch } from './search';

const cfg = () => getAiConfig().llm;

export const llmConfigured = () => cfg().apiKey.length > 0;

export interface GenesisModel {
  id: string;
  type?: string;
  sub_type?: string;
  capabilities?: string[];
}

/** Query models visible to the current Genesis credential. */
export async function listChatModels(config = cfg()): Promise<GenesisModel[]> {
  if (!config.apiKey) return [];
  const r = await fetch(`${config.baseUrl}/models?type=chat`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`模型列表请求失败 ${r.status}：${(await r.text()).slice(0, 160)}`);
  const j = await r.json() as { data?: GenesisModel[] };
  return (j.data ?? []).filter((m) => m.id && (!m.type || m.type === 'chat'));
}

/** 在线探测：注意必须用够 max_tokens（推理模型会先用 token 思考，给太少会空回复被网关判 502） */
export async function llmPing(config = cfg()): Promise<boolean> {
  if (!config.apiKey) return false;
  try {
    const text = await chat([{ role: 'user', content: '回复 ok' }], 64, config);
    return text.trim().length > 0;
  } catch {
    return false;
  }
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export async function chat(messages: ChatMessage[], maxTokens = 2000, config = cfg()): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`LLM 请求失败 ${r.status}：${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const UOMS = ['EA', 'IN', 'FT', 'Each'];
const PRIOS = ['NOR', 'USR', 'WSP'];

/** schema 校验 + 防幻觉：关键标识符必须在原文中真实出现（实测 LLM 会幻觉出原文没有的 NOR 优先级）。
 *  关键字段（件号/数量）不出现 → 整行弃用；可选字段不出现 → 丢弃该字段保留其余。 */
export function validateLlmRow(j: Record<string, unknown>, raw = ''): Partial<RawRow> | null {
  const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string).trim() : '');
  const inRaw = (v: string) => !raw || !v || raw.includes(v);
  const partNumber = s('partNumber');
  if (!partNumber || !/^[A-Z0-9][A-Z0-9.-]*$/i.test(partNumber) || !inRaw(partNumber)) return null;
  const quantity = Number(j.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || !inRaw(String(j.quantity))) return null;
  const uom = s('uom');
  if (uom && !UOMS.includes(uom)) return null;
  const condition = s('condition');
  // 件状词表（FN/NE/OH/SV）是航空演示数据的取值；通用场景不拒收，仅做短词形态校验
  if (condition && !/^[A-Z]{1,6}$/.test(condition)) return null;
  const priority = s('priority');
  if (priority && !PRIOS.includes(priority)) return null;
  return {
    partNumber,
    quantity,
    description: s('description') || undefined,
    uom: uom || undefined,
    priority: inRaw(priority) ? priority || undefined : undefined,
    requirement: s('requirement') || undefined,
    mpn: inRaw(s('mpn')) ? s('mpn') || undefined : undefined,
    condition: inRaw(condition) ? condition || undefined : undefined,
    manualPn: inRaw(s('manualPn')) ? s('manualPn') || undefined : undefined,
    productScope: s('productScope') || undefined,
    dueDate: inRaw(s('dueDate').slice(0, 10)) ? s('dueDate') || undefined : undefined,
  };
}

/** LLM 语义归一：兜底提取正则切分异常的行。返回 null = 校验未过，保持标黄。 */
export async function llmNormalizeLine(raw: string): Promise<Partial<RawRow> | null> {
  const system = `你是询价单结构化助手（行业无关）。输入是一行"字段连写无分隔"的询价文本，提取字段并只输出一个 JSON 对象，不要任何解释。
字段定义：partNumber(件号，如 PN-0001/AP-2001/MS21042L3), description(英中文描述), quantity(数量，数字), uom(单位，限 EA/IN/FT/Each), priority(优先级 NOR/USR/WSP，无则空串), requirement(产品要求话术，无则空串), mpn(询价MPN，通常是第二个件号), condition(件状 FN/NE/OH/SV，无则空串), manualPn(手册件号，通常是第三件号), productScope(产品范围), dueDate(截止期，格式 YYYY-MM-DD HH:mm，无则空串)。`;
  const text = await chat([{ role: 'system', content: system }, { role: 'user', content: raw }], 800);
  const j = extractJson(text);
  return j ? validateLlmRow(j, raw) : null;
}

/** 纯语料进订单：任意文字（邮件/聊天/扫描件识别文本）→ 结构化订单行。
 *  校验：件号或描述至少一个；缺件号/缺数量进 issues 保持人工核对（不丢行）。
 *  注意 max_tokens 必须给足（推理模型 token 给太少会空回复，实测 2000 会截断，4000 稳定）。 */
export async function llmExtractLines(text: string, industryKw = ''): Promise<RawRow[] | null> {
  const kw = industryKw.trim();
  const system = `你是${kw || '采购'}订单识别助手。用户给一段询价/订单文字（可能来自邮件、聊天记录或扫描件识别文本），提取其中所有物料行，只输出一个 JSON 对象：
{"lines":[{"partNumber":"件号","description":"描述","quantity":0,"uom":"EA/IN/FT/Each或空","condition":"件状或空","mpn":"","manualPn":"","productScope":"","dueDate":"YYYY-MM-DD或空","requirement":"","priority":""}]}
要求：看不清或原文没有的字段留空字符串，不要编造；数量为数字（没有给 0）；只输出 JSON，不要解释。`;
  const out = await chat([{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 12000) }], 4000);
  const j = extractJson(out);
  if (!j || !Array.isArray(j.lines)) return null;
  const rows: RawRow[] = [];
  for (const item of j.lines) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : typeof o[k] === 'number' ? String(o[k]) : '');
    const pn = s('partNumber');
    const desc = s('description');
    if (!pn && !desc) continue;
    const qty = Number(o.quantity);
    const issues: string[] = [];
    if (!pn) issues.push('缺件号');
    if (!Number.isFinite(qty) || qty <= 0) issues.push('缺数量');
    rows.push({
      lineNo: rows.length + 1,
      raw: JSON.stringify(o),
      partNumber: pn || undefined,
      description: desc || undefined,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : undefined,
      uom: s('uom') || undefined,
      priority: s('priority') || undefined,
      requirement: s('requirement') || undefined,
      mpn: s('mpn') || undefined,
      condition: s('condition') || undefined,
      manualPn: s('manualPn') || undefined,
      productScope: s('productScope') || undefined,
      dueDate: s('dueDate') || undefined,
      issues,
    });
  }
  return rows.length ? rows : null;
}

/** AI 字段映射：导入表头任意命名 → 目标字段/自定义键/忽略。容忍空字段。
 *  校验：映射值必须在目标字段内、或 custom: 前缀英文键、或空串，否则按未映射处理。 */
export async function llmMapColumns(headers: string[], targetFields: readonly string[]): Promise<Record<string, string> | null> {
  const system = `你是数据字段映射助手。把导入表格的每个表头映射到目标字段之一；对不上但值得保留的给 "custom:英文小写键"；无利用价值的给空串 ""。
只输出一个 JSON 对象 {表头: 映射值}，不要解释。目标字段：${targetFields.join(', ')}。表头可能有缺失、空列或中英文混合。`;
  const text = await chat([{ role: 'system', content: system }, { role: 'user', content: `表头列表：${JSON.stringify(headers)}` }], 800);
  const j = extractJson(text);
  if (!j) return null;
  const out: Record<string, string> = {};
  for (const h of headers) {
    const v = typeof j[h] === 'string' ? (j[h] as string).trim() : '';
    if (targetFields.includes(v) || /^custom:[a-zA-Z][a-zA-Z0-9_]*$/.test(v) || v === '') out[h] = v;
    else out[h] = '';
  }
  return out;
}

/** 非标品 AI 市场估价：目录查不到件号时，估算市场采购成本（CNY/件）。
 *  优先用联网搜索取证（混元），搜索不可用退回经验估算；输出带依据、人工确认后才生效。 */
export async function llmEstimatePrice(line: InquiryLine, industryKw = ''): Promise<EstCost | null> {
  const kw = industryKw.trim();
  const query = `${kw ? `${kw} ` : ''}${line.partNumber} ${line.description} 采购价格 报价`;
  let searchCtx = '';
  let hits = 0;
  let refs: { title: string; url: string }[] = [];
  if (searchConfigured()) {
    try {
      const s = await webSearch(query);
      if (s?.text) {
        searchCtx = s.text.slice(0, 1800);
        hits = s.items.length;
        refs = s.items.slice(0, 3).map((it) => ({ title: it.title, url: it.url }));
      }
    } catch {
      searchCtx = ''; // 搜索失败退回经验估算（判定会如实标注"纯经验估算"）
    }
  }
  const system = `你是${kw || '工业品'}采购价格分析师，熟悉该行业物料的市场行情。
根据物料信息估算其全新件市场采购成本（人民币元/件），只输出一个 JSON 对象，不要解释：
{"estCostCny": 数字, "verdict": "有市场依据|有间接参考|纯经验估算", "basis": "一句话估价依据", "limitation": "证据局限（外币/渠道/批量/时效等，没有则空串）"}
判定规则：搜索资料中有同件号或同规格的真实报价 → 有市场依据；只有相近品类的价格 → 有间接参考；没有可用市场信息 → 纯经验估算。
要求：估的是采购成本而非售价；不要拒绝，不要输出文字说明。${searchCtx ? `\n以下是从互联网搜索到的市场信息，优先采用其中有据可查的价格：\n${searchCtx}` : '\n（本次未取得任何市场搜索资料，只能凭经验估算）'}`;
  const user = `件号：${line.partNumber || '未知'}；描述：${line.description || '未知'}；数量：${line.quantity} ${line.uom}；件状要求：${line.condition || '未指定'}；产品范围：${line.productScope || '未指定'}`;
  const text = await chat([{ role: 'system', content: system }, { role: 'user', content: user }], 700);
  const j = extractJson(text);
  if (!j) return null;
  const v = Number(j.estCostCny);
  if (!Number.isFinite(v) || v <= 0 || v > 10_000_000) return null; // 数值合理性门禁
  const VERDICTS = ['有市场依据', '有间接参考', '纯经验估算'] as const;
  const verdict = VERDICTS.find((x) => x === j.verdict) ?? (searchCtx ? '有间接参考' : '纯经验估算');
  return {
    value: Math.round(v * 100) / 100,
    source: 'ai',
    basis: (typeof j.basis === 'string' ? j.basis.trim().slice(0, 200) : '') || '',
    verdict,
    limitation: typeof j.limitation === 'string' && j.limitation.trim() ? j.limitation.trim().slice(0, 200) : undefined,
    refs: refs.length ? refs : undefined,
    trace: [{ query, hits }],
  };
}

/** 理解层：汇总采购方要求（证书/替代件/交期/件状/风险点）。只做展示，不参与算账。 */
export async function llmSummarizeRequirements(
  lines: { partNumber: string; requirement: string; condition: string; dueDate: string; quantity: number; uom: string }[],
  industryKw = '',
): Promise<string> {
  const system = `你是${industryKw.trim() || '采购'}分析助手。根据询价行数据，用中文分条总结：①采购方提出的明确要求（证书、替代件、包装、交期、件状等）②需要人工注意的风险点。不超过 8 条，每条一行，以"- "开头。不要编造数据中没有的信息。`;
  const brief = lines
    .slice(0, 60)
    .map((l) => `${l.partNumber} ${l.quantity}${l.uom} 件状:${l.condition || '空'} 要求:${l.requirement || '无'} 截止:${l.dueDate || '无'}`)
    .join('\n');
  return chat(
    [{ role: 'system', content: system }, { role: 'user', content: `共 ${lines.length} 行询价，样本如下：\n${brief}` }],
    1200,
  );
}
