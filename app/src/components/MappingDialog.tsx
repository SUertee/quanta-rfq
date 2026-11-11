import { useState } from 'react';
import { autoMapHeaders, fieldLabel, getMappingMemory, saveMappingMemory, targetFieldsFor, type ImportSheet } from '../engine/import';
import { llmConfigured, llmMapColumns } from '../engine/llm';
import type { FieldSchema, FieldScope } from '../engine/fieldSchema';

/** 通用字段映射面板：任意 xlsx 表头 → 企业定义的目标字段/忽略/自定义键；AI 可识别不完美匹配的表头 */
export function MappingDialog({
  title, sheet, targetFields, onConfirm, onClose, error, busy = false, schema, scope = 'inventory',
}: {
  error?: string; busy?: boolean;
  title: string;
  sheet: ImportSheet;
  targetFields?: readonly string[];
  schema?: FieldSchema;
  scope?: FieldScope;
  onConfirm: (mapping: Record<string, string>) => void;
  onClose: () => void;
}) {
  const fields = schema ? targetFieldsFor(schema, scope) : [...(targetFields ?? [])];
  const label = (key: string) => (schema ? fieldLabel(schema, key) : (key));
  const [mapping, setMapping] = useState<Record<string, string>>(() => getMappingMemory(sheet.headers) ?? autoMapHeaders(sheet.headers, fields, schema, scope));
  const [note, setNote] = useState(getMappingMemory(sheet.headers) ? '已按上次同格式文件的映射自动填好（映射记忆），可直接确认或微调。' : '');
  const [mapBusy, setMapBusy] = useState(false);

  const aiMap = async () => {
    setMapBusy(true);
    try {
      const unmapped = sheet.headers.filter((h) => !mapping[h]);
      const ai = await llmMapColumns(unmapped.length ? unmapped : sheet.headers, fields);
      if (ai) { setMapping((m) => ({ ...m, ...ai })); setNote('AI 映射完成，请核对后导入。'); } else setNote('AI 未返回有效映射，请手动选择字段。');
    } catch (e) { setNote(`AI 映射失败：${e instanceof Error ? e.message : String(e)}。可手动选择字段。`); }
    setMapBusy(false);
  };

  const selectedFields = Object.values(mapping).filter(Boolean);
  const duplicates = selectedFields.filter((f, i) => selectedFields.indexOf(f) !== i);
  const hasPart = selectedFields.includes('partNumber');
  const [rememberMapping,setRememberMapping]=useState(true);
  const mappedCount = Object.values(mapping).filter(Boolean).length;

  return (
    <div className="modal-mask" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">
          {title}（{sheet.rows.length} 行）
          {llmConfigured() && (
            <button className="btn" disabled={mapBusy} onClick={aiMap}>
              {mapBusy ? 'AI 识别中…' : 'AI 识别字段映射'}
            </button>
          )}
        </div>
        <div className="mapping-summary"><span>{mappedCount}/{sheet.headers.length} 列已映射</span><label><input type="checkbox" checked={rememberMapping} onChange={e=>setRememberMapping(e.target.checked)} />记住此映射</label></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>表头</th><th>样例值</th><th>映射到</th></tr></thead>
            <tbody>
              {sheet.headers.map((h) => (
                <tr key={h}>
                  <td><b>{h || '（空表头）'}</b></td>
                  <td>{sheet.rows[0]?.[h] ?? ''}</td>
                  <td>
                    <select aria-label={`${h} 映射到`} disabled={mapBusy} value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}>
                      <option value="">— 忽略 —</option>
                      {fields.map((f) => <option key={f} value={f}>{label(f)}</option>)}
                      {mapping[h]?.startsWith('custom:') && <option value={mapping[h]}>{mapping[h]}（AI 自定义）</option>}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <p role="alert" className="margin-low">{error}</p>}
        {note && <p role="status" className="hint">{note}</p>}
        {!hasPart && <p role="alert">缺少件号映射</p>}
        {duplicates.length > 0 && <p role="alert">存在重复映射，请保留一个来源列</p>}
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={!mappedCount || !hasPart || duplicates.length > 0 || mapBusy || busy} onClick={() => { if(rememberMapping)saveMappingMemory(sheet.headers, mapping); onConfirm(mapping); }}>
            导入 {sheet.rows.length} 行
          </button>
          <button className="btn" disabled={busy} onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
