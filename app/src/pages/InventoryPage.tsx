import {appFetch as fetch} from '../engine/appUrl';
import { useRef, useState } from 'react';
import type { Dataset } from '../data';
import type { CostRow } from '../types';
import { fmtMoney } from '../engine/amount';
import { applyMapping, numericFieldsFor, readSheetFile, type ImportSheet } from '../engine/import';
import { splitCustomKeys, fieldsFor } from '../engine/fieldSchema';
import { Badge, FilterTabs, RecordToolbar, RecordPagination } from '../components/ui';
import { MappingDialog } from '../components/MappingDialog';

const NUMERIC = new Set(['stockQty', 'stdCost', 'avgCost', 'lastPurchasePrice']);
const EDITABLE = ['description', 'stockQty', 'uom', 'lastPurchasePrice', 'currency', 'warehouse', 'stockCondition', 'productScope', 'avgCost', 'stdCost'] as const;
const FIELD_LABEL: Record<string, string> = {
  description: '描述', productScope: '产品范围', uom: '单位', stockQty: '库存数量',
  warehouse: '仓库', stockCondition: '件状', stdCost: '标准成本', avgCost: '平均成本',
  lastPurchasePrice: '近采价', currency: '币种',
};

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 150));
  return r.json();
}

/** 库存管理：后端 SQLite 增删改全字段 + 扩展字段 + xlsx 导入（AI 认表头）；
 *  后端未启动时降级为演示数据，仅库存数量会话内可改。 */
