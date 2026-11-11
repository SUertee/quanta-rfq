// B8 定价策略引擎：A1 已定机制——成本底线 + 目标加价率 + 市场参考对标 + 双闸门。
// 默认参数为"演示设定"（docs/A类事项建议与裁决.md），拍板后改默认值即可。
import type { PricedLine } from '../types';
import {calculateQuotePrice} from '../../shared/rfq-rules.mjs';
import { referencePrice } from './pricing';

export interface PricingPolicy {
  /** 目标加价率（成本加成，旧字段名 margin；建议 25%） */
  margin: number;
  /** 毛利下限，按市场参考价出货时低于此值转人工（建议 10%） */
  marginFloor: number;
  /** 整单金额上限 CNY，超过需人工审批（建议 50 万） */
  orderCapCny: number;
  /** 市场溢价提示阈值：目标售价高于市场参考超过此比例时提示（建议 20%） */
  marketPremium: number;
  /** 向客户收取的运费（CNY/单，报价单单列一行；0 = 不收） */
  freightChargeCny: number;
  /** 我方货运成本（CNY/单，进入整单毛利测算，不向客户展示） */
  freightCostCny: number;
  /** 我方货运天数（供应商交期之外送到客户的时间，用于超时剔除） */
  freightDays: number;
  /** 行业/品类关键词：通用报价器定位，用于 AI 估价搜索词与提示词（默认"航空备件"因演示数据是官方航空考题，可改为任意行业） */
  industryKw: string;
  /** A3 件状互认：FN ↔ NE 视为同为新件（其余不互认） */
  condFnNe: boolean;
  /** A4 证书互认：客户注明"或等效"时接受 FAA 8130-3 / EASA Form 1 互认 */
  certMutual: boolean;
  /** A9 真实汇率（CNY per 1 外币）；留空用素材演示汇率 */
  fxUsd?: number;
  fxEur?: number;
  /** 多币种汇率表（币种 → CNY per 1，如 { USD: 6.69, JPY: 0.047 }）；优先于 fxUsd/fxEur */
  fxRates?: Record<string, number>;
  /** 汇率来源/日期备注（审计展示，如"央行中间价 2026-11-01"） */
  fxSource?: string;
  /** B11 运费分摊方式：整单核算 / 按行均摊 / 按金额比例（影响内部毛利测算） */
  freightAlloc: 'order' | 'byLine' | 'byValue';
  /** AOG/加急溢价系数：建议价与底线同乘（默认 10%） */
  aogPremium: number;
  /** 批量折扣率：数量 ≥ bulkQty 时建议价 ×(1−折扣)，底线不动（默认 5%） */
  bulkDiscount: number;
  /** 批量折扣数量门槛（0=不启用） */
  bulkQty: number;
  /** 向客户收取的最低运费（CNY/单，0=不设） */
  minFreightCny: number;
  /** 满额免运费门槛（行项目合计 ≥ 该值则运费 0，0=不启用） */
  freeFreightOverCny: number;
  /** 原流程每单人工分钟数（对照验证用，默认 12） */
  baselineMinutes?: number;
}

export const DEFAULT_POLICY: PricingPolicy = {
  margin: 0.25,
  marginFloor: 0.10,
  orderCapCny: 500000,
  marketPremium: 0.20,
  freightChargeCny: 0,
  freightCostCny: 0,
  freightDays: 3,
  industryKw: '',
  condFnNe: true,
  certMutual: false,
  freightAlloc: 'order',
  aogPremium: 0.10,
  bulkDiscount: 0.05,
  bulkQty: 50,
  minFreightCny: 0,
  freeFreightOverCny: 0,
};

export interface PriceSuggestion {
  /** 成本底线 CNY：最近采购价，无则平均成本 */
  costBase?: number;
  /** 目标售价 = 成本 × (1 + m) ×（加急溢价）×（1−批量折扣） */
  target?: number;
  /** 合理最低报价 = 成本 ×（加急溢价）÷ (1 − 毛利下限)；低于此价不值得报 */
  floor?: number;
  /** 市场参考：最低合规候选价（CNY 折算，演示汇率） */
  marketRef?: number;
  /** 目标价高于市场参考超过阈值 */
  premiumHit: boolean;
  /** 若按市场参考价出货，毛利低于下限 */
  floorHit: boolean;
  /** 本行应用了 AOG/加急溢价 */
  aogApplied: boolean;
  /** 本行应用了批量折扣 */
  bulkApplied: boolean;
}

export function suggestPrice(p: PricedLine, policy: PricingPolicy, manualCost?: number): PriceSuggestion {
  const catalog=p.ruleVersion?p.basisCost:p.cost?(p.cost.lastPurchasePrice||p.cost.avgCost||undefined):undefined;
  const costBase=catalog??(manualCost!=null&&manualCost>0?manualCost:undefined);
  const calculated=calculateQuotePrice(costBase,p.line,{...policy,markupRate:policy.margin});
  const marketRef=referencePrice(p);
  const premiumHit=calculated.target!=null&&marketRef!=null&&marketRef>0&&calculated.target>marketRef*(1+policy.marketPremium);
  const floorHit=marketRef!=null&&marketRef>0&&costBase!=null&&(marketRef-costBase)/marketRef<policy.marginFloor;
  return {...calculated,marketRef,premiumHit,floorHit};
}

/** 向客户收取的运费：免运费门槛 → 最低运费 → 设定值；空单不收 */
export {freightChargeFor} from '../../shared/rfq-rules.mjs';

/** 建议确认价由可用依据和定价规则计算，缺依据时保持空值 */
export function defaultConfirmPrice(s: PriceSuggestion): number | undefined {
  return s.target;
}

/** 毛利率（按确认价与成本底线计算） */
export function marginOf(confirmPrice: number, costBase?: number): number | undefined {
  if (costBase == null || confirmPrice <= 0) return undefined;
  return (confirmPrice - costBase) / confirmPrice;
}

/** Only reprice this task; explicit user prices and skipped lines stay untouched. */
export function repriceBook(priced: PricedLine[], priceBook: Record<string,number>, manualPrices: Set<string>, skipped: Set<string>, policy: PricingPolicy, manualCosts: Record<string,{value:number}>) {
  const next = { ...priceBook }; let kept = 0;
  for (const p of priced) {
    const key=p.line.key;
    if (skipped.has(key)) continue;
    if (manualPrices.has(key) && priceBook[key]!=null) { kept++; continue; }
    const v=defaultConfirmPrice(suggestPrice(p,policy,manualCosts[key]?.value));
    if (v!=null) next[key]=v; else delete next[key];
  }
  return {next,kept};
}
