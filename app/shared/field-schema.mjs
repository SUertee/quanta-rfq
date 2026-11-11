// 企业字段定义的唯一真源：前端 UI、后端进件/供应商抽取、MCP 工具共用。
// 内置字段不可删除；自定义字段由企业在设置页定义，存 SQLite field_schema 表。

const b = (key, label, scope, type) => ({ key, label, scope, type, builtin: true, mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: false });

export const DEFAULT_FIELDS = [
  b('rfqId', '询价单号', 'inquiry', 'text'), b('partNumber', '件号', 'inquiry', 'text'),
  b('description', '描述', 'inquiry', 'text'), b('quantity', '数量', 'inquiry', 'number'),
  b('uom', '单位', 'inquiry', 'text'), b('priority', '优先级', 'inquiry', 'text'),
  b('requirement', '产品要求', 'inquiry', 'text'), b('mpn', 'MPN', 'inquiry', 'text'),
  b('condition', '件状', 'inquiry', 'text'), b('manualPn', '手册件号', 'inquiry', 'text'),
  b('productScope', '产品范围', 'inquiry', 'text'), b('dueDate', '待确认日期', 'inquiry', 'date'),
  b('needByDate', '到货日期', 'inquiry', 'date'), b('quoteDeadline', '报价截止日期', 'inquiry', 'date'),
  b('partNumber', '件号', 'inventory', 'text'), b('description', '描述', 'inventory', 'text'),
  b('productScope', '产品范围', 'inventory', 'text'), b('uom', '单位', 'inventory', 'text'),
  b('stockQty', '库存数量', 'inventory', 'number'), b('warehouse', '仓库', 'inventory', 'text'),
  b('stockCondition', '件状', 'inventory', 'text'), b('stdCost', '标准成本', 'inventory', 'number'),
  b('avgCost', '平均成本', 'inventory', 'number'), b('lastPurchasePrice', '近采价', 'inventory', 'number'),
  b('currency', '币种', 'inventory', 'text'),
  b('supplierName', '供应商', 'supplier', 'text'), b('unitPrice', '单价', 'supplier', 'number'),
  b('currency', '币种', 'supplier', 'text'), b('moq', '起订量', 'supplier', 'number'),
  b('leadDays', '交期', 'supplier', 'number'), b('validFrom', '生效日期', 'supplier', 'date'),
  b('validUntil', '有效期', 'supplier', 'date'), b('certType', '证书', 'supplier', 'text'),
  b('taxBasis', '税基', 'supplier', 'text'),
];

// 内置字段的默认规则：件状词表/互认矩阵、单位词表。企业可在设置页改，示范案例默认与航空数据兼容。
DEFAULT_FIELDS.find(f => f.scope === 'inquiry' && f.key === 'condition').options = ['FN', 'NE', 'OH', 'SV', 'AR', 'NS'];
DEFAULT_FIELDS.find(f => f.scope === 'inquiry' && f.key === 'condition').aliases = [['FN', 'NE']];
DEFAULT_FIELDS.find(f => f.scope === 'inquiry' && f.key === 'uom').options = ['EA', 'IN', 'FT', 'Each'];

export const DEFAULT_SCHEMA = { version: 1, industry: '通用', fields: DEFAULT_FIELDS };

