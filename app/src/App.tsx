import {appFetch as fetch,appUrl} from './engine/appUrl';
import {conversationMeta,newConversation} from './engine/conversations';
import {PlatformChat,ConversationList} from './components/AssistantConversations';
import {Modal} from './components/Modal';
import {FloatingAssistant} from './components/FloatingAssistant';
import {batchEmail} from './engine/intake';
import { useEffect, useMemo, useState } from 'react';
import { loadData, type Dataset } from './data';
import type { RawRow } from './engine/parse';
import type { EmailSample, EstCost, InquiryLine } from './types';
import { isYellow, priceAll } from './engine/pricing';
import { DEFAULT_POLICY, type PricingPolicy } from './engine/pricingPolicy';
import { buildTasks, linesOf } from './task';
import { HomePage } from './pages/HomePage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { SettingsPage } from './pages/SettingsPage';
import { InventoryPage } from './pages/InventoryPage';
import { InspectPage } from './pages/InspectPage';
import { EvalPage } from './pages/EvalPage';
import { AgentPage } from './pages/AgentPage';
import { normalizeUom, splitPn } from './engine/structure';
import { useStoredState } from './engine/persistence';

export type Source =
  | { kind: 'email'; id: string; llmRows?: RawRow[] }
  | { kind: 'kanban'; rfqId: string };

const sourceKey = (s: Source) => s.kind === 'email' ? `email:${s.id}` : `kanban:${s.rfqId}`;

type View = 'home' | 'workbench' | 'inspect' | 'inventory' | 'settings' | 'eval';

