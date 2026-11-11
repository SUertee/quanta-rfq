import {accountStorageKey} from './persistence';
// 前端字段引擎门面：规则真源在 shared/field-schema.mjs（前后端共用），
// 这里只负责本机/后端持久化与 TS 类型再导出。
import { appFetch as fetch } from './appUrl';
import {
  DEFAULT_SCHEMA, INDUSTRY_TEMPLATES, allowedUnitsFor, applyTemplate, condAliasesFor,
  conditionCodesFor, conditionRequired, dynamicAliases, fieldsFor, labelOf, normalizeSchema,
  schemaPrompt, splitCustomKeys, validateCustomFields, validateValue,
} from '../../shared/field-schema.mjs';
import type { FieldDef, FieldSchema, FieldScope, FieldType } from '../../shared/field-schema.mjs';

export type { FieldDef, FieldSchema, FieldScope, FieldType };
export {
  DEFAULT_SCHEMA, INDUSTRY_TEMPLATES, allowedUnitsFor, applyTemplate, condAliasesFor,
  conditionCodesFor, conditionRequired, dynamicAliases, fieldsFor, labelOf, schemaPrompt,
  splitCustomKeys, validateCustomFields, validateValue,
};
export { DEFAULT_CERTIFICATES, certificatesFor } from '../../shared/field-schema.mjs';

const LS_KEY = 'rfq-field-schema-v1';

/** 后端优先，失败回退本机；旧存档与默认内置字段合并 */
export async function loadFieldSchema(): Promise<FieldSchema> {
  let saved: FieldSchema | null = null;
  try {
    const r = await fetch('/api/fields', { signal: AbortSignal.timeout(3000) });
    if (r.ok) saved = ((await r.json()) as { schema?: FieldSchema }).schema ?? null;
  } catch { /* 后端未启动 */ }
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(accountStorageKey(LS_KEY)) ?? 'null') as FieldSchema | null; } catch { saved = null; }
  }
  return normalizeSchema(saved);
}

export async function saveFieldSchema(schema: FieldSchema): Promise<{ ok: boolean; local: boolean }> {
  localStorage.setItem(accountStorageKey(LS_KEY), JSON.stringify(schema));
  try {
    const r = await fetch('/api/fields', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema }),
    });
    if (r.ok) return { ok: true, local: false };
  } catch { /* 后端未启动 */ }
  return { ok: true, local: true };
}
