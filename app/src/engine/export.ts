// B5/B13 文件导出：内部版 CSV（Excel 直接打开）+ 客户版 HTML（可打印/另存 PDF）+ 供应商询价单 CSV。
// 不引第三方库；均为 UTF-8 BOM 文本，Excel 打开不乱码。
import type { PricedLine } from '../types';
import { FLAG_META, referencePrice } from './pricing';
import { fmtMoney, toChineseUpper } from './amount';
import type { PricingPolicy } from './pricingPolicy';
import { freightChargeFor } from './pricingPolicy';
import type { CompanyInfo } from './company';
import { validUnitPrice } from './quoteValidation';
import { FLAG_PLAIN } from '../plain';

export interface ExportCtx {
  taskLabel: string;
  priceBook: Record<string, number>;
  policy: PricingPolicy;
  company: CompanyInfo;
  resolved: Set<string>;
  /** 暂不报价的行（进客户版附录"待报价清单"，不进报价合计） */
  skipped: Set<string>;
  manualCost: Record<string, { value: number; source: string; basis?: string }>;
}

/** 统一确认出口（工作台与智能体共用）：每行必须是 已定价且无未决标黄 / 已标"暂不报价" 之一 */
export function quoteGate(
  priced: PricedLine[],
  priceBook: Record<string, number>,
  resolved: Set<string>,
  skipped: Set<string>,
): { ok: boolean; blocked: PricedLine[]; unpriced: PricedLine[]; quotable: PricedLine[]; pending: PricedLine[] } {
  const yellow = (p: PricedLine) => p.flags.some((f) => FLAG_META[f].yellow);
  const pending = priced.filter((p) => skipped.has(p.line.key));
  const active = priced.filter((p) => !skipped.has(p.line.key));
  const blocked = active.filter((p) => yellow(p) && !resolved.has(p.line.key));
  const unpriced = active.filter((p) => !blocked.includes(p) && !validUnitPrice(priceBook[p.line.key]));
  const quotable = active.filter((p) => validUnitPrice(priceBook[p.line.key]));
  return { ok: active.length > 0 && blocked.length === 0 && unpriced.length === 0, blocked, unpriced, quotable, pending };
}

/** A8：MOQ 不足时按 MOQ 实报数量 */
export function quoteQtyOf(p: PricedLine): { qty: number; moqNote: string } {
  if (!p.flags.includes('MOQ_SHORTAGE')) return { qty: p.line.quantity, moqNote: '' };
  // A supplier MOQ does not increase a quote fulfilled by matching internal stock.
  if (p.cost && p.cost.partNumber === p.line.partNumber && p.cost.uom === p.line.uom && p.cost.stockCondition === p.line.condition && p.cost.stockQty >= p.line.quantity) return { qty:p.line.quantity,moqNote:'' };
  const clean = p.candidates.filter((c) => !c.flags.some((f) => FLAG_META[f].yellow));
  const pool = clean.length ? clean : p.candidates;
  const moq = Math.min(...pool.map((c) => c.row.moq || 0).filter((m) => m > 0));
  if (!Number.isFinite(moq) || moq <= p.line.quantity) return { qty: p.line.quantity, moqNote: '' };
  return { qty: moq, moqNote: `按供应商 MOQ ${moq} 实报` };
}

