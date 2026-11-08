import { useEffect, useRef, useState } from 'react';
import {Modal} from '../components/Modal';
import { Badge, DataTable, RecordToolbar, FilterTabs } from '../components/ui';
import type { TaskSummary } from '../task';
import type { Source } from '../App';
import type { EmailSample } from '../types';
import type { RawRow } from '../engine/parse';
import {createIntake,batchEmail,type IntakeBatch} from '../engine/intake';

/** 首页 = 任务列表 + 新建任务入口（粘贴询价内容 / 上传 .eml / 上传订单 xlsx） */
export function HomePage({
  tasks, onPick, onNewTask, onIntakeProgress, onIntakeError, onDelete, onRestore, deletedCount, industryKw, operator, openImport = false, onImportHandled,
}: {
  operator?: string;
  onIntakeError?: (batchId:string,message:string)=>void;
  onIntakeProgress?: (stage:1|2|3,batch:IntakeBatch)=>void;
  openImport?: boolean; onImportHandled?: () => void;
  onDelete: (key: string) => void; onRestore: () => void; deletedCount: number;
  tasks: TaskSummary[];
  onPick: (s: Source) => void;
  onNewTask: (email: EmailSample, rows?: RawRow[], options?:{open:boolean}) => void;
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
  const [dragOver,setDragOver]=useState(false);
  const addFiles=(incoming:File[])=>{
    if(busy||!incoming.length)return;
    const next=[...files,...incoming];
    if(next.length>6||next.some(file=>file.size>8*1024*1024)||next.reduce((sum,file)=>sum+file.size,0)>24*1024*1024){setErr('最多6个文件，每个8MB，总计24MB');return;}
    setFiles(next);requestId.current=crypto.randomUUID();setErr('');
  };
  const receivedId=useRef<string|null>(null);
  const requestId=useRef(crypto.randomUUID());
  const checkTotal=tasks.reduce((n,t)=>n+t.checkCount,0);
  const readyTotal=tasks.filter(t=>t.total>0&&t.checkCount===0&&!t.inquiryError&&(!t.intakeStatus||t.intakeStatus==='evidence_ready')).length;
  const submit=async()=>{
    if(!files.length&&!text.trim()){setErr('请选择文件或粘贴询价内容');return;}
    receivedId.current=null;setBusy(true);setErr('');
    try{const batch=await createIntake(files,text,operator||'本机用户',requestId.current,{onProgress:(stage,batch)=>{receivedId.current=batch.id;onIntakeProgress?.(stage,batch);}});onNewTask(batchEmail(batch),undefined,{open:!receivedId.current});setShowNew(false);setFiles([]);setText('');requestId.current=crypto.randomUUID();}
    catch(e){const message=e instanceof Error?e.message:String(e);setErr(message);if(receivedId.current)onIntakeError?.(receivedId.current,message);}
    finally{setBusy(false);}
  };
  const statusOf=(t:TaskSummary)=>t.intakeStatus==='processing'?<Badge text="处理中" tone="blue" />:['failed','interrupted'].includes(t.intakeStatus||'')?<Badge text="处理未完成" tone="amber" />:t.intakeStatus==='needs_input'?<Badge text="待补充材料或字段" tone="amber" />:t.inquiryError?<Badge text="待核对原文" tone="amber" />:t.total===0?<Badge text="待解析 · 无询价行" tone="amber" />:t.checkCount>0?<Badge text={`${t.checkCount} 行需核对`} tone="amber" />:<Badge text="待核价" tone="blue" />;
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

      <RecordToolbar filters={<FilterTabs label="任务状态筛选" value={statusFilter} onChange={setStatusFilter} items={[{value:'all',label:'全部任务'},{value:'review',label:'待核对'},{value:'ready',label:'待核价'}]} />}><input className="search-input" aria-label="搜索询价" placeholder="搜索询价编号、客户…" value={query} onChange={e=>setQuery(e.target.value)} /><button className="btn primary inquiry-create" aria-label="新建询价" title="新建询价" onClick={()=>setShowNew(true)}>新建询价</button>{deletedCount>0&&<button className="btn" onClick={onRestore}>恢复已删除（{deletedCount}）</button>}</RecordToolbar>
      <div className="panel inquiry-records" role="region" aria-label="询价记录">

        <DataTable
          rows={filteredTasks}
          mobileRender={t=><article className="task-record-card">
            <div className="task-record-main">{statusOf(t)}<span>{t.total} 行物料</span></div>
            <button className="task-record-open" aria-label={`打开询价 ${t.title}`} onClick={()=>onPick(t.source)}><b title={t.title}>{t.title}</b></button>
            <div className="task-record-meta"><span>{t.customer||'客户待补'}</span>{t.urgent&&<Badge text="加急" tone="red" />}<button className="record-delete" aria-label={`删除询价 ${t.title}`} onClick={()=>onDelete(t.key)}>删除</button></div>
          </article>}
          rowKey={(t) => t.key}
          onRowClick={(t) => onPick(t.source)}
          rowClass={() => ''}
          cols={[
            {title:'状态',w:'180px',render:statusOf},
            {title:'询价 / 客户',render:t=><div className="task-identity"><b className="task-name" title={t.title}>{t.title}</b><span>{t.customer||'客户待补'}{t.urgent&&<Badge text="加急" tone="red" />}</span></div>},
            {title:'行数',w:'72px',render:t=>t.total},
            {title:'操作',w:'140px',render:t=><div className="record-actions" onClick={e=>e.stopPropagation()}><button className="record-open" aria-label={`打开询价 ${t.title}`} onClick={()=>onPick(t.source)}>打开</button><button className="record-delete" aria-label={`删除询价 ${t.title}`} onClick={()=>onDelete(t.key)}>删除</button></div>},
          ]}

        />
      </div>

      {showNew && <Modal title="新建询价" className="inquiry-dialog" busy={busy} onClose={()=>setShowNew(false)}>
        <button className="inquiry-file-picker" data-drag-over={dragOver} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';setDragOver(true);}}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);addFiles(Array.from(e.dataTransfer.files));}} disabled={busy} onClick={()=>fileRef.current?.click()}><span aria-hidden="true">＋</span>选择文件</button>
        <input ref={fileRef} type="file" multiple accept=".eml,.txt,.md,.csv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp" hidden onChange={e=>{addFiles(Array.from(e.target.files||[]));e.currentTarget.value='';}} />
        {files.length>0&&<ul className="inquiry-upload-list">{files.map((f,i)=><li key={i}><span>{f.name}</span><button type="button" aria-label={`移除 ${f.name}`} disabled={busy} onClick={()=>{setFiles(items=>items.filter((_,index)=>index!==i));requestId.current=crypto.randomUUID();}}>×</button></li>)}</ul>}
        <label className="inquiry-text-label">询价内容<textarea className="new-task-text" rows={5} aria-label="询价内容或补充要求" placeholder="粘贴询价内容，或补充文件中的要求…" disabled={busy} value={text} onChange={e=>{setText(e.target.value);requestId.current=crypto.randomUUID()}} /></label>
        {err&&<div role="alert" className="hint">{err}</div>}
        {busy&&<div role="status">正在保存原件、提取需求并匹配依据…</div>}
        <footer className="app-dialog-actions"><button className="btn" disabled={busy} onClick={()=>setShowNew(false)}>取消</button><button className="btn primary" disabled={busy||(!files.length&&!text.trim())} onClick={()=>void submit()}>{busy?'处理中…':'创建并分析'}</button></footer>
      </Modal>}

    </div>
  );
}
