// 服务端读取企业字段定义：所有进件/供应商抽取与 MCP 工具共用同一份元数据。
import { DEFAULT_SCHEMA, fieldsFor, normalizeSchema } from '../shared/field-schema.mjs';

export function readSchema(db, accountId) {
  if (!accountId) return DEFAULT_SCHEMA;
  try {
    const r = db.exec('SELECT json FROM field_schema WHERE account_id = ?', [accountId]);
    if (r.length && r[0].values.length) return normalizeSchema(JSON.parse(r[0].values[0][0]));
  } catch { /* 表未初始化时回退默认 */ }
  return DEFAULT_SCHEMA;
}

export function writeSchema(db, accountId, schema) {
  if (!accountId) throw Object.assign(new Error('缺少账户上下文'), { status: 400 });
  db.run('INSERT OR REPLACE INTO field_schema (account_id, json) VALUES (?, ?)', [accountId, JSON.stringify(schema)]);
}

/** 把企业字段（自定义 + 内置枚举/显示名）的键/显示名/枚举值并入固定表头别名，实现"合理识别导入" */
export function extendAliases(core, schema, scope) {
  const out = Object.fromEntries(Object.entries(core).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [String(v)]]));
  for (const def of fieldsFor(schema, scope, { stage: 'map' })) {
    const extras = [def.key, def.label, ...(def.options ?? [])].map(String);
    out[def.key] = [...new Set([...(out[def.key] ?? []), ...extras])];
  }
  return out;
}
