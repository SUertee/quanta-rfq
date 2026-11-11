import type {WorkflowRun,InquiryStage} from './engine/workflow';
import {useInquiryQuote} from './engine/useInquiryQuote';
import {appFetch as fetch,appUrl} from './engine/appUrl';
import {getAuth,setAuth,clearAuth,AUTH_EXPIRED_EVENT,type AuthAccount,type AuthState} from './auth';
import {conversationMeta,newConversation,updateConversation,inquiryConversation,clearConversationReferences,normalizeConversationTask} from './engine/conversations';
import {PlatformChat,ConversationList} from './components/AssistantConversations';
import {AccountMenu} from './components/AccountMenu';
import {AccountAdminDialog} from './components/AccountAdminDialog';
import {EmailBindingsDialog} from './components/EmailBindingsDialog';
import {ChangePasswordDialog} from './components/ChangePasswordDialog';
import {Modal} from './components/Modal';
import {FloatingAssistant} from './components/FloatingAssistant';
import {batchEmail,type IntakeBatch} from './engine/intake';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadData, type Dataset } from './data';
import type { RawRow } from './engine/parse';
import type { EmailSample, EstCost, InquiryLine } from './types';
import { isYellow, priceAll } from './engine/pricing';
import { DEFAULT_POLICY, type PricingPolicy } from './engine/pricingPolicy';
import { certificatesFor, condAliasesFor } from './engine/fieldSchema';
import { buildTasks, linesOf, type TaskSummary } from './task';
import { HomePage } from './pages/HomePage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { SettingsPage } from './pages/SettingsPage';
import { InventoryPage } from './pages/InventoryPage';
import { InspectPage } from './pages/InspectPage';
import { PriceResourcesPage } from './pages/PriceResourcesPage';
import { EvalPage } from './pages/EvalPage';
import { AgentPage } from './pages/AgentPage';
import { LoginPage } from './pages/LoginPage';
import { normalizeUom, splitPn } from './engine/structure';
import { useStoredState } from './engine/persistence';

export type Source =
  | { kind: 'email'; id: string; llmRows?: RawRow[] }
  | { kind: 'kanban'; rfqId: string };

const sourceKey = (s: Source) => s.kind === 'email' ? `email:${s.id}` : `kanban:${s.rfqId}`;

type View = 'home' | 'workbench' | 'inspect' | 'prices' | 'inventory' | 'settings' | 'eval';

/** The server selects direct workspace access or explicit account login. */
export default function App() {
  const [auth,setAuthState]=useState<AuthState|null>(()=>getAuth());
  const [checking,setChecking]=useState(true);
  const [loginRequired,setLoginRequired]=useState(false);
  const [sessionEpoch,setSessionEpoch]=useState(0);
  const [sessionError,setSessionError]=useState('');
  const reloadSession=()=>{setChecking(true);setSessionEpoch(value=>value+1);};
  useEffect(()=>{
    const expired=()=>{setAuthState(null);reloadSession();};
    window.addEventListener(AUTH_EXPIRED_EVENT,expired);
    return()=>window.removeEventListener(AUTH_EXPIRED_EVENT,expired);
  },[]);
  useEffect(()=>{
    let cancelled=false;
    setSessionError('');
    void (async()=>{
      const response=await fetch('/api/auth/session');
      if(!response.ok)throw new Error('工作台暂时无法连接，请重试');
      const session=await response.json() as {loginRequired:boolean;token?:string;account?:AuthAccount};
      if(cancelled)return;
      setLoginRequired(session.loginRequired);
      let next:AuthState|null=null;
      if(!session.loginRequired&&session.token&&session.account){
        next={token:session.token,account:session.account};
      }else{
        const current=getAuth();
        if(current?.token){
          const me=await fetch('/api/auth/me');
          if(cancelled)return;
          if(me.ok)next={token:current.token,account:await me.json() as AuthAccount};
        }
      }
      if(cancelled)return;
      if(next)setAuth(next);else clearAuth();
      setAuthState(next);
    })().catch(error=>{if(!cancelled)setSessionError(error.message);})
      .finally(()=>{if(!cancelled)setChecking(false);});
    return()=>{cancelled=true;};
  },[sessionEpoch]);
  if(checking)return <div className="boot" role="status">正在载入…</div>;
  if(sessionError)return <div className="boot" role="alert">{sessionError}<button className="btn" onClick={reloadSession}>重新连接</button></div>;
  if(!auth)return <LoginPage onLogin={setAuthState}/>;
  if(loginRequired&&auth.account.mustChangePwd)return <LoginPage initialAuth={auth} onLogin={setAuthState}/>;
  return <Workspace key={auth.account.id} account={auth.account} loginRequired={loginRequired} onLogout={()=>{setAuthState(null);reloadSession();}}/>;
}

