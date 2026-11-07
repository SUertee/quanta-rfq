import { useEffect, useRef, useState } from 'react';
import {Modal} from '../components/Modal';
import { Badge, DataTable, StatCard, FilterTabs } from '../components/ui';
import type { TaskSummary } from '../task';
import type { Source } from '../App';
import type { EmailSample } from '../types';
import type { RawRow } from '../engine/parse';
import {createIntake,batchEmail} from '../engine/intake';

/** 首页 = 任务列表 + 新建任务入口（粘贴询价内容 / 上传 .eml / 上传订单 xlsx） */
export function HomePage({
  tasks, onPick, onNewTask, onDelete, onRestore, deletedCount, industryKw, taskTime, operator, openImport = false, onImportHandled,
}: {
  operator?: string;
  openImport?: boolean; onImportHandled?: () => void;
  onDelete: (key: string) => void; onRestore: () => void; deletedCount: number;
  tasks: TaskSummary[];
  onPick: (s: Source) => void;
  onNewTask: (email: EmailSample, rows?: RawRow[]) => void;
  industryKw: string;
  taskTime: Record<string, number>;
}) {
  const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState<'all'|'review'|'ready'>('all');
  const filteredTasks=tasks.filter(t=>`${t.title} ${t.customer}`.toLowerCase().includes(query.toLowerCase())&&(statusFilter==='all'||(statusFilter==='review'?t.checkCount>0||t.inquiryError||['needs_input','failed','interrupted'].includes(t.intakeStatus||''):t.checkCount===0&&!t.inquiryError&&t.total>0&&(!t.intakeStatus||t.intakeStatus==='evidence_ready'))));
  const [showNew, setShowNew] = useState(false);
  useEffect(() => { if (openImport) { setShowNew(true); onImportHandled?.(); } }, [openImport]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [files,setFiles]=useState<File[]>([]);
  const [busy,setBusy]=useState(false);
  const requestId=useRef(crypto.randomUUID());
  const checkTotal=tasks.reduce((n,t)=>n+t.checkCount,0);
  const readyTotal=tasks.filter(t=>t.total>0&&t.checkCount===0&&!t.inquiryError&&(!t.intakeStatus||t.intakeStatus==='evidence_ready')).length;
  const submit=async()=>{
    if(!files.length&&!text.trim()){setErr('请选择文件或粘贴询价内容');return;}
    setBusy(true);setErr('');
    try{const batch=await createIntake(files,text,operator||'本机用户',requestId.current);onNewTask(batchEmail(batch));setShowNew(false);setFiles([]);setText('');requestId.current=crypto.randomUUID();}
    catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  const statusOf=(t:TaskSummary)=>t.intakeStatus==='processing'?<Badge text="处理中" tone="blue" />:['failed','interrupted'].includes(t.intakeStatus||'')?<Badge text="处理未完成" tone="amber" />:t.intakeStatus==='needs_input'?<Badge text="待补充材料或字段" tone="amber" />:t.inquiryError?<Badge text="询价错误 · 可转手工单" tone="amber" />:t.total===0?<Badge text="待解析 · 无询价行" tone="amber" />:t.checkCount>0?<Badge text={`${t.checkCount} 行需核对`} tone="amber" />:<Badge text="待核价" tone="blue" />;
  const elapsedOf=(t:TaskSummary)=>{const sec=taskTime[t.key]??0;return sec?(sec<3600?`${Math.max(1,Math.round(sec/60))} 分钟`:`${(sec/3600).toFixed(1)} 小时`):'—'};
  return (
    <div className="page-home">
      <section className="home-overview" aria-label="询价工作台">
        <div className="page-heading"><h1>询价任务</h1></div>
        <div className="task-metrics" role="group" aria-label="询价任务概览">
          <div><span>全部询价</span><b>{tasks.length}</b><small>份任务</small></div>
          <div><span>待核对</span><b>{checkTotal}</b><small>行物料</small></div>
          <div><span>待核价</span><b>{readyTotal}</b><small>份任务</small></div>
        </div>
      </section>

      <div className="panel inquiry-records" role="region" aria-label="询价记录">
        <div className="list-toolbar"><FilterTabs label="任务状态筛选" value={statusFilter} onChange={setStatusFilter} items={[{value:'all',label:'全部任务'},{value:'review',label:'待核对'},{value:'ready',label:'待核价'}]} /><input className="search-input" aria-label="搜索询价" placeholder="搜索询价编号、客户…" value={query} onChange={e=>setQuery(e.target.value)} /><button className="btn primary inquiry-create" aria-label="新建询价" title="新建询价" onClick={()=>setShowNew(true)}>新建询价</button>{deletedCount>0&&<button className="btn" onClick={onRestore}>恢复已删除（{deletedCount}）</button>}</div>
        <DataTable
          rows={filteredTasks}
          mobileRender={t=><article className="task-record-card">
            <button className="task-record-open" aria-label={`打开询价 ${t.title}`} onClick={()=>onPick(t.source)}><b title={t.title}>{t.title}</b><span aria-hidden="true">↗</span></button>
            <div className="task-record-main"><span className="task-record-customer" title={t.customer}>{t.customer||'客户待补'}</span>{statusOf(t)}</div>
            <div className="task-record-meta"><span>{t.total} 行物料</span>{t.urgent&&<Badge text="加急" tone="red" />}<details className="task-record-more"><summary>更多</summary><dl><div><dt>来源</dt><dd>{t.tag}</dd></div><div><dt>截止</dt><dd>{t.due||'—'}</dd></div><div><dt>耗时</dt><dd>{elapsedOf(t)}</dd></div></dl><button className="btn" aria-label={`删除询价 ${t.title}`} onClick={()=>onDelete(t.key)}>删除询价</button></details></div>
          </article>}
          rowKey={(t) => t.key}
          onRowClick={(t) => onPick(t.source)}
          rowClass={() => ''}
          cols={[
            { title: '询价 / 客户', w:'42%', render: (t) => <div className="task-identity"><b className="task-name" title={t.title}>{t.title}</b><span>{t.customer||'客户待补'}{t.urgent&&<Badge text="加急" tone="red" />}</span></div> },
            { title: '来源', w:'12%', render: (t) => <Badge text={t.tag} tone="blue" /> },
            { title: '行数', w:'8%', render: (t) => t.total },
            {
              title: '状态', w:'22%', render:statusOf,
            },
            { title:'',render:t=><div className="record-actions" onClick={e=>e.stopPropagation()}><button className="record-open" aria-label={`打开询价 ${t.title}`} onClick={()=>onPick(t.source)}>打开 <span aria-hidden="true">↗</span></button><details className="record-menu"><summary aria-label={`更多操作 ${t.title}`}>···</summary><dl><div><dt>截止</dt><dd>{t.due||'—'}</dd></div><div><dt>耗时</dt><dd>{elapsedOf(t)}</dd></div></dl><button className="btn" aria-label={`删除询价 ${t.title}`} onClick={()=>onDelete(t.key)}>删除询价</button></details></div> },
          ]}
        />
      </div>

      {showNew && <Modal title="新建询价" className="inquiry-dialog" busy={busy} onClose={()=>setShowNew(false)}>
        <button className="inquiry-file-picker" disabled={busy} onClick={()=>fileRef.current?.click()}><span aria-hidden="true">＋</span>选择文件</button>
        <input ref={fileRef} type="file" multiple accept=".eml,.txt,.md,.csv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp" hidden onChange={e=>{setFiles(Array.from(e.target.files||[]));requestId.current=crypto.randomUUID();setErr('');}} />
        {files.length>0&&<ul className="inquiry-upload-list">{files.map((f,i)=><li key={i}><span>{f.name}</span><button type="button" aria-label={`移除 ${f.name}`} disabled={busy} onClick={()=>{setFiles(items=>items.filter((_,index)=>index!==i));requestId.current=crypto.randomUUID();}}>×</button></li>)}</ul>}
        <label className="inquiry-text-label">询价内容<textarea className="new-task-text" rows={5} aria-label="询价内容或补充要求" placeholder="粘贴询价内容，或补充文件中的要求…" disabled={busy} value={text} onChange={e=>{setText(e.target.value);requestId.current=crypto.randomUUID()}} /></label>
        {err&&<div role="alert" className="hint">{err}</div>}
        {busy&&<div role="status">正在保存原件、提取需求并匹配依据…</div>}
        <footer className="app-dialog-actions"><button className="btn" disabled={busy} onClick={()=>setShowNew(false)}>取消</button><button className="btn primary" disabled={busy||(!files.length&&!text.trim())} onClick={()=>void submit()}>{busy?'处理中…':'创建并分析'}</button></footer>
      </Modal>}

    </div>
  );
}