export const orderTotalOf = (priced: PricedLine[], ctx: ExportCtx): number => {
  const items = priced.filter(p => !ctx.skipped.has(p.line.key)).reduce((s, p) => {
    const price = ctx.priceBook[p.line.key];
    return price != null ? s + price * quoteQtyOf(p).qty : s;
  }, 0);
  return Math.round((items + freightChargeFor(items, ctx.policy)) * 100) / 100;
};

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** 内部版：含成本/依据/匹配级别/标黄处理记录（含暂不报价行） */
export function exportInternalCsv(priced: PricedLine[], ctx: ExportCtx): void {
  const head = ['任务', '件号', '描述', '询价数量', '实报数量', '单位', '确认单价', '金额', '成本底线', '毛利率',
    '匹配级别', '交期(天)', '件状', '状态', '标黄原因', 'AI估价判定', 'AI估价依据', '人工核对', 'MOQ说明'];
  const lines = [head.map(csvCell).join(',')];
  const LEVEL = ['未命中', 'L1件号', 'L2 MPN', 'L3 手册件号'];
  for (const p of priced) {
    const price = ctx.priceBook[p.line.key];
    const q = quoteQtyOf(p);
    const best = p.candidates[0];
    const yellow = p.flags.filter((f) => FLAG_META[f].yellow);
    const est = ctx.manualCost[p.line.key];
    lines.push([
      ctx.taskLabel, p.line.partNumber, p.line.description, p.line.quantity, q.qty, p.line.uom,
      price ?? '', price != null ? Math.round(price * q.qty * 100) / 100 : '',
      p.cost?.lastPurchasePrice ?? est?.value ?? '', price != null && price > 0 && (p.cost?.lastPurchasePrice ?? est?.value) != null ? `${((price - (p.cost?.lastPurchasePrice ?? est!.value)) / price * 100).toFixed(1)}%` : '',
      LEVEL[p.matchLevel], best?.row.leadDays ?? '', p.line.condition,
      ctx.skipped.has(p.line.key) ? '暂不报价' : ctx.resolved.has(p.line.key) ? '已核对' : yellow.length ? '需核对' : '可报价',
      yellow.map((f) => FLAG_PLAIN[f]).join('；'),
      est?.basis ? (est.source === 'ai' ? `估价(${est.value})` : `人工(${est.value})`) : '',
      est?.basis ?? '',
      ctx.resolved.has(p.line.key) ? '是' : '否', q.moqNote,
    ].map(csvCell).join(','));
  }
  const total = orderTotalOf(priced.filter((p) => !ctx.skipped.has(p.line.key)), ctx);
  lines.push(['运费', '', '', '', '', '', '', freightChargeFor(priced.filter((p) => !ctx.skipped.has(p.line.key)).reduce((s, p) => s + (ctx.priceBook[p.line.key] ?? 0) * quoteQtyOf(p).qty, 0), ctx.policy)].map(csvCell).join(','));
  lines.push(['整单合计', '', '', '', '', '', '', total].map(csvCell).join(','));
  download(`${ctx.taskLabel || '报价'}_内部版.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** 客户版：报价单 HTML（浏览器打印/另存 PDF）。
 *  不含任何内部成本；暂不报价行不进合计，列附录"待报价清单"（整张需求不漏项，未报价项有下一步）。 */
export function exportCustomerHtml(priced: PricedLine[], ctx: ExportCtx): void {
  const c = ctx.company;
  const active = priced.filter((p) => !ctx.skipped.has(p.line.key));
  const pending = priced.filter((p) => ctx.skipped.has(p.line.key));
  const rows = active.map((p, i) => {
    const price = ctx.priceBook[p.line.key];
    const q = quoteQtyOf(p);
    return `<tr>
      <td>${i + 1}</td><td>${esc(p.line.description)}</td><td>${esc(p.line.partNumber)}</td>
      <td>${q.qty}${q.moqNote ? `<br><small>${esc(q.moqNote)}</small>` : ''}</td><td>${esc(p.line.uom)}</td>
      <td>${price != null ? price.toFixed(2) : '待确认'}</td>
      <td>${price != null ? (price * q.qty).toFixed(2) : '待确认'}</td>
      <td>${esc(p.line.condition)}</td></tr>`;
  }).join('');
  const pendingRows = pending.map((p, i) => `<tr>
      <td>${i + 1}</td><td>${esc(p.line.description)}</td><td>${esc(p.line.partNumber)}</td>
      <td>${p.line.quantity} ${esc(p.line.uom)}</td><td>价格待确认，将尽快另行报价</td></tr>`).join('');
  const items = active.reduce((s, p) => {
    const price = ctx.priceBook[p.line.key];
    return price != null ? s + price * quoteQtyOf(p).qty : s;
  }, 0);
  const freight = freightChargeFor(items, ctx.policy);
  const total = Math.round((items + freight) * 100) / 100;
  const today = new Date().toISOString().slice(0, 10);

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>报价单 ${esc(ctx.taskLabel)}</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;color:#1c2434;max-width:900px;margin:32px auto;line-height:1.7}
h1{text-align:center;letter-spacing:10px;font-size:24px}
.meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 24px;font-size:13px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #bbb;padding:6px 8px;text-align:left}
th{background:#f0f3f9}
.sum{margin:14px 0;font-weight:600;line-height:2}
.foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px 24px;font-size:13px;margin-top:28px}
.no-print{margin:20px auto;text-align:center}
@media print{.no-print{display:none}body{margin:0}}
</style></head><body>
<h1>报 价 单</h1>
<div class="meta">
  <span>需方：${esc(priced[0]?.line.customer ?? '')}</span>
  <span>供方：${esc(c.name || '________')}</span>
  <span>报价日期：${today}</span>
</div>
<div class="meta"><span>地址：${esc(c.address || '________')}</span><span>联系人：${esc(c.contact || '________')}</span><span>统一社会信用代码：${esc(c.creditCode || '________')}</span></div>
<table><thead><tr><th>序号</th><th>名称</th><th>规格型号</th><th>数量</th><th>单位</th><th>单价(元)</th><th>金额(元)</th><th>件状</th></tr></thead>
<tbody>${rows}</tbody></table>
${pending.length ? `
<h3 style="margin-top:22px">待报价清单（不在本次报价范围内）</h3>
<table><thead><tr><th>序号</th><th>名称</th><th>规格型号</th><th>数量</th><th>说明</th></tr></thead>
<tbody>${pendingRows}</tbody></table>` : ''}
<div class="sum">
  <div>行项目合计：${fmtMoney(Math.round(items * 100) / 100)}</div>
  <div>运费：${fmtMoney(freight)}</div>
  <div>合计（小写）：${fmtMoney(total)}　合计（大写）：${toChineseUpper(total)}</div>
</div>
<div class="foot">
  <span>交货时间：合同约定</span>
  <span>质保期：新件 ${esc(c.warrantyNew)} 个月 / 翻修件 ${esc(c.warrantyOh)} 个月</span>
  <span>报价有效期：${esc(c.validityDays)} 天</span>
</div>
<div class="foot"><span>供方盖章：________</span><span>授权签字：________</span></div>
<div class="no-print"><button onclick="window.print()">打印 / 另存为 PDF</button></div>
</body></html>`;

  download(`${ctx.taskLabel || '报价'}_客户版.html`, html, 'text/html;charset=utf-8');
}

/** B13：非标品供应商询价单（CSV，发给供应商询价用） */
export function exportSupplierRfqCsv(priced: PricedLine[], ctx: ExportCtx): void {
  const rows = priced.filter((p) => p.flags.includes('NO_MATCH'));
  const head = ['询价单号', '件号', '描述', '数量', '单位', '件状要求', '产品要求', '需求日期', '备注'];
  const lines = [head.map(csvCell).join(',')];
  for (const p of rows) {
    lines.push([
      ctx.taskLabel, p.line.partNumber, p.line.description, p.line.quantity, p.line.uom,
      p.line.condition, p.line.requirement, p.line.dueDate, '请报含税含运最优价与交期',
    ].map(csvCell).join(','));
  }
  download(`${ctx.taskLabel || '询价'}_供应商询价单.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/** 客户可见价：确认价 → 无则不导出 */
export const priceOf = (p: PricedLine, ctx: ExportCtx) => ctx.priceBook[p.line.key] ?? referencePrice(p);
