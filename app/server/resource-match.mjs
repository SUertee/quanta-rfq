import { normalizePartNumber, normalizeUnit, validDate } from './normalization.mjs';

/** Candidate checks are descriptive. Only an explicitly usable candidate may support pricing. */
export function evaluateResource(line, resource, { source, sourceKey, asOf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) } = {}) {
  const checks = [];
  const check = (code, state, message) => checks.push({ code, state, message });
  const compare = (code, requested, supplied, label) => {
    if (!requested || !supplied) check(code, 'unknown', `${label}缺失，需确认`);
    else check(code, requested === supplied ? 'pass' : 'conflict', requested === supplied ? `${label}一致` : `${label}不一致`);
  };
  compare('part_number', normalizePartNumber(line.partNumber), normalizePartNumber(resource.partNumber), '完整件号');
  compare('unit', normalizeUnit(line.uom), normalizeUnit(resource.uom), '单位');
  compare('condition', String(line.condition || '').toUpperCase(), String(resource.stockCondition || resource.condition || '').toUpperCase(), '件状');
  const validQuantity = typeof line.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0;
  if (!validQuantity) check('requested_quantity', 'unknown', '询价数量缺失或无效');
  if (normalizeUnit(line.uom)==='EA' && validQuantity && !Number.isInteger(line.quantity)) check('quantity_precision', 'unknown', '按件计量的数量不是整数，需确认');
  const currency = String(resource.currency || '').toUpperCase();
  check('currency', currency === 'CNY' ? 'pass' : currency ? 'conflict' : 'unknown', currency === 'CNY' ? '人民币计价' : '币种缺失或需要汇率换算');
  const cost = source === 'inventory' ? Number(resource.lastPurchasePrice) || Number(resource.avgCost) : Number(resource.unitPrice);
  check('price', Number.isFinite(cost) && cost > 0 ? 'pass' : 'unknown', Number.isFinite(cost) && cost > 0 ? '价格已提供' : '缺少有效价格');
  if (source === 'inventory') {
    const available = resource.stockQty;
    const state = !validQuantity || available == null || available === '' || !Number.isFinite(Number(available)) ? 'unknown' : Number(available) >= line.quantity ? 'pass' : 'conflict';
    check('quantity', state, state === 'pass' ? '库存满足数量' : state === 'unknown' ? '库存或需求数量未知' : '库存不足，需确认供应能力');
  } else {
    const moq = Number(resource.moq);
    const state = !validQuantity || resource.moq == null || resource.moq === '' || !Number.isFinite(moq) || moq <= 0 ? 'unknown' : line.quantity >= moq ? 'pass' : 'conflict';
    check('moq', state, state === 'pass' ? '满足起订量' : state === 'unknown' ? '起订量或需求数量未知' : '起订量不满足');
    for (const [field, code, label] of [['validFrom', 'valid_from', '生效日期'], ['validUntil', 'valid_until', '有效期']]) {
      const date = resource[field];
      if (!date || !validDate(date)) check(code, 'unknown', `${label}缺失或不明确`);
      else { const valid = field === 'validFrom' ? date.slice(0,10) <= asOf : date.slice(0,10) >= asOf; check(code, valid ? 'pass' : 'conflict', valid ? `${label}满足` : field === 'validFrom' ? '报价尚未生效' : '报价已过期'); }
    }
    check('tax_basis', ['inclusive', 'exclusive'].includes(resource.taxBasis) ? 'pass' : 'unknown', ['inclusive', 'exclusive'].includes(resource.taxBasis) ? '税基已明确' : '税基待确认');
    check('authorization', resource.authorized === true ? 'pass' : 'unknown', resource.authorized === true ? '来源授权已确认' : '来源授权待确认');
  }
  if (line.requirement || line.dueDate) check('requirements', 'unknown', '证书、交期及附加要求需逐项人工确认');
  const state = checks.some(c => c.state === 'conflict') ? 'conflict' : checks.some(c => c.state === 'unknown') ? 'needs_review' : 'usable';
  return { source, sourceKey, matchMethod: 'exact_part_number', state, checks, cost: Number.isFinite(cost) && cost > 0 ? cost : null, asOf, ruleVersion: '1' };
}
