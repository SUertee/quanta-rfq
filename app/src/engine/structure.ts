import {normalizePartNumber,normalizeUnit} from '../../shared/normalization.mjs';
// S2 结构化：映射官方 16 列 schema、单位归一、件号主号/后缀拆分
import type { EmailSample, InquiryLine, KanbanRow } from '../types';
import type { RawRow } from './parse';

export function splitPn(pn: string): { base: string; suffix: string } {
  const m = pn.match(/^(.*)-ALT$/i);
  return m ? { base: m[1], suffix: '-ALT' } : { base: pn, suffix: '' };
}

/** 单位统一为 EA；IN/FT 记换算系数；无确认映射标"待核"（价格资源表无计量单位字段，不能直接乘） */
export function normalizeUom(uom: string): { norm: string; factor: number | null; issue?: string } {
  const u = normalizeUnit(uom);
  if (u === 'EA' || u === 'Each') return { norm: 'EA', factor: 1 };
  if (u === 'IN' || u === 'FT') return { norm: '待核', factor: null, issue: `单位 ${u} 无确认换算映射，标记待核` };
  if (!u) return { norm: '缺失', factor: null, issue: '单位缺失' };
  return { norm: '待核', factor: null, issue: `未知单位 ${u}` };
}

function finalize(
  partial: Omit<InquiryLine, 'basePn' | 'pnSuffix' | 'uomNormalized' | 'uomFactor' | 'issues'>,
  unitFactor?: number,
): InquiryLine {
  partial={...partial,partNumber:normalizePartNumber(partial.partNumber),condition:partial.condition.trim().toUpperCase()};
  const { base, suffix } = splitPn(partial.partNumber);
  if (unitFactor != null && unitFactor > 0 && (partial.uom === 'IN' || partial.uom === 'FT')) {
    // A2：该件号有确认换算映射 → 归一到 EA 并记录系数
    return { ...partial, basePn: base, pnSuffix: suffix, uomNormalized: 'EA', uomFactor: unitFactor, issues: [] };
  }
  const u = normalizeUom(partial.uom);
  const issues = u.issue ? [u.issue] : [];
  return { ...partial, basePn: base, pnSuffix: suffix, uomNormalized: u.norm, uomFactor: u.factor, issues };
}

export function fromKanban(r: KanbanRow, units?: Record<string, Record<string, number>>): InquiryLine {
  const factor = units?.[r.partNumber]?.[r.uom];
  return finalize({
    key: `kb-${r.rfqId}-${r.lineNo}`,
    source: `看板 ${r.rfqId}`,
    rfqId: r.rfqId,
    inquiryDate: r.inquiryDate,
    customer: r.airline,
    urgency: r.urgency,
    lineNo: r.lineNo,
    partNumber: r.partNumber,
    description: r.description,
    quantity: r.quantity,
    uom: r.uom,
    requirement: r.requirement,
    mpn: r.mpn,
    condition: r.condition,
    manualPn: r.manualPn,
    productScope: r.productScope,
    dueDate: r.dueDate,
  }, factor);
}

export function fromRaw(raw: RawRow, email: EmailSample, units?: Record<string, Record<string, number>>): InquiryLine {
  const rfqNo = (email.subject.match(/RFQ-\d+/) || [email.id])[0];
  const factor = units?.[raw.partNumber ?? '']?.[raw.uom ?? ''];
  const line = finalize({
    key: `${email.id}-${raw.lineNo}`,
    source: `邮件 ${rfqNo}`,
    rfqId: raw.rfqId ?? rfqNo,
    inquiryDate: email.date,
    customer: email.from.replace(/<.*>/, '').trim(),
    urgency: raw.priority ?? '',
    lineNo: raw.lineNo,
    partNumber: raw.partNumber ?? '',
    description: raw.description ?? '',
    quantity: raw.quantity ?? 0,
    uom: raw.uom ?? '',
    requirement: raw.requirement ?? '',
    mpn: raw.mpn ?? '',
    condition: raw.condition ?? '',
    manualPn: raw.manualPn ?? '',
    productScope: raw.productScope ?? '',
    dueDate: raw.dueDate ?? '',
  }, factor);
  line.resourceEvidence=raw.evidence;
  line.needByDate = raw.dueDate ?? undefined; // 邮件 Due Date = 客户要货截止，用于运输时间估算
  line.issues = [...raw.issues, ...line.issues];
  if (raw.llmFixed) line.llmFixedMark = true;
  return line;
}

/** 附件清单（xlsx 直接读表，12 列中文表头） */
export function fromAttachment(
  r: Record<string, string>, caseNo: number, idx: number,
  units?: Record<string, Record<string, number>>,
): InquiryLine {
  const pn = String(r['Part Number'] ?? '');
  const factor = units?.[pn]?.[String(r['Unit Of Measure'] ?? '')];
  return finalize({
    key: `att${caseNo}-${idx}`,
    source: `案例${caseNo} 附件清单`,
    rfqId: String(r['询价单号'] ?? ''),
    inquiryDate: '',
    customer: caseNo === 1 ? '客户A' : '客户D',
    urgency: String(r['优先级'] ?? ''),
    lineNo: idx,
    partNumber: String(r['Part Number'] ?? ''),
    description: String(r['Description'] ?? ''),
    quantity: Number(r['Quantity']) || 0,
    uom: String(r['Unit Of Measure'] ?? ''),
    requirement: String(r['询价产品要求'] ?? ''),
    mpn: String(r['询价MPN'] ?? ''),
    condition: String(r['件状条件'] ?? ''),
    manualPn: String(r['手册件号'] ?? ''),
    productScope: String(r['产品范围'] ?? ''),
    dueDate: String(r['截止报价日期'] ?? ''),
  }, factor);
}