export function InventoryPage({
  ds, overrides, onChange, onReset, onRefresh,
}: {
  ds: Dataset;
  overrides: Record<string, number>;
  onChange: (pn: string, qty: number | null) => void;
  onReset: () => void;
  onRefresh: () => void;
}) {
  const backend = ds.inventoryBackend;
  const [q, setQ] = useState('');
  const [stockFilter,setStockFilter]=useState<'all'|'zero'>('all');
  const [page,setPage]=useState(1);
  const [err, setErr] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CostRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newRow, setNewRow] = useState({ partNumber: '', description: '', stockQty: '', warehouse: '' });
  const [sheet, setSheet] = useState<ImportSheet | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 自定义列：企业字段定义 ∪ 历史数据里出现过的 extra 键（含导入写入的新字段）
  const customFields = [...new Set([
    ...fieldsFor(ds.fieldSchema, 'inventory', { customOnly: true }).map((f) => f.key),
    ...ds.customFields,
  ])];
  const changed = Object.keys(overrides).length;

  const rows = ds.cost.filter((c) => {
    if(stockFilter==='zero'&&(backend?c.stockQty:(overrides[c.partNumber]??c.stockQty))!==0)return false;
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return c.partNumber.toLowerCase().includes(s) || c.description.toLowerCase().includes(s) || c.warehouse.toLowerCase().includes(s);
  });

  const run = async (fn: () => Promise<unknown>) => {
    try { setErr(''); await fn(); onRefresh(); return true; } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; }
  };
  const put = (row: CostRow, patch: Record<string, unknown>) =>
    run(() => api('PUT', `/api/inventory/${encodeURIComponent(row.partNumber)}`, { patch, accountId: row.account_id }));
  const del = (row: CostRow) => setDeleteTarget(row);
  const confirmDelete = async () => {
    if (!deleteTarget || saving) return;
    setSaving(true);
    const ok = await run(() => api('DELETE', `/api/inventory/${encodeURIComponent(deleteTarget.partNumber)}?accountId=${encodeURIComponent(deleteTarget.account_id||'')}`));
    setSaving(false);
    if (ok) setDeleteTarget(null);
  };
  const addRow = async () => {
    if (saving) return;
    if (!newRow.partNumber.trim()) { setErr('件号必填，其余可空'); return; }
    if (ds.cost.some(c => c.partNumber.toLowerCase() === newRow.partNumber.trim().toLowerCase())) { setErr('该件号已存在，请搜索后编辑原物料。'); return; }
    if (!Number.isFinite(Number(newRow.stockQty)) || Number(newRow.stockQty) < 0) { setErr('库存数量必须是零或正数'); return; }
    setSaving(true);
    const ok = await run(() => api('POST', '/api/inventory', {
      row: {
        partNumber: newRow.partNumber.trim(),
        description: newRow.description.trim(),
        stockQty: Number(newRow.stockQty) || 0,
        warehouse: newRow.warehouse.trim(),
      },
    }));
    setSaving(false);
    if (!ok) return;
    setAddOpen(false);
    setNewRow({ partNumber: '', description: '', stockQty: '', warehouse: '' });
  };
  const onFile = async (f: File) => {
    try {
      const s = await readSheetFile(f);
      if (!s.headers.length) { setErr('文件没有读到表头'); return; }
      setSheet(s);
      setErr('');
    } catch (e) { setErr(`文件解析失败：${e instanceof Error ? e.message : e}`); }
  };
  const doImport = async (mapping: Record<string, string>) => {
    if (!sheet || saving) return;
    const rows = applyMapping(sheet.rows, mapping, numericFieldsFor(ds.fieldSchema, 'inventory'))
      .map((r) => {
        const { core, custom } = splitCustomKeys(ds.fieldSchema, 'inventory', r);
        return Object.keys(custom).length ? { ...core, extra: custom } : core;
      })
      .filter((r) => r.partNumber);
    if (rows.some(row => [...NUMERIC].some(field => field in row && (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0)))) { setErr('导入包含无效或负数的库存/成本，请修正文件后重新导入。'); return; }
    if (!rows.length) { setErr('映射后没有含 partNumber 的有效行，请检查件号列映射'); return; }
    setSaving(true);
    const ok = await run(async () => {
      const res = await api('POST', '/api/inventory/import', { rows });
      setErr(`导入完成：写入 ${res.ok} 条${res.skip ? `，跳过 ${res.skip} 条（缺件号）` : ''}`);
    });
    setSaving(false);
    if (ok) setSheet(null);
  };

  /** 单元格：后端模式全字段可改；降级模式仅库存数量（会话内） */
  const cell = (c: CostRow, field: string) => {
    const raw = field === 'stockQty' && !backend ? (overrides[c.partNumber] ?? c.stockQty) : (c as unknown as Record<string, unknown>)[field];
    if (!backend && field !== 'stockQty') return <>{field.includes('Cost') || field === 'lastPurchasePrice' ? fmtMoney(Number(raw)) : String(raw ?? '')}</>;
    return (
      <input
        key={`${c.partNumber}:${field}:${String(raw)}`}
        className={`cell-input ${!backend && overrides[c.partNumber] != null && field === 'stockQty' ? 'inv-changed' : ''}`}
        aria-label={`${c.partNumber} ${FIELD_LABEL[field] || field}`}
        defaultValue={String(raw ?? '')}
        type={NUMERIC.has(field) ? 'number' : 'text'}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v === String(raw ?? '')) return;
          if (NUMERIC.has(field) && (!Number.isFinite(Number(v)) || Number(v) < 0)) { setErr('库存和成本不能为负数，请重新填写。'); e.target.value = String(raw ?? ''); return; }
          if (backend) put(c, { [field]: NUMERIC.has(field) ? Number(v) || 0 : v });
          else onChange(c.partNumber, v === '' || Number(v) === c.stockQty ? null : Math.max(0, Math.floor(Number(v))));
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    );
  };
  const customCell = (c: CostRow, field: string) => {
    const raw = c.extra?.[field];
    if (!backend) return <>{String(raw ?? '')}</>;
    return (
      <input
        key={`${c.partNumber}:${field}:${String(raw ?? '')}`}
        className="cell-input"
        defaultValue={String(raw ?? '')}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== String(raw ?? '')) put(c, { [field]: v });
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    );
  };

  return (
    <div className="page-inventory">
      <div className="page-heading"><div><h1>库存与成本</h1></div></div>
      <RecordToolbar filters={<FilterTabs label="库存筛选" value={stockFilter} onChange={value=>{setStockFilter(value);setPage(1)}} items={[{value:'all',label:'全部物料',count:ds.cost.length},{value:'zero',label:'零库存',count:ds.cost.filter(c=>(backend?c.stockQty:(overrides[c.partNumber]??c.stockQty))===0).length}]} />}>          <input className="search-input" aria-label="搜索库存物料" placeholder="搜索物料" value={q} onChange={(e) => {setQ(e.target.value);setPage(1);}} />
          {backend && (
            <>
              <button className="btn primary" onClick={() => setAddOpen(!addOpen)}>+ 添加物料</button>
              <button className="btn" onClick={() => fileRef.current?.click()}>导入 xlsx / csv</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            </>
          )}
          {!backend && changed > 0 && <button className="btn" onClick={onReset}>全部还原</button>}
</RecordToolbar>
      <div className="panel">
        {deleteTarget && <div className="check-box" role="alert"><p>确认删除物料 {deleteTarget.partNumber}？删除后不能撤销。</p><div className="toolbar"><button className="btn" disabled={saving} onClick={() => setDeleteTarget(null)}>取消删除</button><button className="btn" disabled={saving} onClick={confirmDelete}>确认删除物料</button></div></div>}
        {err && <div className="hint limitation">{err}</div>}

        {addOpen && backend && (
          <div className="check-box">
            <b>添加物料（件号必填，其余可空）</b>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <input className="cell-input" placeholder="件号 *" value={newRow.partNumber} onChange={(e) => setNewRow({ ...newRow, partNumber: e.target.value })} />
              <input className="cell-input" placeholder="描述" value={newRow.description} onChange={(e) => setNewRow({ ...newRow, description: e.target.value })} />
              <input className="cell-input" placeholder="库存数量" type="number" value={newRow.stockQty} onChange={(e) => setNewRow({ ...newRow, stockQty: e.target.value })} />
              <input className="cell-input" placeholder="仓库" value={newRow.warehouse} onChange={(e) => setNewRow({ ...newRow, warehouse: e.target.value })} />
              <button className="btn primary" disabled={saving} onClick={addRow}>{saving ? '保存中…' : '保存'}</button><button className="btn" disabled={saving} onClick={() => setAddOpen(false)}>取消添加</button>
            </div>
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>件号</th>
                {EDITABLE.map((f) => <th key={f} data-field={f}>{FIELD_LABEL[f]}</th>)}
                {customFields.map((f) => <th key={f}>{f}<Badge text="自定义" tone="blue" /></th>)}
                {backend && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.slice((Math.min(page,Math.max(1,Math.ceil(rows.length/20)))-1)*20,Math.min(page,Math.max(1,Math.ceil(rows.length/20)))*20).map((c) => (
                <tr key={`${c.account_id||''}:${c.partNumber}`}>
                  <td><b>{c.partNumber}</b>{c.account_name&&<div>{c.account_name}</div>}</td>
                  {EDITABLE.map((f) => <td key={f} data-field={f}>{cell(c, f)}</td>)}
                  {customFields.map((f) => <td key={f}>{customCell(c, f)}</td>)}
                  {backend && <td><button className="btn" onClick={() => del(c)}>删除</button></td>}
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={14} className="empty-cell">无匹配物料</td></tr>}
            </tbody>
          </table>
        </div>
        <RecordPagination total={rows.length} page={page} onChange={setPage} label="库存"/>
      </div>

      {sheet && (
        <MappingDialog error={err} busy={saving}
          title="库存导入字段映射"
          sheet={sheet}
          schema={ds.fieldSchema}
          scope="inventory"
          onConfirm={doImport}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
