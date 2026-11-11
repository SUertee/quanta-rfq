import { useEffect, useMemo, useState } from 'react';
import type { Dataset } from '../data';
import type { PriceRow } from '../types';
import { appFetch as fetch } from '../engine/appUrl';
import { fmtMoney } from '../engine/amount';
import { fieldsFor } from '../engine/fieldSchema';
import { Badge, StatCard } from '../components/ui';

const EDITABLE = ['supplierName', 'unitPrice', 'currency', 'condition', 'moq', 'leadDays', 'validFrom', 'validUntil', 'certType', 'taxBasis'] as const;
const NUMERIC = new Set(['unitPrice', 'moq', 'leadDays']);
const LABEL: Record<string, string> = {
  supplierName: '供应商', unitPrice: '单价', currency: '币种', condition: '件状', moq: '起订量',
  leadDays: '交期(天)', validFrom: '生效日期', validUntil: '有效期至', certType: '证书', taxBasis: '税基',
};

/** 价目与依据管理：供应商价格资源可搜索、增删改、含企业自定义字段（extra）。 */
export function PriceResourcesPage({ ds, onRefresh }: { ds: Dataset; onRefresh: () => void }) {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ partNumber: '', supplierName: '', unitPrice: '', currency: 'CNY', condition: '', validUntil: '' });

  const load = async () => {
    try {
      const r = await fetch('/api/price-resources');
      if (!r.ok) throw new Error(`HTTP ${r.status}（后端未启动？）`);
      const j = await r.json();
      setRows(j.prices ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const save = async (row: PriceRow) => {
    try {
      const r = await fetch('/api/price-resources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ row }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 120));
      await load();
      onRefresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const del = async (id: string) => {
    if (!window.confirm(`删除价格资源 ${id}？`)) return;
    await fetch(`/api/price-resources/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await load();
    onRefresh();
  };
  const add = async () => {
    if (!draft.partNumber.trim()) { setErr('件号必填'); return; }
    const id = `PR-${Date.now().toString(36).toUpperCase()}`;
    await save({
      id, partNumber: draft.partNumber.trim(), supplierName: draft.supplierName.trim(),
      unitPrice: Number(draft.unitPrice) || 0, currency: draft.currency || 'CNY',
      condition: draft.condition, validUntil: draft.validUntil,
    } as PriceRow);
    setAdding(false);
    setDraft({ partNumber: '', supplierName: '', unitPrice: '', currency: 'CNY', condition: '', validUntil: '' });
  };

  const filtered = useMemo(() => rows.filter((r) => {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return r.partNumber.toLowerCase().includes(s) || r.supplierName.toLowerCase().includes(s);
  }), [rows, q]);
  const customDefs = fieldsFor(ds.fieldSchema, 'supplier', { customOnly: true });

  const cell = (row: PriceRow, key: typeof EDITABLE[number]) => {
    const value = row[key];
    return (
      <input key={`${row.id}:${key}:${String(value ?? '')}`} className="cell-input" defaultValue={String(value ?? '')}
        type={NUMERIC.has(key) ? 'number' : key.startsWith('valid') ? 'date' : 'text'}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v === String(value ?? '')) return;
          const next = { ...row, [key]: NUMERIC.has(key) ? Number(v) || 0 : v };
          void save(next);
        }} />
    );
  };

  return (
    <div>
      <div className="stat-row">
        <StatCard label="价格资源" value={rows.length} sub="供应商报价依据库" />
        <StatCard label="件号" value={new Set(rows.map((r) => r.partNumber)).size} />
        <StatCard label="自定义字段" value={customDefs.length} />
      </div>
      <div className="panel">
        <div className="panel-title">
          价目与依据
          <input className="search-input" placeholder="搜索件号 / 供应商" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setAdding(!adding)}>+ 新增价格</button>
        </div>
        {err && <div className="hint limitation">{err}</div>}
        <div className="hint">单元格点进去直接改，移开即保存。后端未启动时列表为空，先启动 <code>启动后端.bat</code>。</div>
        {adding && (
          <div className="check-box">
            <div className="toolbar">
              <input className="cell-input" placeholder="件号 *" value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })} />
              <input className="cell-input" placeholder="供应商" value={draft.supplierName} onChange={(e) => setDraft({ ...draft, supplierName: e.target.value })} />
              <input className="cell-input" type="number" placeholder="单价" value={draft.unitPrice} onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })} />
              <input className="cell-input" placeholder="币种" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} style={{ width: 70 }} />
              <input className="cell-input" placeholder="件状" value={draft.condition} onChange={(e) => setDraft({ ...draft, condition: e.target.value })} style={{ width: 70 }} />
              <input className="cell-input" type="date" placeholder="有效期至" value={draft.validUntil} onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })} />
              <button className="btn primary" onClick={add}>保存</button>
            </div>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>件号</th>
              {EDITABLE.map((k) => <th key={k}>{LABEL[k]}</th>)}
              {customDefs.map((d) => <th key={d.key}>{d.label}</th>)}
              <th>操作</th>
            </tr></thead>
            <tbody>
              {filtered.slice(0, 200).map((row) => (
                <tr key={row.id}>
                  <td><b>{row.partNumber}</b><div className="hint" style={{ margin: 0 }}>{row.id}</div></td>
                  {EDITABLE.map((k) => <td key={k}>{cell(row, k)}</td>)}
                  {customDefs.map((d) => (
                    <td key={d.key}>
                      <input key={`${row.id}:extra:${d.key}:${String(row.extra?.[d.key] ?? '')}`} className="cell-input"
                        defaultValue={String(row.extra?.[d.key] ?? '')}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v === String(row.extra?.[d.key] ?? '')) return;
                          void save({ ...row, extra: { ...(row.extra ?? {}), [d.key]: v } });
                        }} />
                    </td>
                  ))}
                  <td><button className="btn" onClick={() => del(row.id)}>删除</button></td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={14} className="empty-cell">暂无价格资源</td></tr>}
            </tbody>
          </table>
        </div>
        {filtered.length > 200 && <div className="hint">共 {filtered.length} 条，仅显示前 200 条，请搜索缩小范围。</div>}
      </div>
    </div>
  );
}