export default function App() {
  const [userId, setUserId] = useStoredState<string>('user-id', '');
  const [assignees, setAssignees] = useStoredState<Record<string, string>>('task-assignees', {});
  const [manualTasks, setManualTasks] = useStoredState<string[]>('manual-tasks', []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importRequested, setImportRequested] = useState(new URLSearchParams(location.search).get('new') === '1');
  const [activeChat,setActiveChat]=useStoredState<string|null>('active-chat-v1',null);
  const [quickMessage,setQuickMessage]=useState<{id:number;text:string}|null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantDocked, setAssistantDocked] = useState(false);
  const [agentLineKey, setAgentLineKey] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [userName, setUserName] = useState(() => localStorage.getItem('quanta-user-name') || '林');
  const [mode, setMode] = useStoredState<'workbench' | 'agent'>('mode', 'workbench');
  const [ds, setDs] = useState<Dataset | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useStoredState<View>('view', 'home');
  const [source, setSource] = useStoredState<Source | null>('source', null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has('workspace')) {
      const target = params.get('view');
      setMode('workbench');
      setView(target === 'inventory' || target === 'inspect' ? target : 'home');
      if (params.has('new')) {
        params.delete('new');
        history.replaceState(history.state, '', `${location.pathname}?${params.toString()}`);
      }
    }
  }, []);
  const [policy, setPolicy] = useStoredState<PricingPolicy>('policy', DEFAULT_POLICY);
  const [priceBook, setPriceBook] = useStoredState<Record<string, number>>('prices', {});
  const [manualPrices, setManualPrices] = useStoredState<Set<string>>('manual-prices', new Set());
  const [skipped, setSkipped] = useStoredState<Set<string>>('skipped-lines', new Set());
  const [taskTime, setTaskTime] = useStoredState<Record<string, number>>('task-time', {});
  const [opCounts, setOpCounts] = useStoredState<Record<string, Record<string, number>>>('op-counts', {});

  const addTime = (key: string, sec: number) =>
    setTaskTime((old) => ({ ...old, [key]: (old[key] ?? 0) + sec }));
  const bumpOp = (key: string, op: string) =>
    setOpCounts((old) => ({ ...old, [key]: { ...(old[key] ?? {}), [op]: ((old[key] ?? {})[op] ?? 0) + 1 } }));
  const [resolved, setResolved] = useStoredState<Set<string>>('resolved', new Set());
  const [deletedTasks, setDeletedTasks] = useStoredState<string[]>('deleted-tasks', []);
  const [extraEmails, setExtraEmails] = useStoredState<EmailSample[]>('inquiries', []);
  const [stockOverride, setStockOverride] = useStoredState<Record<string, number>>('stock', {});
  const [estCost, setEstCost] = useStoredState<Record<string, EstCost>>('costs', {});
  const [lineEdits, setLineEdits] = useStoredState<Record<string, Partial<InquiryLine>>>('line-edits', {});
  const [addedLines, setAddedLines] = useStoredState<Record<string, InquiryLine[]>>('added-lines', {});
  const [invVersion, setInvVersion] = useState(0);
  const [taskRows, setTaskRows] = useStoredState<Record<string, RawRow[]>>('parsed-rows', {});
  const [saveError, setSaveError] = useState(false);
  useEffect(() => { const fail = () => setSaveError(true); window.addEventListener('quanta-save-failed', fail); return () => window.removeEventListener('quanta-save-failed', fail); }, []);

  useEffect(() => { loadData().then(setDs).catch((e) => setErr(String(e))); }, [invVersion]);

  /** 演示数据 + 用户手工录入的任务（会话内有效，持久化待后端） */
  const dsx = useMemo<Dataset | null>(
    () => (ds ? { ...ds, emails: [...ds.emails, ...extraEmails] } : null),
    [ds, extraEmails],
  );

  /** 再叠加库存改动。仅后端不可用时应用（后端在线时以 SQLite 真值为准，避免旧存档覆盖） */
  const dsx2 = useMemo<Dataset | null>(() => {
    if (!dsx) return null;
    if (dsx.inventoryBackend) return dsx;
    const keys = Object.keys(stockOverride);
    if (!keys.length) return dsx;
    const costIdx = new Map(dsx.costIdx);
    for (const pn of keys) {
      const c = costIdx.get(pn);
      if (c) costIdx.set(pn, { ...c, stockQty: stockOverride[pn] });
    }
    return {
      ...dsx,
      costIdx,
      cost: dsx.cost.map((c) => (stockOverride[c.partNumber] != null ? { ...c, stockQty: stockOverride[c.partNumber] } : c)),
    };
  }, [dsx, stockOverride]);

  /** 旧存档 policy 可能缺新字段，统一与默认值合并 */
  const policyFull = useMemo<PricingPolicy>(() => ({ ...DEFAULT_POLICY, ...policy }), [policy]);

  const priceOpts = useMemo(() => {
    const fx: Record<string, number> = { ...(policyFull.fxRates ?? {}) };
    if (policyFull.fxUsd && policyFull.fxUsd > 0) fx.USD ??= policyFull.fxUsd;
    if (policyFull.fxEur && policyFull.fxEur > 0) fx.EUR ??= policyFull.fxEur;
    return {
      freightDays: policyFull.freightDays,
      condFnNe: policyFull.condFnNe,
      certMutual: policyFull.certMutual,
      fxOverride: Object.keys(fx).length ? fx : undefined,
    };
  }, [policyFull]);
  const tasks = useMemo(() => dsx2 ? buildTasks(dsx2, priceOpts, taskRows).filter(t => !deletedTasks.includes(t.key)).map((t) => {
    const taskSource = t.source.kind === 'email' && taskRows[t.source.id] ? { ...t.source, llmRows: taskRows[t.source.id] } : t.source;
    const lines = [...linesOf(dsx2, taskSource).lines, ...(addedLines[sourceKey(taskSource)] ?? [])].map((line) => ({ ...line, ...lineEdits[line.key] }));
    return { ...t, inquiryError: taskSource.kind === 'email' && ['case1-en', 'case2-en'].includes(taskSource.id) && !manualTasks.includes(t.key), tag: manualTasks.includes(t.key) ? '手工单' : t.tag, source: taskSource, total: lines.length, checkCount: priceAll(lines, dsx2, priceOpts).filter((p) => isYellow(p) && !resolved.has(p.line.key)).length };
  }) : [], [dsx2, priceOpts, taskRows, lineEdits, resolved, addedLines, deletedTasks, manualTasks]);
  const current = useMemo(() => {
    const base = dsx2 && source ? linesOf(dsx2, source) : { email: undefined, lines: [], label: '' };
    if (source) base.lines = [...base.lines, ...(addedLines[sourceKey(source)] ?? [])];
    const keys = Object.keys(lineEdits);
    if (!keys.length) return base;
    return { ...base, lines: base.lines.map((l) => (lineEdits[l.key] ? { ...l, ...lineEdits[l.key] } : l)) };
  }, [dsx2, source, lineEdits, addedLines]);
  const priced = useMemo(() => (dsx2 ? priceAll(current.lines, dsx2, priceOpts) : []), [dsx2, current.lines, priceOpts]);

  if (err) return <div className="boot">数据载入失败：{err}</div>;
  if (!dsx2) return <div className="boot">正在载入…</div>;

  const openTask = (s: Source) => { if(activeChat&&conversationMeta()[activeChat]?.taskKey!==sourceKey(s))setActiveChat(null); setSource(s); setView('workbench'); setMode('workbench'); setAgentLineKey(null); setAssistantOpen(false); };
  const applyLlmRows = (rows: RawRow[]) => {
    if (source?.kind === 'email') { setSource({ ...source, llmRows: rows }); setTaskRows((old) => ({ ...old, [source.id]: rows })); }
  };
  const addPersistedLine = async (batchId:string,partNumber:string,quantity:number,uom:string,description:string)=>{
    try{const r=await fetch(`/api/inquiries/${batchId}/lines`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({partNumber,quantity,uom,description,operator:userName})});const body=await r.json();if(!r.ok)throw new Error(body.error||'保存失败');const updated=batchEmail(body);setDs(old=>old?{...old,emails:old.emails.map(e=>e.id===updated.id?updated:e)}:old);}catch(e){window.alert('新增物料未保存：'+String(e));}
  };
  const editInquiryLine = async (key:string,patch:Partial<InquiryLine>) => {
    const email=current.email, raw=email?.parsedRows?.find(r=>`${email.id}-${r.lineNo}`===key);
    if(email?.intakeBatchId && raw?.persistedLineId){
      try{
        const allowed=['partNumber','description','quantity','uom','condition','requirement','dueDate','mpn','priority','manualPn','productScope'];
        const savedPatch=Object.fromEntries(Object.entries(patch).filter(([k])=>allowed.includes(k)));
        const r=await fetch(`/api/inquiries/${email.intakeBatchId}/lines/${raw.persistedLineId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:(raw as RawRow & {version?:number}).version||1,patch:savedPatch,operator:userName})});
        const body=await r.json();if(!r.ok)throw new Error(body.error||'保存失败');const updated=batchEmail(body);
        setDs(old=>old?{...old,emails:old.emails.map(e=>e.id===updated.id?updated:e)}:old);
        setLineEdits(old=>{const next={...old};delete next[key];return next;});
      }catch(e){window.alert('物料未保存：'+String(e));return;}
    }else setLineEdits(old=>({...old,[key]:{...old[key],...patch}}));
    setResolved(old=>{const next=new Set(old);next.delete(key);return next;});
    setPriceBook(old=>{const next={...old};delete next[key];return next;});
  };
  const newTask = (email: EmailSample, llmRows?: RawRow[]) => {
    if(email.intakeBatchId) { setDs(old=>old?{...old,emails:[...old.emails.filter(e=>e.id!==email.id),email]}:old); void loadData().then(setDs).catch(e=>setErr(String(e))); }
    else setExtraEmails((arr) => [...arr, email]);
    if (llmRows) setTaskRows((old) => ({ ...old, [email.id]: llmRows }));
    if (userId.trim()) setAssignees(old => ({ ...old, [`email:${email.id}`]: userId.trim() }));
    setSource({ kind: 'email', id: email.id, llmRows });
    setView('workbench');
  };

  return (
    <div className={`layout layout-reference mode-${mode} view-${view} ${assistantDocked && assistantOpen && mode==='workbench' ? 'assistant-docked' : ''}`}>
      <aside className="sidebar">
        <button className="brand" aria-label="返回询价任务" onClick={()=>{setMode('workbench');setView('home');setAssistantOpen(false);}}>
          <img className="quanta-wordmark" src={appUrl('images/brand/quanta-logo-light.svg')} alt="Quanta" width="136" height="43" />
        </button>
        <nav aria-label="主要导航">
          <button className={`nav-item ${mode === 'workbench' && (view === 'home' || view === 'workbench') ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('home'); }}>
            <span className="nav-label">询价任务</span><span className="nav-count">{tasks.length}</span>
          </button>
          <button className={`nav-item ${mode === 'workbench' && view === 'inspect' ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('inspect'); }}>
            <span className="nav-label">异常巡检</span>
          </button>
          <button className={`nav-item ${mode === 'workbench' && view === 'inventory' ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('inventory'); }}>
            <span className="nav-label">库存与成本</span>
          </button>

          <button className={`nav-item ${mode==='agent'?'active':''}`} onClick={()=>{setMode('agent');setAssistantOpen(true);}}><span className="nav-label">AI 对话</span></button>
          <button className="nav-item" onClick={()=>setSettingsOpen(true)}><span className="nav-label">设置</span></button>
        </nav>
        <div className="sidebar-foot">
          <button className="avatar" aria-label="用户设置" onClick={() => setProfileOpen(true)}>{userName.slice(0, 1) || '我'}</button>
        </div>
      </aside>
      <main className={`content ${mode === 'workbench' && view === 'workbench' && assistantOpen ? 'with-copilot' : ''}`}>
        {saveError && <div role="alert" className="panel">本机保存失败，可能是浏览器存储空间不足。请暂时不要刷新或关闭页面，先导出当前报价备份。</div>}


        <FloatingAssistant onSend={text=>{setQuickMessage({id:Date.now(),text});setAssistantOpen(true);}} open={assistantOpen} expanded={mode==='agent'} docked={assistantDocked && assistantOpen && mode==='workbench'} onOpen={()=>setAssistantOpen(true)} onCollapse={()=>{setAssistantOpen(false);setAssistantDocked(false);setMode('workbench');}}>
        <div className={mode === 'agent' ? "agent-mode-host" : "embedded-agent-host"} hidden={mode !== 'agent' && !assistantOpen}>
          {mode==='agent'&&<ConversationList tasks={tasks} selected={activeChat||(source?sourceKey(source)+(agentLineKey?':line:'+agentLineKey:''):'__no_task__')} onNew={()=>{const key=newConversation();if(key){setActiveChat(key);setSource(null);setAgentLineKey(null);}}} onSelect={(key)=>{setQuickMessage(null);setActiveChat(key.startsWith('chat:')?key:null);const linked=conversationMeta()[key]?.taskKey;if(key.startsWith('chat:')||Object.prototype.hasOwnProperty.call(conversationMeta()[key]||{},'taskKey')){setActiveChat(key);const linkedTask=tasks.find(t=>t.key===linked);setSource(linkedTask?.source||null);setAgentLineKey(null);return;}if(key==='__no_task__'){setSource(null);setAgentLineKey(null);return;}const task=tasks.find(t=>key===t.key||key.startsWith(t.key+':line:'));if(task){setSource(task.source);setAgentLineKey(key.startsWith(task.key+':line:')?key.slice(task.key.length+6):null);}}} />}
          {!source && <PlatformChat onNewInquiry={()=>{setMode('workbench');setView('home');setImportRequested(true);}} standalone={mode==='agent'} docked={assistantDocked} onDock={()=>setAssistantDocked(value=>!value)} key={activeChat||'__no_task__'} conversationKey={activeChat||'__no_task__'} onQuickHandled={()=>setQuickMessage(null)} quickMessage={quickMessage} onClose={()=>{setMode('workbench');setAssistantOpen(false);setAssistantDocked(false);}} onHistory={()=>{setMode('agent');setAssistantOpen(true);}} />}
          {source&&<div className="copilot-body"><AgentPage key={(activeChat||'')+sourceKey(source)+(agentLineKey||'')}
            sessionOverride={activeChat||undefined} onQuickHandled={()=>setQuickMessage(null)} quickMessage={source?quickMessage:null} onHistory={()=>{setMode('agent');setAssistantOpen(true);}} embedded expanded={mode === 'agent'} docked={assistantDocked} selectedLineKey={agentLineKey}
            onClearLine={() => setAgentLineKey(null)}
            onClose={() => { setMode('workbench'); setAssistantOpen(false); setAssistantDocked(false); }}
            onExpand={() => { setAssistantOpen(true); setMode('workbench'); setAssistantDocked(mode==='agent'?false:!assistantDocked); }}
            onApplyPrice={(line, price) => {
              if (!current.lines.some(l => l.key === line.key && l.partNumber === line.partNumber && l.quantity === line.quantity) || skipped.has(line.key) || !Number.isFinite(price) || price <= 0) return;
              setManualPrices(old => new Set([...old,line.key]));
              bumpOp(sourceKey(source!), 'agent-price');
              setPriceBook(old => ({ ...old, [line.key]: Math.round(price * 100) / 100 }));
              fetch('/api/review', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:current.lines[0]?.rfqId || current.label,pn:line.partNumber,action:'接受Agent建议单价',detail:`单价 ${price} CNY；业务风险未自动核销`,operator:userName})}).catch(() => {});
            }}
            onNewInquiry={() => { setMode('workbench'); setView('home'); setImportRequested(true); }}
            onSelectTask={(s) => { setSource(s); setAgentLineKey(null); }}
            addedLines={addedLines} tasks={tasks} ds={dsx2} policy={policyFull} activeSource={source} lineEdits={lineEdits}
            priceBook={priceBook} setPriceBook={setPriceBook}
            resolved={resolved} setResolved={setResolved}
            estCost={estCost} setEstCost={setEstCost}
            skipped={skipped}
            onOpenTask={(s) => { setMode('workbench'); openTask(s); }}
            onOpenSettings={() => setSettingsOpen(true)}
          /></div>}
        </div>
        </FloatingAssistant>
        {dsx2.intakeLoadError && <div role="alert" className="hint">{dsx2.intakeLoadError}</div>}
        {profileOpen && <Modal title="个人设置" className="profile-dialog" onClose={()=>setProfileOpen(false)}>
          <div className="dialog-fields"><label>用户 ID<input autoFocus aria-label="用户 ID" placeholder="输入用户 ID" value={userId} onChange={e=>setUserId(e.target.value)} /></label><label>显示名称<input aria-label="显示名称" value={userName} onChange={e=>{setUserName(e.target.value);localStorage.setItem('quanta-user-name',e.target.value);}} /></label></div>
          <footer className="app-dialog-actions"><button className="btn primary" onClick={()=>setProfileOpen(false)}>完成</button></footer>
        </Modal>}
        {mode === 'workbench' && <>
        {view === 'home' && <HomePage operator={userId||userName} openImport={importRequested} onImportHandled={() => setImportRequested(false)} industryKw={policyFull.industryKw} onDelete={key => {
            setDeletedTasks(old => [...old, key]);
            // 仅当删除的是当前打开的任务时才清空工作台来源
            setSource(old => {
              if (!old) return old;
              const cur = old.kind === 'email' ? `email:${old.id}` : `kanban:${old.rfqId}`;
              return cur === key ? null : old;
            });
          }} onRestore={() => setDeletedTasks([])} deletedCount={deletedTasks.length} tasks={tasks} onPick={openTask} onNewTask={newTask} taskTime={taskTime} />}
        {view === 'workbench' && source && (
          <WorkbenchPage key={sourceKey(source)} onDataRefresh={()=>setInvVersion(v=>v+1)}
            onAskAgent={(key) => { setAgentLineKey(key); setAssistantOpen(true); }}
            selectedAgentLine={agentLineKey}

            assigneeId={assignees[sourceKey(source)] ?? ''} onAssigneeChange={id => setAssignees(old => ({ ...old, [sourceKey(source)]: id }))}
            currentUserId={userId}
            inquiryError={source.kind === 'email' && ['case1-en', 'case2-en'].includes(source.id) && !manualTasks.includes(`email-${source.id}`)}
            onConvertManual={() => { if (source.kind === 'email') { setManualTasks(old => [...old, `email-${source.id}`]); setResolved(old => { const next = new Set(old); current.lines.forEach(l => next.delete(l.key)); return next; }); } }}
            ds={dsx2} source={source} lines={current.lines} priced={priced}
            email={current.email} label={current.label}
            policy={policyFull} priceBook={priceBook} setPriceBook={setPriceBook}
            resolved={resolved} setResolved={setResolved}
            estCost={estCost} setEstCost={setEstCost}
            manualPrices={manualPrices} setManualPrices={setManualPrices}
            skipped={skipped} setSkipped={setSkipped}
            taskKey={sourceKey(source)} timing={taskTime[sourceKey(source)] ?? 0}
            ops={opCounts[sourceKey(source)] ?? {}}
            onTime={addTime} onOp={(op) => bumpOp(sourceKey(source), op)}
            onEditLine={(key,patch)=>void editInquiryLine(key,patch)}
            onAddLine={(partNumber, quantity, uom, description) => {
              if(current.email?.intakeBatchId){void addPersistedLine(current.email.intakeBatchId,partNumber,quantity,uom,description);return;}
              const pn = splitPn(partNumber), unit = normalizeUom(uom);
              const line: InquiryLine = { key: `manual:${crypto.randomUUID()}`, source: '手工新增', rfqId: current.lines[0]?.rfqId ?? current.label, inquiryDate: '', customer: current.lines[0]?.customer ?? '', urgency: '', lineNo: current.lines.length + 1, partNumber, basePn: pn.base, pnSuffix: pn.suffix, description, quantity, uom, uomNormalized: unit.norm, uomFactor: unit.factor, requirement: '', mpn: '', condition: 'NE', manualPn: '', productScope: '', dueDate: current.lines[0]?.dueDate ?? '', needByDate: current.lines[0]?.needByDate, issues: [], manualFixedMark: true };
              setAddedLines(old => ({ ...old, [sourceKey(source)]: [...(old[sourceKey(source)] ?? []), line] }));
            }}
            onBack={() => setView('home')} onApplyLlmRows={applyLlmRows}
          />
        )}

        {view === 'inspect' && (
          <InspectPage tasks={tasks} ds={dsx2} policy={policyFull} priceBook={priceBook} estCost={estCost}
            resolved={resolved} skipped={skipped} addedLines={addedLines} lineEdits={lineEdits}
            onOpenTask={(s) => openTask(s)} />
        )}
        {view === 'inventory' && (
          <InventoryPage ds={dsx2} overrides={stockOverride}
            onChange={(pn, qty) => setStockOverride((o) => {
              const n = { ...o };
              if (qty == null) delete n[pn]; else n[pn] = qty;
              return n;
            })}
            onReset={() => setStockOverride({})}
            onRefresh={() => setInvVersion((v) => v + 1)} />
        )}

        {view === 'eval' && <EvalPage ds={dsx2} />}
        </>}
      </main>
        {settingsOpen && <SettingsPage scope="all" policy={policyFull} setPolicy={setPolicy} onClose={() => setSettingsOpen(false)} onRefresh={() => setInvVersion((v) => v + 1)} />}
    </div>
  );
}
