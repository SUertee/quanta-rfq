import { useEffect, useState, type ReactNode } from 'react';
import type { FlagCode } from '../types';
import { FLAG_META } from '../engine/pricing';

export function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function FlagTag({ code }: { code: FlagCode }) {
  const meta = FLAG_META[code];
  return (
    <span className={`flag ${meta.yellow ? 'flag-yellow' : 'flag-info'}`} title={meta.label}>
      {meta.label}
    </span>
  );
}

export function Badge({ text, tone = 'gray' }: { text: string; tone?: 'gray' | 'blue' | 'green' | 'red' | 'amber' }) {
  return <span className={`badge badge-${tone}`}>{text}</span>;
}

/** Shared single-choice filters; counts stay distinct from the label. */
export function FilterTabs<T extends string>({ label, value, items, onChange }: {
  label: string; value: T; items: readonly { value: T; label: string; count?: number }[]; onChange: (value: T) => void;
}) {
  return <div className="filter-tabs unified-tabs" role="group" aria-label={label}>{items.map(item => <button type="button" key={item.value} aria-pressed={value === item.value} className={value === item.value ? 'active' : ''} onClick={() => onChange(item.value)}><span>{item.label}</span>{item.count !== undefined && <span className="tab-count">{item.count}</span>}</button>)}</div>;
}

export interface Col<T> {
  title: string;
  render: (r: T, i: number) => ReactNode;
  w?: string;
  secondary?: boolean;
}

export function DataTable<T>({
  cols, rows, rowKey, rowClass, onRowClick, pageSize = 20, mobileRender,
}: {
  pageSize?: number;
  mobileRender?:(row:T,index:number)=>ReactNode;
  cols: Col<T>[];
  rows: T[];
  rowKey?: (r: T) => string;
  rowClass?: (r: T) => string;
  onRowClick?: (r: T) => void;
}) {
  const [page,setPage]=useState(1);
  useEffect(()=>setPage(1),[rows]);
  const pages=Math.max(1,Math.ceil(rows.length/pageSize));
  const currentPage=Math.min(page,pages);
  const offset=(currentPage-1)*pageSize;
  return (
    <div className={`data-grid ${mobileRender?'responsive-record-grid':''}`}><div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map((c, i) => <th key={i} data-secondary={c.secondary||undefined} style={c.w ? { width: c.w } : undefined}>{c.title}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(offset,offset+pageSize).map((r, localIndex) => { const i=offset+localIndex; return (
            <tr
              key={rowKey ? rowKey(r) : i}
              className={`${rowClass ? rowClass(r) : ''} ${onRowClick ? 'clickable' : ''}`}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
            >
              {cols.map((c, j) => <td key={j} data-secondary={c.secondary||undefined}>{c.render(r, i)}</td>)}
            </tr>
          ); })}
          {!rows.length && (
            <tr><td colSpan={cols.length} className="empty-cell">暂无数据</td></tr>
          )}
        </tbody>
      </table>
    </div>{mobileRender&&<div className="responsive-record-list">{rows.slice(offset,offset+pageSize).map((row,i)=><div key={rowKey?rowKey(row):offset+i}>{mobileRender(row,offset+i)}</div>)}{!rows.length&&<div className="empty-cell">暂无数据</div>}</div>}<div className="table-pagination"><span>{rows.length ? `${offset+1}–${Math.min(offset+pageSize,rows.length)}` : '0'} / {rows.length} 条</span><div><button aria-label="上一页" disabled={currentPage<=1} onClick={()=>setPage(p=>p-1)}>←</button><span>{currentPage} / {pages}</span><button aria-label="下一页" disabled={currentPage>=pages} onClick={()=>setPage(p=>p+1)}>→</button></div></div></div>
  );
}
