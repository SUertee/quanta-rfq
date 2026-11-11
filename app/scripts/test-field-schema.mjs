// 企业字段定义驱动服务端抽取：表头别名、自定义字段落行、必填校验、供应商报价 extra。
import assert from 'node:assert/strict';
import { DEFAULT_SCHEMA, INDUSTRY_TEMPLATES, applyTemplate, normalizeSchema, validateValue } from '../shared/field-schema.mjs';
import { extractStructured, hasUnmappedText } from '../server/intake-extract.mjs';
import { extractSupplierRows } from '../server/supplier-import.mjs';

const food = applyTemplate(DEFAULT_SCHEMA, '食品与生鲜');
assert.ok(INDUSTRY_TEMPLATES['食品与生鲜'].fields.some((f) => f.key === 'shelfLifeDays'));
assert.equal(food.industry, '食品与生鲜');
assert.ok(food.fields.some((f) => f.key === 'lotNo' && f.required));
assert.equal(normalizeSchema({ industry: '自定义', fields: [] }).fields.length, DEFAULT_SCHEMA.fields.length);
assert.deepEqual(validateValue({ label: '批次号', type: 'text', required: true }, ''), ['批次号必填']);
assert.deepEqual(validateValue({ label: '保质期天数', type: 'number', min: 0 }, -3), ['保质期天数小于 0']);

// 进件表格：企业自定义表头（显示名）自动识别，值进 customFields 并按定义校验
const inquiryChunks = [
  { id: 'c1', fileId: 'f1', text: 'Part Number\t数量\t批次号\t生产日期', cells: ['Part Number', '数量', '批次号', '生产日期'], locator: { sheet: 'S1', row: 1 } },
  { id: 'c2', fileId: 'f1', text: 'PN-0001\t10\tLOT-9\t2026-11-01', cells: ['PN-0001', '10', 'LOT-9', '2026-11-01'], locator: { sheet: 'S1', row: 2 } },
];
const structured = extractStructured(inquiryChunks, food);
assert.equal(structured.lines.length, 1);
assert.equal(structured.lines[0].customFields.lotNo, 'LOT-9');
assert.equal(structured.lines[0].customFields.productionDate, '2026-11-01');
assert.ok(!structured.lines[0].issues.includes('批次号必填'));
assert.equal(hasUnmappedText('批次号: LOT-9', { 0: 'LOT-9' }, food), false, '自定义表头不再被当成未识别正文');
assert.equal(hasUnmappedText('批次号: LOT-9', { 0: 'LOT-9' }, DEFAULT_SCHEMA), true, '缺字段定义时该表头仍是未识别正文');

// 缺必填批次号必须显式进 issues，不静默放行
const missingChunks = [inquiryChunks[0], { ...inquiryChunks[1], id: 'c3', cells: ['PN-0002', '5', '', '2026-11-01'], text: 'PN-0002\t5\t\t2026-11-01' }];
const missing = extractStructured(missingChunks, food);
assert.ok(missing.lines[0].issues.includes('批次号必填'));

// 供应商报价表格：自定义列进入 values.extra，随确认流程落 price_resource
const supplierChunks = [
  { id: 's1', text: 'Part Number\t单价\t供应商\t食品生产许可证/SC', cells: ['Part Number', '单价', '供应商', '食品生产许可证/SC'], locator: { sheet: 'Q1', row: 1 } },
  { id: 's2', text: 'PN-0001\t12.5\t华润\tSC123456', cells: ['PN-0001', '12.5', '华润', 'SC123456'], locator: { sheet: 'Q1', row: 2 } },
];
const supplier = extractSupplierRows(supplierChunks, food);
assert.equal(supplier.rows.length, 1);
assert.equal(supplier.rows[0].values.extra.foodLicense, 'SC123456');
assert.equal(supplier.rows[0].values.partNumber, 'PN-0001');

// 通用（无自定义字段）时行为与旧版一致
const plain = extractSupplierRows(supplierChunks, DEFAULT_SCHEMA);
assert.equal(plain.rows[0].values.extra, undefined);

console.log('PASS: enterprise field schema drives intake/supplier extraction, aliases, validation and extra persistence');
