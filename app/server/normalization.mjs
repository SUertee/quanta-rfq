/** Shared, conservative normalization. Part suffixes and condition distinctions are preserved. */
export const NORMALIZATION_VERSION = '1';
export const DOCUMENT_TYPES = ['customer_inquiry', 'supplier_quote', 'inventory', 'certificate', 'unknown'];
export const normalizePartNumber = value => String(value ?? '').trim().toUpperCase();
export function normalizeUnit(value) {
  const unit = String(value ?? '').normalize('NFKC').trim().toUpperCase();
  return ({ EACH: 'EA', PCS: 'EA', PIECE: 'EA', PIECES: 'EA' })[unit] || unit;
}
export function normalizeLine(value, { contentId = value.contentId, method = value.method || 'unknown', locator = value.locator } = {}) {
  const fields = { ...value };
  const rawFields = value.rawFields || Object.fromEntries(Object.entries(value).filter(([key]) => !['issues', 'raw', 'locator', 'contentId', 'method', 'normalizationVersion', 'fieldSources'].includes(key)));
  fields.partNumber = normalizePartNumber(value.partNumber) || null;
  fields.uom = normalizeUnit(value.uom) || null;
  fields.condition = String(value.condition ?? '').trim().toUpperCase() || null;
  fields.quantity = normalizeQuantity(value.quantity);
  const issues = (value.issues || []).filter(issue => !['缺件号', '缺少有效数量', '缺单位', '缺件状', '日期格式不明确，需人工确认', '按件计量的数量不是整数，需确认'].includes(issue));
  if (!fields.partNumber) issues.push('缺件号');
  if (fields.quantity === null) issues.push('缺少有效数量');
  if (fields.uom === 'EA' && fields.quantity !== null && !Number.isInteger(fields.quantity)) issues.push('按件计量的数量不是整数，需确认');
  if (!fields.uom) issues.push('缺单位');
  if (!fields.condition) issues.push('缺件状');
  if (fields.dueDate && !validDate(fields.dueDate)) issues.push('日期格式不明确，需人工确认');
  const fieldSources = { ...value.fieldSources };
  for (const key of ['partNumber', 'description', 'quantity', 'uom', 'condition', 'requirement', 'dueDate', 'mpn']) {
    if (value[key] != null && !fieldSources[key]) fieldSources[key] = { contentId, locator: locator || {}, method };
  }
  return { ...fields, issues, rawFields, fieldSources, normalizationVersion: NORMALIZATION_VERSION };
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return false;
  if (value.length > 10 && !Number.isFinite(new Date(value.replace(' ', 'T')).getTime())) return false;
  const day = value.slice(0, 10);
  const parsed = new Date(day + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function normalizeQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(text)) return null;
  if (/^[1-9]\d{0,2}\.\d{3}$/.test(text)) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}
