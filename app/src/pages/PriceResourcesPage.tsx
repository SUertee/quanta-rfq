import { useEffect, useMemo, useState } from 'react';
import type { Dataset } from '../data';
import type { PriceRow } from '../types';
import { appFetch as fetch } from '../engine/appUrl';
import { fmtMoney } from '../engine/amount';
import { fieldsFor } from '../engine/fieldSchema';
import { Badge, FilterTabs, RecordToolbar, DataTable } from '../components/ui';
import { Modal } from '../components/Modal';
import './price-resources.css';

type Resource = PriceRow & { account_id?: string; account_name?: string };
const FIELDS = [
  ['partNumber', '件号', 'text'], ['supplierName', '供应商', 'text'],
  ['unitPrice', '采购单价', 'number'], ['currency', '币种', 'text'],
  ['uom', '单位', 'text'], ['condition', '件状', 'text'],
  ['moq', '最小起订量', 'number'], ['leadDays', '交期天数', 'number'],
  ['validFrom', '生效日期', 'date'], ['validUntil', '有效期至', 'date'],
  ['certType', '证书类型', 'text'], ['taxBasis', '计税口径', 'text'],
] as const;
const NUMERIC = new Set(['unitPrice', 'moq', 'leadDays']);

function expired(row: Resource) {
  const date = row.validUntil?.slice(0, 10);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return Boolean(date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today);
}

