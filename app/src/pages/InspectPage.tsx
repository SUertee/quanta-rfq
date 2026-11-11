import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset } from '../data';
import type { EstCost, InquiryLine, PricedLine } from '../types';
import type { TaskSummary } from '../task';
import { linesOf } from '../task';
import { isYellow, priceAll } from '../engine/pricing';
import { certificatesFor, condAliasesFor } from '../engine/fieldSchema';
import { suggestPrice, type PricingPolicy } from '../engine/pricingPolicy';
import { FLAG_PLAIN } from '../plain';
import { Badge, DataTable, RecordToolbar } from '../components/ui';
import type { Source } from '../App';

type IssueType = '过期价' | '缺证书' | '毛利不足' | '未命中' | '待报价滞留' | '未核对' | '未定价';

interface IssueRow {
  key: string;
  type: IssueType;
  taskKey: string;
  taskTitle: string;
  orderId: string;
  pn: string;
  desc: string;
  detail: string;
  source: Source;
}

const ISSUE_ORDER: IssueType[] = ['过期价', '缺证书', '毛利不足', '未核对', '未定价', '未命中', '待报价滞留'];

/** 异常巡检中心：跨任务聚合全部打开任务的风险行 */
export function InspectPage({
  tasks, ds, policy, priceBook, estCost, resolved, skipped, addedLines, lineEdits, onOpenTask,
}: {
  tasks: TaskSummary[];
  ds: Dataset;
  policy: PricingPolicy;
  priceBook: Record<string, number>;
  estCost: Record<string, EstCost>;
  resolved: Set<string>;
  skipped: Set<string>;
  addedLines: Record<string, InquiryLine[]>;
  lineEdits: Record<string, Partial<InquiryLine>>;
  onOpenTask: (s: Source) => void;
}) {
  const [query,setQuery]=useState('');
  const [filters, setFilters] = useState<IssueType[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const outside = (event: PointerEvent) => { if (!filterMenu.current?.contains(event.target as Node)) setFilterOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setFilterOpen(false); filterMenu.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [filterOpen]);

  const rows = useMemo(() => {
    const opts = {
      freightDays: policy.freightDays,
      condFnNe: policy.condFnNe,
      certMutual: policy.certMutual,
      certificates: certificatesFor(ds.fieldSchema),
      condAliases: condAliasesFor(ds.fieldSchema),
      fxOverride: { ...(policy.fxUsd ? { USD: policy.fxUsd } : {}), ...(policy.fxEur ? { EUR: policy.fxEur } : {}), ...(policy.fxRates ?? {}) },
    };
    const out: IssueRow[] = [];
    const keyOf = (s: Source) => (s.kind === 'email' ? `email:${s.id}` : `kanban:${s.rfqId}`);
    for (const t of tasks) {
      const base = linesOf(ds, t.source).lines;
      const lines = [...base, ...(addedLines[keyOf(t.source)] ?? [])].map((l) => ({ ...l, ...lineEdits[l.key] }));
      const priced = priceAll(lines, ds, opts);
      const orderId = lines[0]?.rfqId || t.title;
      const push = (type: IssueType, p: PricedLine, detail: string) =>
        out.push({ key:`${t.key}:${p.line.key}:${type}`, type, taskKey: t.key, taskTitle: t.title, orderId, pn: p.line.partNumber || '—', desc: p.line.description, detail, source: t.source });
      for (const p of priced) {
        const key = p.line.key;
        if (skipped.has(key)) { push('待报价滞留', p, '已标暂不报价，待在附录或继续处理'); continue; }
        if (p.flags.includes('EXPIRED')) push('过期价', p, '全部候选价格已过有效期（按业务日期重算）');
        if (p.flags.includes('CERT_MISMATCH')) push('缺证书', p, `要求：${p.line.requirement || '证书'}，候选证书不满足`);
        if (p.flags.includes('NO_MATCH') && !estCost[key]) push('未命中', p, '成本表与供应商均无此件号，未估价');
        if (isYellow(p) && !resolved.has(key)) push('未核对', p, p.flags.filter((f) => f !== 'PRICE_PENDING' && f !== 'FX_DEMO').map(f=>FLAG_PLAIN[f]).join('；'));
        const price = priceBook[key];
        const s = suggestPrice(p, policy, estCost[key]?.value);
        if (price == null) push('未定价', p, '等待人工定价');
        else if (s.floor != null && price < s.floor) push('毛利不足', p, `定价 ${price} 低于合理最低 ${s.floor}`);
      }
    }
    return out;
  }, [tasks, ds, policy, priceBook, estCost, resolved, skipped, addedLines, lineEdits]);

  const counts = useMemo(() => {
    const m = new Map<IssueType, number>();
    for (const r of rows) m.set(r.type, (m.get(r.type) ?? 0) + 1);
    return m;
  }, [rows]);

  const shown = rows.filter(r=>(!filters.length||filters.includes(r.type))&&`${r.taskTitle} ${r.pn} ${r.desc} ${r.orderId}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page-inspect">
      <div className="page-heading"><div><h1>异常巡检</h1></div></div>
      <RecordToolbar filters={<div className="issue-filter" ref={filterMenu}>
        <button className="btn issue-filter-trigger" aria-expanded={filterOpen} aria-controls="issue-filter-options" onClick={()=>setFilterOpen(!filterOpen)}>筛选{filters.length ? ` · ${filters.length} 类` : ''}</button>
        <span className="issue-filter-count" role="status">{shown.length} 项</span>
        {filterOpen&&<div className="issue-filter-menu" id="issue-filter-options" role="group" aria-label="异常类型">
          <div className="issue-filter-heading"><strong>异常类型</strong><button className="btn" disabled={!filters.length} onClick={()=>setFilters([])}>清空</button></div>
          {ISSUE_ORDER.map(type=><label key={type}><input type="checkbox" checked={filters.includes(type)} onChange={event=>setFilters(current=>event.target.checked?[...current,type]:current.filter(value=>value!==type))}/><span>{type}</span><span>{counts.get(type)??0}</span></label>)}
        </div>}
      </div>}><input className="search-input" aria-label="搜索风险物料" placeholder="搜索件号、询价、描述…" value={query} onChange={e=>setQuery(e.target.value)} /></RecordToolbar>
      <div className="panel">
        <DataTable
          rows={shown}
          rowKey={(r) => r.key}
          onRowClick={(r) => onOpenTask(r.source)}
          rowClass={() => ''}
          cols={[
            { title: '类型', w:'110px', render: (r) => <Badge text={r.type} tone={['过期价', '缺证书', '毛利不足'].includes(r.type) ? 'red' : 'amber'} /> },
            { title: '询价任务', w:'28%', render: (r) => <div className="task-identity"><span className="task-name" title={r.taskTitle}>{r.taskTitle}</span><span className="issue-order-id" title={`接单ID：${r.orderId}`}>{r.orderId}</span></div> },
            { title: '件号', w:'130px', render: (r) => <b>{r.pn}</b> },
            { title: '描述', w:'18%', render: (r) => <span className="table-cell-lines" title={r.desc}>{r.desc}</span> },
            { title: '待处理原因', render: (r) => <span className="table-cell-lines" title={r.detail}>{r.detail}</span> },
          ]}
        />
      </div>
    </div>
  );
}
