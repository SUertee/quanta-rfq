// S3 匹配与核价：件号三级匹配 + 双来源取价 + 条件筛查标黄（规则见 15 号文档 §3 S3）
import type { Dataset } from '../data';
import type { FlagCode, InquiryLine, PriceCandidate, PricedLine, PriceRow } from '../types';
import { splitPn } from './structure';

export const FLAG_META: Record<FlagCode, { label: string; yellow: boolean }> = {
  NO_MATCH: { label: '三级匹配未命中', yellow: true },
  UNIT_UNMAPPED: { label: '单位待核', yellow: true },
  COND_MISMATCH: { label: '件状不匹配（不擅自认定可互换）', yellow: true },
  COND_EMPTY: { label: '件状空值', yellow: true },
  MOQ_SHORTAGE: { label: '询价数量低于 MOQ', yellow: true },
  EXPIRED: { label: '价格已过期（按业务日期重算，不信状态标签）', yellow: true },
  CERT_MISMATCH: { label: '证书要求不匹配', yellow: true },
  PARSE_ISSUE: { label: '解析异常，需人工核对', yellow: true },
  LATE_DELIVERY: { label: '全部候选交期+货运超出需求日期', yellow: true },
  FX_DEMO: { label: '外币按演示汇率折算（非财务授权汇率）', yellow: false },
  PRICE_PENDING: { label: '售价口径未确认，待人工定价', yellow: false },
};

/** 解析各种日期写法为 YYYY-MM-DD；失败返回 '' */
function toDateStr(v: string): string {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const t = Date.parse(v);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

const addDays = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const todayStr = () => new Date().toISOString().slice(0, 10);

export const isYellow = (p: PricedLine) => p.flags.some((f) => FLAG_META[f].yellow);

/** 任务业务日期：用截止报价日期（无则询价日期）重算有效期 */
function bizDate(line: InquiryLine): string {
  return (line.dueDate || line.inquiryDate || '').slice(0, 10);
}

const CERT_NEED = /(FAA|8130|EASA|Form\s*1|CERT)/i;

/** A3：件状互认（FN↔NE 同为新件；其余不互认） */
function condCompatible(a: string, b: string, fnNe: boolean): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const pair = new Set([a, b]);
  return fnNe && pair.has('FN') && pair.has('NE');
}

function candidateFlags(
  line: InquiryLine,
  row: PricedLine['candidates'][number]['row'],
  bd: string,
  opts: PriceOpts = {},
): FlagCode[] {
  const f: FlagCode[] = [];
  if (bd && row.validUntil && row.validUntil.slice(0, 10) < bd) f.push('EXPIRED');
  if (!row.condition || !line.condition) f.push('COND_EMPTY');
  else if (!condCompatible(line.condition, row.condition, opts.condFnNe ?? true)) f.push('COND_MISMATCH');
  if (line.quantity > 0 && line.quantity < row.moq) f.push('MOQ_SHORTAGE');
  if (CERT_NEED.test(line.requirement)) {
    const cert = row.certType || '';
    const needFaa = /FAA|8130/i.test(line.requirement);
    const needEasa = /EASA/i.test(line.requirement);
    const orEquivalent = /或等效|等价|equivalent/i.test(line.requirement);
    const mismatch = (needFaa && !/FAA|8130/i.test(cert)) || (needEasa && !/EASA/i.test(cert)) || (!cert);
    // A4：仅当开关打开且客户注明"或等效"时，FAA/EASA 互认放行
    const mutualOk = opts.certMutual && orEquivalent && cert !== '';
    if (mismatch && !mutualOk) f.push('CERT_MISMATCH');
  }
  if (row.currency && row.currency !== 'CNY') f.push('FX_DEMO');
  return f;
}

export interface PriceOpts {
  /** 我方货运天数（供应商交期之外，送到客户的时间），用于超时剔除 */
  freightDays?: number;
  /** A3：FN↔NE 件状互认 */
  condFnNe?: boolean;
  /** A4：证书互认（客户注明"或等效"时放行） */
  certMutual?: boolean;
  /** A9：真实汇率覆盖（币种 → CNY per 1 外币）；缺省用演示汇率 */
  fxOverride?: Record<string, number>;
}