export const INDUSTRY_TEMPLATES = {
  '通用': { label: '通用（仅内置字段）', fields: [] },
  '航空备件': { label: '航空备件（适航件状/证书）', fields: [
    { key: 'airworthiness', label: '适航放行文件', scope: 'inquiry', type: 'enum', options: ['FAA 8130-3', 'EASA Form 1', 'CoC', '无需'], mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'traceability', label: '追溯/序列要求', scope: 'inquiry', type: 'text', mapTarget: true, aiExtract: true, exportVisible: true },
  ] },
  '食品与生鲜': { label: '食品与生鲜（保质期/批次/冷链）', fields: [
    { key: 'productionDate', label: '生产日期', scope: 'inquiry', type: 'date', mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'shelfLifeDays', label: '保质期(天)', scope: 'inquiry', type: 'number', min: 0, mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'expiryDate', label: '保质期至', scope: 'inquiry', type: 'date', mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'lotNo', label: '批次号', scope: 'inquiry', type: 'text', required: true, mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'storageTemp', label: '贮存条件', scope: 'inquiry', type: 'enum', options: ['常温', '冷藏 0~4℃', '冷冻 -18℃', '阴凉干燥'], mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'foodLicense', label: '食品生产许可证/SC', scope: 'supplier', type: 'text', mapTarget: true, aiExtract: true, exportVisible: true },
    { key: 'allergen', label: '过敏原', scope: 'inquiry', type: 'text', mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
  ] },
  '工业贸易': { label: '工业贸易（税基/授权/包装）', fields: [
    { key: 'taxBasis', label: '含税口径', scope: 'inquiry', type: 'enum', options: ['含税', '未税'], mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'brand', label: '品牌', scope: 'inquiry', type: 'text', mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'packSpec', label: '包装规格', scope: 'inquiry', type: 'text', mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
    { key: 'origin', label: '产地', scope: 'inquiry', type: 'text', mapTarget: true, aiExtract: true, exportVisible: true, customerVisible: true },
  ] },
};

/** 旧存档/后端数据与内置字段合并；自定义字段原样保留 */
export function normalizeSchema(saved) {
  if (!saved || !Array.isArray(saved.fields)) return DEFAULT_SCHEMA;
  const custom = saved.fields.filter((f) => !f.builtin);
  const builtin = DEFAULT_FIELDS.map((f) => {
    const override = saved.fields.find((x) => x.builtin && x.key === f.key && x.scope === f.scope);
    return override ? { ...f, ...override, builtin: true } : f;
  });
  return { version: 1, industry: saved.industry || '通用', fields: [...builtin, ...custom], certificates: saved.certificates };
}

/** 模板合并：保留企业已有自定义字段，模板按 key+scope 覆盖 */
export function applyTemplate(schema, industry) {
  const tpl = INDUSTRY_TEMPLATES[industry]?.fields || [];
  const custom = normalizeSchema(schema).fields.filter((f) => !f.builtin).map((f) => ({ ...f }));
  for (const t of tpl) {
    const i = custom.findIndex((f) => f.key === t.key && f.scope === t.scope);
    if (i >= 0) custom[i] = { ...custom[i], ...t };
    else custom.push({ ...t });
  }
  const base = normalizeSchema(schema);
  return { ...base, industry, fields: [...base.fields.filter((f) => f.builtin), ...custom] };
}

export function fieldsFor(schema, scope, opt = {}) {
  const all = normalizeSchema(schema).fields.filter((f) => f.scope === scope && (!opt.customOnly || !f.builtin));
  if (opt.stage === 'map') return all.filter((f) => f.mapTarget !== false);
  if (opt.stage === 'ai') return all.filter((f) => f.aiExtract !== false);
  if (opt.stage === 'export') return all.filter((f) => f.exportVisible !== false);
  if (opt.stage === 'customer') return all.filter((f) => f.customerVisible === true);
  return all;
}

export function labelOf(schema, key) {
  return normalizeSchema(schema).fields.find((f) => f.key === key)?.label || key;
}

/** 表头别名：企业字段键、显示名、枚举值都成为可识别表头 */
export function dynamicAliases(schema, scope) {
  const out = {};
  for (const f of fieldsFor(schema, scope, { stage: 'map' })) {
    for (const s of [f.key, f.label, ...(f.options || [])]) {
      const k = String(s).trim().toLowerCase();
      if (k && !out[k]) out[k] = f.key;
    }
  }
  return out;
}

export function validateValue(def, value) {
  const v = value == null ? '' : String(value).trim();
  const issues = [];
  if (!v) { if (def.required) issues.push(`${def.label}必填`); return issues; }
  if (def.type === 'number') {
    const n = Number(v.replace(/,/g, ''));
    if (!Number.isFinite(n)) issues.push(`${def.label}不是数字`);
    else {
      if (def.min != null && n < def.min) issues.push(`${def.label}小于 ${def.min}`);
      if (def.max != null && n > def.max) issues.push(`${def.label}大于 ${def.max}`);
    }
  } else if (def.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) issues.push(`${def.label}日期格式应为 YYYY-MM-DD`);
  } else if (def.type === 'enum' && def.options?.length && !def.options.includes(v)) {
    issues.push(`${def.label}不在允许值内`);
  } else if (def.type === 'bool' && !['是', '否', 'true', 'false', '1', '0'].includes(v.toLowerCase())) {
    issues.push(`${def.label}应为是/否`);
  }
  if (def.pattern && v) {
    try { if (!new RegExp(def.pattern).test(v)) issues.push(`${def.label}格式不符`); } catch { /* ignore */ }
  }
  return issues;
}

export function validateCustomFields(schema, scope, values) {
  const out = [];
  for (const def of fieldsFor(schema, scope, { customOnly: true })) out.push(...validateValue(def, values?.[def.key]));
  return out;
}

/** 给 LLM 的字段清单：自定义字段自动成为提取目标 */
export function schemaPrompt(schema, scope) {
  return fieldsFor(schema, scope, { stage: 'ai' }).map((f) => {
    const type = f.type === 'number' ? '数字' : f.type === 'date' ? 'YYYY-MM-DD' : f.type === 'enum' ? `枚举[${(f.options || []).join('/')}]` : '文本';
    return `${f.key}(${f.label}，${type}${f.required ? '，必填' : '，无则空串'})`;
  }).join('; ');
}

export function customFieldDefs(schema, scope) {
  return fieldsFor(schema, scope, { customOnly: true, stage: 'ai' });
}

/** A1：件状是否必填由字段定义决定；默认 true 保持既有行为，企业可关闭 */
export function conditionRequired(schema) {
  return normalizeSchema(schema).fields.find((f) => f.scope === 'inquiry' && f.key === 'condition')?.required ?? true;
}

/** A2：单位词表由字段定义驱动，默认 EA/IN/FT/Each（kg/L/箱等企业可自行加进 uom.options） */
export function allowedUnitsFor(schema) {
  const def = normalizeSchema(schema).fields.find((f) => f.scope === 'inquiry' && f.key === 'uom');
  return def?.options?.length ? def.options : ['EA', 'IN', 'FT', 'Each'];
}

/** A4：件状互认矩阵（默认仅 FN↔NE，企业可编辑为 condAliases） */
export function condAliasesFor(schema, condAliases) {
  if (Array.isArray(condAliases)) return condAliases;
  const def = normalizeSchema(schema).fields.find((f) => f.scope === 'inquiry' && f.key === 'condition');
  return def?.aliases ?? [];
}

/** A4：件状词表 = 字段枚举值 ∪ 互认矩阵两端，供解析正则使用（默认 FN/NE/OH/SV） */
export function conditionCodesFor(schema, condAliases) {
  const def = normalizeSchema(schema).fields.find((f) => f.scope === 'inquiry' && f.key === 'condition');
  const codes = new Set(def?.options ?? ['FN', 'NE', 'OH', 'SV']);
  for (const pair of condAliasesFor(schema, condAliases)) for (const c of pair) if (c) codes.add(c);
  return [...codes];
}

/** A3：证书类型与要求词表（可由企业在 schema.certificates 配置；默认 FAA/EASA/CoC） */
export const DEFAULT_CERTIFICATES = [
  { name: 'FAA 8130-3', pattern: 'FAA|8130' },
  { name: 'EASA Form 1', pattern: 'EASA|Form\\s*1' },
  { name: 'CoC', pattern: '\\bCoC\\b|合格证' },
];
export function certificatesFor(schema) {
  return Array.isArray(schema?.certificates) && schema.certificates.length ? schema.certificates : DEFAULT_CERTIFICATES;
}

/** 把一行拆分内置字段/自定义字段 */
export function splitCustomKeys(schema, scope, row) {
  const builtin = new Set(fieldsFor(schema, scope).filter((f) => f.builtin).map((f) => f.key));
  const core = {}, custom = {};
  for (const [k, v] of Object.entries(row)) (builtin.has(k) ? core : custom)[k] = v;
  return { core, custom };
}