function Workspace({account,onLogout,loginRequired}:{account:AuthAccount;onLogout:()=>void;loginRequired:boolean}) {
  const userId = account.id;
  const userName = account.displayName || account.username;
  /** 本机持久化 key 加账户命名空间，防止切账户串数据 */
  const ns = (key: string) => `${account.id}:${key}`;
  const [assignees, setAssignees] = useStoredState<Record<string, string>>(ns('task-assignees'), {});
  const [manualTasks, setManualTasks] = useStoredState<string[]>(ns('manual-tasks'), []);
  const [inspectionTarget,setInspectionTarget]=useState<{id:number;stage:InquiryStage;lineKey:string}|null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection,setSettingsSection]=useState<'pricing'|'services'>('pricing');
  const [importRequested, setImportRequested] = useState(new URLSearchParams(location.search).get('new') === '1');
  const [activeChat, setActiveChat] = useState<string | null>(() => 'chat:' + crypto.randomUUID());
  const automaticRuns=useRef(new Set<string>());
  const [workflowRuns,setWorkflowRuns]=useState<Record<string,WorkflowRun>>({});
  const [quickMessage,setQuickMessage]=useState<{id:number;text:string;inquiryId?:string;workflow?:boolean;context?:string}|null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantDocked, setAssistantDocked] = useState(false);
  const [chatRefreshing, setChatRefreshing] = useState(false);
  useEffect(()=>{const cite=()=>setAssistantOpen(true);window.addEventListener('quanta-reference',cite);return()=>window.removeEventListener('quanta-reference',cite);},[]);
  const [agentLineKey, setAgentLineKey] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [mode, setMode] = useState<'workbench' | 'agent'>('workbench');
  const [ds, setDs] = useState<Dataset | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState<View>('home');
  const [source, setSource] = useState<Source | null>(null);
  const currentSource=useRef(source);currentSource.current=source;
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
  const [policy, setPolicy] = useStoredState<PricingPolicy>(ns('policy'), DEFAULT_POLICY);
  const [priceBook, setPriceBook] = useStoredState<Record<string, number>>(ns('prices'), {});
  const [selectedBases,setSelectedBases]=useStoredState<Record<string,string>>(ns('selected-bases'),{});
  const [manualPrices, setManualPrices] = useStoredState<Set<string>>(ns('manual-prices'), new Set());
  const [skipped, setSkipped] = useStoredState<Set<string>>(ns('skipped-lines'), new Set());
  const [taskTime, setTaskTime] = useStoredState<Record<string, number>>(ns('task-time'), {});
  const [opCounts, setOpCounts] = useStoredState<Record<string, Record<string, number>>>(ns('op-counts'), {});

  const addTime = (key: string, sec: number) =>
    setTaskTime((old) => ({ ...old, [key]: (old[key] ?? 0) + sec }));
  const bumpOp = (key: string, op: string) =>
    setOpCounts((old) => ({ ...old, [key]: { ...(old[key] ?? {}), [op]: ((old[key] ?? {})[op] ?? 0) + 1 } }));
  const [resolved, setResolved] = useStoredState<Set<string>>(ns('resolved'), new Set());
  const [deletedTasks, setDeletedTasks] = useStoredState<string[]>(ns('deleted-tasks'), []);
  const [extraEmails, setExtraEmails] = useStoredState<EmailSample[]>(ns('inquiries'), []);
  const [stockOverride, setStockOverride] = useStoredState<Record<string, number>>(ns('stock'), {});
  const [estCost, setEstCost] = useStoredState<Record<string, EstCost>>(ns('costs'), {});
  const [lineEdits, setLineEdits] = useStoredState<Record<string, Partial<InquiryLine>>>(ns('line-edits'), {});
  const [addedLines, setAddedLines] = useStoredState<Record<string, InquiryLine[]>>(ns('added-lines'), {});
  const [invVersion, setInvVersion] = useState(0);
  const [taskRows, setTaskRows] = useStoredState<Record<string, RawRow[]>>(ns('parsed-rows'), {});
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
      certificates: certificatesFor(dsx2?.fieldSchema),
      condAliases: condAliasesFor(dsx2?.fieldSchema),
    };
  }, [policyFull, dsx2]);
  const tasks = useMemo(() => dsx2 ? buildTasks(dsx2, priceOpts, taskRows).filter(t => !deletedTasks.includes(t.key)).map((t) => {
    const taskSource = t.source.kind === 'email' && taskRows[t.source.id] ? { ...t.source, llmRows: taskRows[t.source.id] } : t.source;
    const lines = [...linesOf(dsx2, taskSource).lines, ...(addedLines[sourceKey(taskSource)] ?? [])].map((line) => ({ ...line, ...lineEdits[line.key],selectedBasisId:selectedBases[line.key] }));
    return { ...t, inquiryError: taskSource.kind === 'email' && ['case1-en', 'case2-en'].includes(taskSource.id) && !manualTasks.includes(t.key), tag: manualTasks.includes(t.key) ? '手工单' : t.tag, source: taskSource, total: lines.length, checkCount: priceAll(lines, dsx2, priceOpts).filter((p) => isYellow(p) && !resolved.has(p.line.key)).length };
  }) : [], [dsx2, priceOpts, taskRows, lineEdits, resolved, addedLines, deletedTasks, manualTasks,selectedBases]);
  const current = useMemo(() => {
    const base = dsx2 && source ? linesOf(dsx2, source) : { email: undefined, lines: [], label: '' };
    if (source) base.lines = [...base.lines, ...(addedLines[sourceKey(source)] ?? [])];
    return { ...base, lines: base.lines.map(l=>({...l,...lineEdits[l.key],selectedBasisId:selectedBases[l.key]})) };
  }, [dsx2, source, lineEdits, addedLines,selectedBases]);
  const priced = useMemo(() => (dsx2 ? priceAll(current.lines, dsx2, priceOpts) : []), [dsx2, current.lines, priceOpts]);

  const quoteSync=useInquiryQuote({inquiryId:current.email?.intakeBatchId,sourceRevision:JSON.stringify({rows:current.email?.parsedRows||[],status:current.email?.intakeStatus,issues:current.email?.intakeIssues||[]}),operator:userName,value:{policy:policyFull,lines:current.lines.map(line=>({key:line.key,price:priceBook[line.key]??null,manual:manualPrices.has(line.key),reviewed:resolved.has(line.key),skipped:skipped.has(line.key),manualCost:estCost[line.key]??null,selectedBasisId:selectedBases[line.key]??null}))},onRestore:state=>{
    const prefix=`intake-${current.email?.intakeBatchId}-`;
    setPolicy(state.policy);
    setSelectedBases(old=>({...Object.fromEntries(Object.entries(old).filter(([key])=>!key.startsWith(prefix))),...Object.fromEntries(state.lines.filter(line=>line.selectedBasisId).map(line=>[line.key,line.selectedBasisId!]))}));
    setPriceBook(old=>({...Object.fromEntries(Object.entries(old).filter(([key])=>!key.startsWith(prefix))),...Object.fromEntries(state.lines.filter(line=>line.price!=null).map(line=>[line.key,line.price!]))}));
    setManualPrices(old=>new Set([...old].filter(key=>!key.startsWith(prefix)).concat(state.lines.filter(line=>line.manual).map(line=>line.key))));
    setResolved(old=>new Set([...old].filter(key=>!key.startsWith(prefix)).concat(state.lines.filter(line=>line.reviewed).map(line=>line.key))));
    setSkipped(old=>new Set([...old].filter(key=>!key.startsWith(prefix)).concat(state.lines.filter(line=>line.skipped).map(line=>line.key))));
    setEstCost(old=>({...Object.fromEntries(Object.entries(old).filter(([key])=>!key.startsWith(prefix))),...Object.fromEntries(state.lines.filter(line=>line.manualCost).map(line=>[line.key,line.manualCost!]))}));
  }});

  useEffect(()=>{
    const id=current.email?.intakeBatchId;
    if(!id||current.email?.intakeStatus!=='processing')return;
    const controller=new AbortController();
    const timer=setInterval(()=>{
      void fetch(`/api/inquiries/${id}`,{signal:controller.signal}).then(async response=>{
        if(!response.ok)return;
        const batch:IntakeBatch=await response.json();
        if(controller.signal.aborted)return;
        const email=batchEmail(batch);
        setDs(old=>old?{...old,emails:old.emails.map(item=>item.id===email.id?email:item)}:old);
      }).catch(()=>{});
    },1000);
    return()=>{clearInterval(timer);controller.abort();};
  },[current.email?.intakeBatchId,current.email?.intakeStatus]);

  const currentRun=current.email?.intakeBatchId?workflowRuns[current.email.intakeBatchId]:undefined;
  useEffect(()=>{
    const id=current.email?.intakeBatchId;
    if(id&&['attention','queued'].includes(currentRun?.state||'')&&current.email?.intakeStatus==='evidence_ready'&&view==='workbench'&&mode==='workbench'&&quoteSync.ready&&!quoteSync.saving&&!quoteSync.error&&!automaticRuns.current.has(id)&&quickMessage?.inquiryId!==id){
      setWorkflowRuns(old=>({...old,[id]:{stage:4,revealed:4,state:'queued'}}));
      setAssistantOpen(true);setAssistantDocked(true);
      setQuickMessage({id:Date.now(),inquiryId:id,workflow:true,text:'按当前配置规则生成报价草稿，缺依据的行留空，并列明需要人工核对的条件。'});
    }
  },[current.email?.intakeBatchId,current.email?.intakeStatus,currentRun?.state,view,mode,quoteSync.ready,quoteSync.saving,quoteSync.error,quickMessage?.inquiryId]);

  if (err) return <div className="boot">数据载入失败：{err}</div>;
  if (!dsx2) return <div className="boot">正在载入…</div>;

  const selectInquiry = (nextSource: Source, preferredKey = activeChat) => {
    const nextKey = inquiryConversation(sourceKey(nextSource), preferredKey);
    if (!source || sourceKey(source) !== sourceKey(nextSource)) {
      clearConversationReferences(activeChat, nextKey);
      setQuickMessage(null);
    }
    updateConversation(nextKey, {taskKey:normalizeConversationTask(sourceKey(nextSource)), lastOpenedAt:new Date().toISOString()});
    setActiveChat(nextKey);
    setSource(nextSource);
    setAgentLineKey(null);
  };
  const openTask = (nextSource: Source, preferredKey = activeChat) => {
    setInspectionTarget(null);
    selectInquiry(nextSource, preferredKey);
    setView('workbench');
    setMode('workbench');
    setAssistantOpen(false);
    setAssistantDocked(false);
  };
  const startConversation = () => {
    const key = newConversation();
    if (!key) return;
    clearConversationReferences(activeChat, key);
    setQuickMessage(null);
    setActiveChat(key);
    setSource(null);
    setAgentLineKey(null);
  };
  const restoreConversation = (key: string) => {
    const metadata = conversationMeta()[key];
    const task = tasks.find(item => Object.prototype.hasOwnProperty.call(metadata || {}, 'taskKey')
      ? item.key === normalizeConversationTask(metadata?.taskKey || '')
      : key === item.key || key.startsWith(item.key + ':line:'));
    clearConversationReferences(activeChat, key);
    setQuickMessage(null);
    updateConversation(key, {lastOpenedAt:new Date().toISOString()});
    setActiveChat(key);
    setSource(task?.source || null);
    setAgentLineKey(task && key.startsWith(task.key + ':line:') ? key.slice(task.key.length + 6) : null);
    setChatRefreshing(true);
    if (source && task && normalizeConversationTask(sourceKey(source)) === task.key) quoteSync.retry();
    void loadData().then(setDs).catch(error => setErr(String(error))).finally(() => setChatRefreshing(false));
  };
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
        const allowed=['partNumber','description','quantity','uom','condition','requirement','dueDate','needByDate','quoteDeadline','mpn','priority','manualPn','productScope'];
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
  const receiveIntakeProgress = (stage:1|2|3,batch:IntakeBatch) => {
    const email=batchEmail(batch);
    setDs(old=>old?{...old,emails:[...old.emails.filter(item=>item.id!==email.id),email]}:old);
    setWorkflowRuns(old=>({...old,[batch.id]:{stage,revealed:stage,state:'running'}}));
    if(stage===1){selectInquiry({kind:'email',id:email.id});setView('workbench');setMode('workbench');}
  };
  const newTask = (email: EmailSample, llmRows?: RawRow[]) => {
    if(email.intakeBatchId) { setDs(old=>old?{...old,emails:[...old.emails.filter(e=>e.id!==email.id),email]}:old); void loadData().then(setDs).catch(e=>setErr(String(e))); }
    else setExtraEmails((arr) => [...arr, email]);
    if (llmRows) setTaskRows((old) => ({ ...old, [email.id]: llmRows }));
    if (userId.trim()) setAssignees(old => ({ ...old, [`email:${email.id}`]: userId.trim() }));
    selectInquiry({ kind: 'email', id: email.id, llmRows });
    setView('workbench');
  };

  const receiveChatInquiry = (batch: IntakeBatch, conversationKey: string) => {
    const email = batchEmail(batch);
    newTask(email);
    updateConversation(conversationKey, {taskKey: `email-${email.id}`});
    setActiveChat(conversationKey);
    setAgentLineKey(null);
    if (mode === 'workbench') setAssistantOpen(true);
  };
  const openChatInquiry = (id: string, conversationKey: string) => {
    openTask({kind: 'email', id: `intake-${id}`}, conversationKey);
  };

  const logout = () => {
    void fetch('/api/auth/logout', {method: 'POST'}).catch(() => {});
    clearAuth();
    onLogout();
  };

  const claimInquiry = async (task: TaskSummary) => {
    if (!task.intakeBatchId) return;
    try {
      const r = await fetch(`/api/inquiries/${encodeURIComponent(task.intakeBatchId)}/claim`, {method: 'POST'});
      if (r.status === 409) window.alert('该询价已被他人认领');
      else if (!r.ok) {
        const body = await r.json().catch(() => ({})) as {error?: string};
        window.alert(body.error || '认领失败，请重试');
      }
    } catch (e) {
      window.alert('认领失败：' + String(e));
    } finally {
      setInvVersion(v => v + 1);
    }
  };

  return (
    <div className={`layout layout-reference mode-${mode} view-${view} ${assistantDocked && assistantOpen && mode==='workbench' ? 'assistant-docked' : ''}`}>
      <aside className="sidebar">
        <button className="brand" aria-label="返回询价任务" onClick={()=>{setMode('workbench');setView('home');setAssistantOpen(false);setAssistantDocked(false);}}>
          <img className="quanta-wordmark" src={appUrl('images/brand/quanta-logo-light.svg')} alt="Quanta" width="136" height="43" />
        </button>
        <nav aria-label="主要导航">
          <button className={`nav-item ${mode === 'workbench' && (view === 'home' || view === 'workbench') ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('home'); setAssistantOpen(false); setAssistantDocked(false); }}>
            <span className="nav-label">询价任务</span>
          </button>
          <button className={`nav-item ${mode === 'workbench' && view === 'inspect' ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('inspect'); setAssistantOpen(false); setAssistantDocked(false); }}>
            <span className="nav-label">异常处理</span>
          </button>
          <button className={`nav-item ${mode === 'workbench' && view === 'prices' ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('prices'); setAssistantOpen(false); setAssistantDocked(false); }}>
            <span className="nav-label">价目与依据</span>
          </button>
          <button className={`nav-item ${mode === 'workbench' && view === 'inventory' ? 'active' : ''}`} onClick={() => { setMode('workbench'); setView('inventory'); setAssistantOpen(false); setAssistantDocked(false); }}>
            <span className="nav-label">库存与成本</span>
          </button>

          <button className={`nav-item ${mode==='agent'?'active':''}`} onClick={()=>{setMode('agent');setAssistantOpen(false);setAssistantDocked(false);}}><span className="nav-label">AI 对话</span></button>
        </nav>
        <div className="sidebar-foot">
          <AccountMenu loginRequired={loginRequired} account={account} onExit={logout} onProfile={()=>setProfileOpen(true)} onBusiness={()=>{setSettingsSection('pricing');setSettingsOpen(true);}} onModels={()=>{setSettingsSection('services');setSettingsOpen(true);}} onAccountAdmin={()=>setAdminOpen(true)} onEmailBindings={()=>setBindingsOpen(true)} onChangePassword={()=>setPwdOpen(true)} />
        </div>
      </aside>
      <main className={`content ${mode === 'workbench' && view === 'workbench' && assistantOpen ? 'with-copilot' : ''}`}>
        {quoteSync.error&&<div role="alert" className="panel"><span>{quoteSync.error}</span> <button className="btn" onClick={quoteSync.retry}>重试</button>{quoteSync.conflict&&<button className="btn" onClick={()=>{quoteSync.loadServer();setInvVersion(version=>version+1);}}>载入服务端版本</button>}</div>}
        {saveError && <div role="alert" className="panel">本机保存失败，可能是浏览器存储空间不足。请暂时不要刷新或关闭页面，先导出当前报价备份。</div>}


        <FloatingAssistant onSend={text=>{setQuickMessage({id:Date.now(),text});setAssistantOpen(true);}} open={assistantOpen} expanded={mode==='agent'} docked={assistantDocked && assistantOpen && mode==='workbench'} onOpen={()=>setAssistantOpen(true)} onCollapse={()=>{setAssistantOpen(false);setAssistantDocked(false);setMode('workbench');}}>
        <div className={mode === 'agent' ? "agent-mode-host" : "embedded-agent-host"}>
          {mode==='agent'&&<ConversationList tasks={tasks} selected={activeChat||(source?sourceKey(source)+(agentLineKey?':line:'+agentLineKey:''):'__no_task__')} onNew={startConversation} onSelect={restoreConversation} />}
          {!source && <PlatformChat onCorrectionSaved={()=>setInvVersion(v=>v+1)} operator={userName} onInquiryCreated={receiveChatInquiry} onOpenInquiry={openChatInquiry} standalone={mode==='agent'} docked={assistantDocked} onDock={()=>setAssistantDocked(value=>!value)} key={activeChat||'__no_task__'} conversationKey={activeChat||'__no_task__'} onQuickHandled={()=>setQuickMessage(null)} quickMessage={quickMessage?.inquiryId?null:quickMessage} onClose={()=>{setMode('workbench');setAssistantOpen(false);setAssistantDocked(false);}} onHistory={()=>{setMode('agent');setAssistantOpen(false);setAssistantDocked(false);}} />}
          {source&&quoteSync.ready&&<div className="copilot-body"><AgentPage onCorrectionSaved={()=>setInvVersion(v=>v+1)} onWorkflowProgress={(stage,state)=>{const id=current.email?.intakeBatchId;if(id&&state==='running')automaticRuns.current.add(id);if(id)setWorkflowRuns(old=>({...old,[id]:{stage,state,revealed:state==='done'?6:Math.max(old[id]?.revealed||6,stage) as InquiryStage}}));}} operator={userName} onInquiryCreated={receiveChatInquiry} key={(activeChat||'')+sourceKey(source)}
            sessionOverride={activeChat||undefined} onQuickHandled={()=>setQuickMessage(null)} quickMessage={source&&(!quickMessage?.inquiryId||quickMessage.inquiryId===current.email?.intakeBatchId)?quickMessage:null} onHistory={()=>{setMode('agent');setAssistantOpen(false);setAssistantDocked(false);}} embedded expanded={mode === 'agent'} docked={assistantDocked} selectedLineKey={agentLineKey}
            onClearLine={() => setAgentLineKey(null)}
            onClose={() => { setMode('workbench'); setAssistantOpen(false); setAssistantDocked(false); }}
            onExpand={() => { setAssistantOpen(true); setMode('workbench'); setAssistantDocked(mode==='agent'?false:!assistantDocked); }}
            onApplyPrice={(line, price) => {
              if (!current.lines.some(l => l.key === line.key && l.partNumber === line.partNumber && l.quantity === line.quantity) || skipped.has(line.key) || !Number.isFinite(price) || price <= 0) return;
              if(current.email?.intakeBatchId&&(!quoteSync.ready||quoteSync.saving||quoteSync.error||priced.find(row=>row.line.key===line.key)?.basisId!==line.basisId))return;
              setManualPrices(old => new Set([...old,line.key]));
              bumpOp(sourceKey(source!), 'agent-price');
              setPriceBook(old => ({ ...old, [line.key]: Math.round(price * 100) / 100 }));
              fetch('/api/review', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:current.lines[0]?.rfqId || current.label,pn:line.partNumber,action:'接受Agent建议单价',detail:`单价 ${price} CNY；业务风险未自动核销`,operator:userName})}).catch(() => {});
            }}
            onNewInquiry={() => { setMode('workbench'); setView('home'); setImportRequested(true); setAssistantOpen(false); setAssistantDocked(false); }}
            onSelectTask={selectInquiry}
            quoteVersion={current.email?.intakeBatchId?quoteSync.version:undefined} persistencePending={chatRefreshing || (!!current.email?.intakeBatchId&&(!quoteSync.ready||quoteSync.saving||!!quoteSync.error))} selectedBases={selectedBases} addedLines={addedLines} tasks={tasks} ds={dsx2} policy={policyFull} activeSource={source} lineEdits={lineEdits}
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
        {profileOpen && <Modal title="个人信息" className="profile-dialog" onClose={()=>setProfileOpen(false)}>
          <div className="dialog-fields"><label>用户名<input aria-label="用户名" value={account.username} readOnly disabled /></label><label>显示名称<input aria-label="显示名称" value={account.displayName} readOnly disabled /></label><label>角色<input aria-label="角色" value={account.role==='master'?'总账户':'子账户'} readOnly disabled /></label></div>
          <footer className="app-dialog-actions"><button className="btn primary" onClick={()=>setProfileOpen(false)}>完成</button></footer>
        </Modal>}
        {adminOpen && account.role==='master' && <AccountAdminDialog onClose={()=>setAdminOpen(false)} />}
        {bindingsOpen && <EmailBindingsDialog account={account} onClose={()=>setBindingsOpen(false)} />}
        {pwdOpen && <ChangePasswordDialog onClose={()=>setPwdOpen(false)} />}
        {mode === 'workbench' && <>
        {view === 'home' && <HomePage account={account} onClaim={(t)=>void claimInquiry(t)} operator={userName} openImport={importRequested} onImportHandled={() => setImportRequested(false)} industryKw={policyFull.industryKw} onDelete={key => {
            setDeletedTasks(old => [...old, key]);
            // 仅当删除的是当前打开的任务时才清空工作台来源
            setSource(old => {
              if (!old) return old;
              const cur = old.kind === 'email' ? `email:${old.id}` : `kanban:${old.rfqId}`;
              return cur === key ? null : old;
            });
          }} onRestore={() => setDeletedTasks([])} deletedCount={deletedTasks.length} tasks={tasks} onPick={openTask} onIntakeError={(id,error)=>setWorkflowRuns(old=>({...old,[id]:{stage:old[id]?.stage||1,revealed:old[id]?.revealed||1,state:'attention',error}}))} onIntakeProgress={receiveIntakeProgress} onNewTask={(email,_rows,options)=>{
            if(options?.open||(currentSource.current?.kind==='email'&&currentSource.current.id===email.id))newTask(email);
            else setDs(old=>old?{...old,emails:[...old.emails.filter(item=>item.id!==email.id),email]}:old);
            if(email.intakeBatchId){
              const ready=email.intakeStatus==='evidence_ready';
              setWorkflowRuns(old=>({...old,[email.intakeBatchId!]:{stage:ready?4:2,revealed:ready?4:3,state:ready?'queued':'attention'}}));
            }
          }} taskTime={taskTime} opCounts={opCounts} baselineMinutes={policyFull.baselineMinutes ?? 12} />}
        {view === 'workbench' && source && !quoteSync.ready && <section className="inquiry-loading" role={quoteSync.error?'alert':'status'} aria-label={quoteSync.error?'询价加载失败':'正在载入询价'}>
          {quoteSync.error?<><strong>询价加载失败</strong><button className="btn" onClick={quoteSync.retry}>重新加载</button></>:<span className="inquiry-loading-spinner" aria-hidden="true" />}
        </section>}
        {view === 'workbench' && source && quoteSync.ready && (
          <WorkbenchPage focusTarget={inspectionTarget} onConfigureRules={()=>{setSettingsSection('pricing');setSettingsOpen(true);}} run={current.email?.intakeBatchId?workflowRuns[current.email.intakeBatchId]:undefined} persistenceError={quoteSync.error} persistenceConflict={quoteSync.conflict} onRetryQuote={()=>{if(quoteSync.conflict){quoteSync.loadServer();setInvVersion(version=>version+1);}else quoteSync.retry();}} quoteVersion={current.email?.intakeBatchId?quoteSync.version:undefined} persistencePending={!quoteSync.ready||quoteSync.saving||!!quoteSync.error} key={sourceKey(source)} onDataRefresh={()=>setInvVersion(v=>v+1)}
            onAskAgent={(key) => { setAgentLineKey(key); setAssistantOpen(true); }}
            selectedAgentLine={agentLineKey}
            selectedBases={selectedBases} onSelectBasis={(key,id)=>{
              setSelectedBases(old=>{const next={...old};if(id)next[key]=id;else delete next[key];return next;});
              setPriceBook(old=>{const next={...old};delete next[key];return next;});
              setEstCost(old=>{const next={...old};delete next[key];return next;});
              setManualPrices(old=>{const next=new Set(old);next.delete(key);return next;});
              setResolved(old=>{const next=new Set(old);next.delete(key);return next;});
            }}

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
            onBatchAssistant={(text,context)=>{
              if(!text){const key=newConversation();if(!key)return;clearConversationReferences(activeChat,key);setActiveChat(key);setSource(null);setAgentLineKey(null);setQuickMessage(null);}
              else setQuickMessage({id:Date.now(),text,context});
              setMode('workbench');setAssistantOpen(true);setAssistantDocked(true);
            }}
            selectedBases={selectedBases} onDataRefresh={()=>setInvVersion(v=>v+1)} onConfigureRules={()=>{setSettingsSection('pricing');setSettingsOpen(true);}}
            onOpenTask={(s,stage,lineKey) => {openTask(s);if(stage&&lineKey)setInspectionTarget({id:Date.now(),stage,lineKey});}} />
        )}
        {view === 'prices' && <PriceResourcesPage ds={dsx2} onRefresh={() => setInvVersion((v) => v + 1)} />}
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
        {settingsOpen && <SettingsPage scope="all" initialSection={settingsSection} policy={policyFull} setPolicy={setPolicy} onClose={() => setSettingsOpen(false)} onRefresh={() => setInvVersion((v) => v + 1)} />}
    </div>
  );
}