export function priceLine(line: InquiryLine, ds: Dataset, opts: PriceOpts = {}): PricedLine {
  const flags = new Set<FlagCode>();
  let matchLevel: PricedLine['matchLevel'] = 0;
  let cost: PricedLine['cost'];
  let rows: Dataset['prices'] = [];

  // 三级匹配：Part Number → 询价MPN → 手册件号（记录命中级别）
  const keys = [line.basePn, line.mpn, line.manualPn]
    .filter(Boolean)
    .map((k) => splitPn(k).base);
  for (let i = 0; i < keys.length && !matchLevel; i++) {
    const c = ds.costIdx.get(keys[i]);
    const pr = ds.priceIdx.get(keys[i]) ?? [];
    if (c || pr.length) { matchLevel = (i + 1) as PricedLine['matchLevel']; cost = c; rows = pr; }
  }
  if (!matchLevel) flags.add('NO_MATCH');
  if (line.uomNormalized === '待核' || line.uomNormalized === '缺失') flags.add('UNIT_UNMAPPED');
  if (line.issues.length) flags.add('PARSE_ISSUE');

  const bd = bizDate(line);
  const fxOf = (row: PriceRow) => opts.fxOverride?.[row.currency] ?? row.fxToCny ?? 1;
  const candidates: PriceCandidate[] = rows.map((row) => ({
    row,
    cnyPrice: Math.round(row.unitPrice * fxOf(row) * 100) / 100,
    flags: candidateFlags(line, row, bd, opts),
  }));

  // A7 排序：合规先行 → 现货优先 → AOG/USR 按交期、常规按价低 → 原厂破平局（全部展示，不隐藏）
  const yellow = (c: PriceCandidate) => (c.flags.some((f) => FLAG_META[f].yellow) ? 1 : 0);
  candidates.sort((a, b) => {
    if (yellow(a) !== yellow(b)) return yellow(a) - yellow(b);
    const stockA = a.row.inStock === '是' ? 0 : 1;
    const stockB = b.row.inStock === '是' ? 0 : 1;
    if (stockA !== stockB) return stockA - stockB;
    const urgent = line.urgency === 'AOG' || line.urgency === 'USR' || line.urgency === 'URGENT';
    if (urgent && a.row.leadDays !== b.row.leadDays) return a.row.leadDays - b.row.leadDays;
    if (!urgent && a.cnyPrice !== b.cnyPrice) return a.cnyPrice - b.cnyPrice;
    const oemA = a.row.supplierType === '原厂' ? 0 : 1;
    const oemB = b.row.supplierType === '原厂' ? 0 : 1;
    return oemA - oemB;
  });

  // 超时剔除：业务时点 + 交期 + 货运天数 > 需求日期 → 剔除（不参与报价，保留展示）
  const freight = opts.freightDays ?? 0;
  const needBy = toDateStr(line.needByDate ?? '');
  const bizStart = toDateStr(line.inquiryDate) || todayStr();
  const kept: PriceCandidate[] = [];
  const excluded: PriceCandidate[] = [];
  for (const c of candidates) {
    if (needBy && addDays(bizStart, c.row.leadDays + freight) > needBy) excluded.push(c);
    else kept.push(c);
  }

  // 行级标黄：全部候选都踩同一陷阱才上收到行级
  if (kept.length) {
    (['EXPIRED', 'COND_MISMATCH', 'COND_EMPTY', 'MOQ_SHORTAGE', 'CERT_MISMATCH'] as const).forEach((code) => {
      if (kept.every((c) => c.flags.includes(code))) flags.add(code);
    });
  } else if (excluded.length) {
    flags.add('LATE_DELIVERY'); // 有资源但全部超时
  } else if (matchLevel > 0) {
    flags.add('NO_MATCH'); // 成本表命中但无外部资源价
  }
  flags.add('PRICE_PENDING'); // 售价口径：规则未确认前一律人工确认

  return { line, matchLevel, cost, candidates: kept, excluded, flags: [...flags] };
}

export function priceAll(lines: InquiryLine[], ds: Dataset, opts: PriceOpts = {}): PricedLine[] {
  return lines.map((l) => priceLine(l, ds, opts));
}

/** 合规候选：无任何黄标陷阱的候选价 */
export const cleanCandidates = (p: PricedLine) =>
  p.candidates.filter((c) => !c.flags.some((f) => FLAG_META[f].yellow));

/** 草稿参考价：最低合规候选 CNY 价；无合规候选则 undefined（草稿显式标黄，不自动填估计值） */
export function referencePrice(p: PricedLine): number | undefined {
  const ok = cleanCandidates(p);
  if (!ok.length) return undefined;
  return Math.min(...ok.map((c) => c.cnyPrice));
}

export function stats(priced: PricedLine[]) {
  const total = priced.length;
  const matched = priced.filter((p) => p.matchLevel > 0).length;
  const quotable = priced.filter((p) => !isYellow(p)).length;
  const byLevel = [0, 1, 2, 3].map((l) => priced.filter((p) => p.matchLevel === l).length);
  return { total, matched, quotable, byLevel };
}
