// 通用化回归：件状必填开关、单位/件状词表、互认矩阵、证书词表、默认行业词、客户版条款。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import {
  DEFAULT_SCHEMA, allowedUnitsFor, certificatesFor, condAliasesFor,
  conditionCodesFor, conditionRequired, normalizeSchema,
} from '../shared/field-schema.mjs';
import { normalizeLine } from '../shared/normalization.mjs';
import { evaluateResource } from '../shared/rfq-rules.mjs';
import { extendAliases } from '../server/field-schema-store.mjs';

const patch = (schema, key, extra) => ({ ...schema, fields: schema.fields.map((f) => (f.scope === 'inquiry' && f.key === key ? { ...f, ...extra } : f)) });
let generic = patch(DEFAULT_SCHEMA, 'condition', { required: false, options: ['新货', '临期', '常温', '冷藏'], aliases: [['新货', 'FN'], ['常温', '冷藏']], customerVisible: false });
generic = patch(generic, 'uom', { options: ['EA', 'kg', 'L', '箱', '托'] });

// A1：件状不必填时，normalizeLine 不再产生"缺件状"
assert.equal(conditionRequired(DEFAULT_SCHEMA), true);
assert.equal(conditionRequired(generic), false);
const noCond = normalizeLine({ partNumber: 'PN-1', quantity: 2, uom: 'EA', condition: null }, { requireCondition: conditionRequired(generic) });
assert.ok(!noCond.issues.includes('缺件状'));
assert.ok(normalizeLine({ partNumber: 'PN-1', quantity: 2, uom: 'EA', condition: null }).issues.includes('缺件状'));

// A2：单位词表与件状词表来自字段定义
assert.deepEqual(allowedUnitsFor(generic), ['EA', 'kg', 'L', '箱', '托']);
assert.ok(conditionCodesFor(generic, condAliasesFor(generic)).includes('新货'));
assert.ok(!conditionCodesFor(generic, condAliasesFor(generic)).includes('OH'));
assert.equal(extendAliases({ uom: ['单位'] }, generic, 'inquiry').uom.includes('kg'), true);

// A2/A4：脏数据解析按企业件状词表，不写死 FN/NE/OH/SV
const parseBuilt = await build({ entryPoints: ['src/engine/parse.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const parse = await import(`data:text/javascript;base64,${Buffer.from(parseBuilt.outputFiles[0].text).toString('base64')}`);
const row = parse.parseDirtyLine('9000000001PN-0001WASHER 垫片8EAPN-0001常温PN-0001一般询价2026-11-01 10:00:00', 1,
  { conditionCodes: conditionCodesFor(generic, condAliasesFor(generic)), requireCondition: false });
assert.equal(row.condition, '常温');

// A3：证书词表由企业配置，SC/检疫等非航空证书同样可判定
const food = { ...generic, certificates: [{ name: 'SC 食品生产许可证', pattern: 'SC\\d+|食品生产许可' }, { name: '检疫证', pattern: '检疫' }] };
assert.equal(certificatesFor(food).length, 2);
const baseLine = { partNumber: 'PN-1', quantity: 2, uom: 'EA', condition: 'FN', requirement: '需提供 SC 食品生产许可证' };
const baseRes = { partNumber: 'PN-1', uom: 'EA', stockCondition: 'FN', lastPurchasePrice: 10, avgCost: 10, stockQty: 100, currency: 'CNY', certType: 'SC123456' };
const passed = evaluateResource(baseLine, baseRes, { source: 'inventory', certificates: certificatesFor(food) });
assert.equal(passed.checks.find((c) => c.code === 'certificate').state, 'pass');
const failed = evaluateResource(baseLine, { ...baseRes, certType: 'ISO9001' }, { source: 'inventory', certificates: certificatesFor(food) });
assert.equal(failed.checks.find((c) => c.code === 'certificate').state, 'conflict');
const custom = evaluateResource({ ...baseLine, condition: '常温' }, { ...baseRes, stockCondition: '冷藏' },
  { source: 'inventory', certificates: certificatesFor(food), condAliases: [['常温', '冷藏']] });
assert.equal(custom.checks.find((c) => c.code === 'condition').state, 'pass');
assert.equal(evaluateResource({ ...baseLine, condition: '常温' }, { ...baseRes, stockCondition: '冷藏' },
  { source: 'inventory', certificates: certificatesFor(food), condAliases: [] }).checks.find((c) => c.code === 'condition').state, 'conflict');

// A5：客户版件状列与条款名由企业配置决定
const exportBuilt = await build({ entryPoints: ['src/engine/export.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const exporter = await import(`data:text/javascript;base64,${Buffer.from(exportBuilt.outputFiles[0].text).toString('base64')}`);
let blob;
globalThis.document = { body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) };
URL.createObjectURL = (value) => { blob = value; return 'blob:test'; };
globalThis.setTimeout = () => 0;
const priced = [{ line: { key: 'k', partNumber: 'PN-1', description: '物料', quantity: 2, uom: 'EA', condition: 'FN', customer: 'QA' }, flags: [], candidates: [], matchLevel: 1 }];
const ctx = (schema, company) => ({ taskLabel: 'QA', priceBook: { k: 10 }, policy: { freightChargeCny: 0 }, company, resolved: new Set(), skipped: new Set(), manualCost: {}, schema });
exporter.exportCustomerHtml(priced, ctx(generic, { name: 'QA', warrantyLabel: '保质期', warrantyNew: '9', warrantyOh: '', validityDays: '30' }));
let html = await blob.text();
assert.ok(!html.includes('<th>件状</th>'), '企业关闭客户可见后不出现件状列');
assert.ok(html.includes('保质期：9 个月'));
assert.ok(!html.includes('翻修件'));
const visible = patch(generic, 'condition', { customerVisible: true });
exporter.exportCustomerHtml(priced, ctx(visible, { name: 'QA', warrantyLabel: '质保期', warrantyNew: '12', warrantyOh: '6', validityDays: '30' }));
html = await blob.text();
assert.ok(html.includes('<th>件状</th>'));
assert.ok(html.includes('质保期：12 个月'));

// A6：默认行业关键词不再锁航空
const policyText = fs.readFileSync(new URL('../src/engine/pricingPolicy.ts', import.meta.url), 'utf8');
assert.ok(/industryKw:\s*''/.test(policyText), '默认行业词必须为空');
const settingsText = fs.readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8');
assert.ok(settingsText.includes('内置规则') && settingsText.includes('证书规则'));
// A7：评测列随真值与企业字段定义动态生成
const evalText = fs.readFileSync(new URL('../src/engine/evaluate.ts', import.meta.url), 'utf8');
assert.ok(evalText.includes('evalFieldsFor') && evalText.includes('ds.fieldSchema'));
assert.ok(normalizeSchema({ industry: '自定义', fields: [] }).fields.length === DEFAULT_SCHEMA.fields.length);

console.log('PASS: generic condition/unit/certificate/alias rules, configurable customer clauses, industry-neutral defaults');