export function PriceResourcesPage({ ds, onRefresh }: { ds: Dataset; onRefresh: () => void }) {
  const [rows, setRows] = useState<Resource[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'expired'>('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Resource | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const customDefs = fieldsFor(ds.fieldSchema, 'supplier', { customOnly: true });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/price-resources');
      if (!response.ok) throw new Error('报价列表读取失败，请重试');
      const data = await response.json();
      setRows(data.prices ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : '报价列表读取失败，请重试'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => rows.filter(row => {
    if (filter === 'expired' && !expired(row)) return false;
    const search = q.trim().toLowerCase();
    return !search || `${row.partNumber} ${row.supplierName ?? ''}`.toLowerCase().includes(search);
  }), [rows, q, filter]);

  function edit(row?: Resource) {
    setFormError('');
    setEditor(row ? { ...row, extra: { ...row.extra } } : { id: crypto.randomUUID(), currency: 'CNY' } as Resource);
  }

  async function save() {
    if (!editor || saving) return;
    if (!editor.partNumber?.trim()) { setFormError('请填写件号'); return; }
    if (!Number.isFinite(editor.unitPrice) || editor.unitPrice < 0) { setFormError('请填写零或正数的采购单价'); return; }
    if ([editor.moq, editor.leadDays].some(value => value != null && (!Number.isFinite(value) || value < 0))) { setFormError('起订量和交期应填写零或正数'); return; }
    if (editor.validFrom && editor.validUntil && editor.validFrom.slice(0, 10) > editor.validUntil.slice(0, 10)) { setFormError('有效期至应晚于或等于生效日期'); return; }
    setSaving(true);
    setFormError('');
    try {
      const response = await fetch('/api/price-resources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row: { ...editor, partNumber: editor.partNumber.trim() }, accountId: editor.account_id }),
      });
      if (!response.ok) throw new Error('保存失败，请检查填写内容并重试');
      setEditor(null);
      await load();
      onRefresh();
    } catch (e) { setFormError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  }

  async function confirmDelete() {
    if (!deleteTarget || saving) return;
    setSaving(true);
    setFormError('');
    try {
      const response = await fetch(`/api/price-resources/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('删除失败，请重试');
      setDeleteTarget(null);
      await load();
      onRefresh();
    } catch (e) { setFormError(e instanceof Error ? e.message : '删除失败，请重试'); }
    finally { setSaving(false); }
  }

  return <div className="page-prices">
    <div className="page-heading"><h1>价目与依据</h1></div>
    <RecordToolbar filters={<FilterTabs label="供应商报价筛选" value={filter} onChange={setFilter} items={[
      { value: 'all', label: '全部报价', count: rows.length },
      { value: 'expired', label: '已过期', count: rows.filter(expired).length },
    ]} />}>
      <input className="search-input" aria-label="搜索件号或供应商" placeholder="搜索件号、供应商" value={q} onChange={e => setQ(e.target.value)} />
      <button className="btn primary" onClick={() => edit()}>新增报价</button>
    </RecordToolbar>
    {error && <div className="price-error" role="alert">{error}<button className="btn" onClick={() => void load()}>重试</button></div>}
    <div className="panel price-records" aria-busy={loading}>
      {loading ? <div className="price-loading" role="status"><span className="price-spinner" /><span>读取报价中</span></div> : <DataTable
        rows={filtered} rowKey={row => row.id}
        cols={[
          { title: '件号', w: '17%', render: row => <strong>{row.partNumber}</strong> },
          { title: '供应商', w: '22%', render: row => <span className="price-supplier">{row.supplierName || '—'}</span> },
          { title: '采购单价', render: row => <span className="price-amount">{row.currency || '—'} {Number.isFinite(row.unitPrice) ? fmtMoney(row.unitPrice) : '—'}</span> },
          { title: '件状', render: row => row.condition || '—' },
          { title: '起订量', render: row => row.moq == null ? '—' : `${row.moq}${row.uom ? ` ${row.uom}` : ''}` },
          { title: '交期', render: row => row.leadDays == null ? '—' : `${row.leadDays} 天` },
          { title: '有效期至', render: row => <span className="price-validity">{row.validUntil?.slice(0, 10) || '—'}{expired(row) && <Badge text="已过期" tone="amber" />}</span> },
          { title: '操作', render: row => <div className="price-row-actions"><button className="btn" onClick={() => edit(row)}>编辑</button><button className="btn" onClick={() => { setFormError(''); setDeleteTarget(row); }}>删除</button></div> },
        ]}
      />}
    </div>
    {editor && <Modal title={rows.some(row => row.id === editor.id) ? '编辑供应商报价' : '新增供应商报价'} className="price-editor" busy={saving} onClose={() => setEditor(null)}>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset className="price-fieldset" disabled={saving}>
          <div className="dialog-fields price-fields">
            {FIELDS.map(([key, label, type]) => <label key={key}>{label}<input
              type={type} autoFocus={key === 'partNumber'} required={key === 'partNumber' || key === 'unitPrice'}
              min={type === 'number' ? 0 : undefined} step={key === 'unitPrice' ? 'any' : undefined}
              value={String(editor[key] ?? '').slice(0, type === 'date' ? 10 : undefined)}
              onChange={e => setEditor({ ...editor, [key]: NUMERIC.has(key) ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value })}
            /></label>)}
            {customDefs.map(def => <label key={def.key}>{def.label}<input value={String(editor.extra?.[def.key] ?? '')} onChange={e => setEditor({ ...editor, extra: { ...editor.extra, [def.key]: e.target.value } })} /></label>)}
          </div>
        </fieldset>
        {formError && <p className="price-form-error" role="alert">{formError}</p>}
        <footer className="app-dialog-actions"><button type="button" className="btn" disabled={saving} onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={saving} type="submit">{saving ? '保存中…' : '保存报价'}</button></footer>
      </form>
    </Modal>}
    {deleteTarget && <Modal title="删除供应商报价" busy={saving} onClose={() => setDeleteTarget(null)}>
      <p>确认删除 {deleteTarget.partNumber} 的{deleteTarget.supplierName || '供应商'}报价？</p>
      {formError && <p className="price-form-error" role="alert">{formError}</p>}
      <footer className="app-dialog-actions"><button className="btn" disabled={saving} onClick={() => setDeleteTarget(null)}>取消</button><button className="btn primary" disabled={saving} onClick={() => void confirmDelete()}>{saving ? '删除中…' : '确认删除'}</button></footer>
    </Modal>}
  </div>;
}
