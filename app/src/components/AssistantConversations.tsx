import {ChatMaterialPurpose,ChatSupplierFlow,ChatSupplierResult} from './ChatMaterials';
import {chatMaterialRoute,type MaterialPurpose,type ChatSupplierRequest,type ChatSupplierReceipt} from '../engine/chatMaterials';
import {submitChatInquiry, type ChatIntakeRequest} from '../engine/chatIntake';
import type {IntakeBatch} from '../engine/intake';
import {ChatInquiryReceipt, chatInquiryResult, type ChatInquiryResult} from './ChatInquiryReceipt';
import {ReferenceList,useChatReferences} from './ChatReferences';
import {conversationReferences,type ChatReference} from '../engine/chatReferences';
import {MessageRail} from './MessageRail';
import {useChatScroll} from '../engine/useChatScroll';
import {appFetch as fetch} from '../engine/appUrl';
import {ChatAttachmentPreview} from './ChatAttachmentPreview';
import type {ChatAttachment} from '../engine/chatAttachments';
import {ChatMarkdown} from './ChatMarkdown';
import {readChatStream} from '../engine/chatStream';
import {ChatFiles} from './ChatFiles';
import {conversationMeta,updateConversation,normalizeConversationTask} from '../engine/conversations';
import {useEffect,useRef,useState} from 'react';
import {readStored,useStoredState} from '../engine/persistence';
import type {TaskSummary} from '../task';
type Turn = {
  references?: ChatReference[];
  attachments?: ChatAttachment[];
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  inquiry?: ChatInquiryResult;
  supplier?:ChatSupplierReceipt;
};
type Session = {context?: string; turns: Turn[]; state?: string; input?: string; creation?: ChatIntakeRequest; supplierCreation?:ChatSupplierRequest};
interface PlatformChatProps {
  standalone?: boolean;
  docked?: boolean;
  onDock?: () => void;
  onInquiryCreated?: (batch: IntakeBatch, conversationKey: string) => void;
  onOpenInquiry?: (id: string, conversationKey: string) => void;
  operator?: string;
  conversationKey?: string;
  quickMessage: {id: number; text: string} | null;
  onQuickHandled: () => void;
  onClose: () => void;
  onHistory: () => void;
}

export function PlatformChat({standalone=false, docked=false, onDock, onInquiryCreated, onOpenInquiry,
  operator='本机用户', conversationKey='__no_task__', quickMessage, onQuickHandled, onClose, onHistory}: PlatformChatProps) {
  const [sessions, setSessions] = useStoredState<Record<string, Session>>('rfq-chat-v1', {});
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [materialPurpose,setMaterialPurpose]=useState<MaterialPurpose>('auto');
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const [input, setInputState] = useState(sessions[conversationKey]?.input || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seen = useRef<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const composing = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const references = useChatReferences(conversationKey, busy);
  const session = sessions[conversationKey];
  const turns = session?.turns || [];
  const chatScroll = useChatScroll(turns);
  const patch = (change: Partial<Session>) => setSessions(old => ({
    ...old, [conversationKey]: {...old[conversationKey], turns: old[conversationKey]?.turns || [], ...change},
  }));
  const setInput = (value: string) => { setInputState(value); patch({input: value}); };
  const append = (turn: Turn) => setSessions(old => ({
    ...old, [conversationKey]: {...old[conversationKey], turns: [
      ...(old[conversationKey]?.turns || []), {...turn, createdAt: new Date().toISOString()},
    ]},
  }));

  useEffect(() => { window.dispatchEvent(new Event('rfq-chat-updated')); }, [sessions]);
  useEffect(() => () => request.current?.abort(), []);

  const receiveInquiry = async (creation: ChatIntakeRequest) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    patch({creation});
    const controller = new AbortController();
    request.current = controller;
    try {
      const batch = await submitChatInquiry(creation, controller.signal);
      controller.signal.throwIfAborted();
      append({role: 'assistant', content: '', inquiry: chatInquiryResult(batch)});
      patch({creation: undefined, context: undefined});
      references.clear();
      onInquiryCreated?.(batch, conversationKey);
    } catch (failure) {
      setError(controller.signal.aborted ? '已停止等待，可重试读取接收结果。' : failure instanceof Error ? failure.message : '接收未完成，请重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const send = async (text=input) => {
    if ((!text.trim() && !attachments.length && !references.items.length) ||
      attachments.some(file => file.status === 'reading') || pending.current) return;
    if (session?.creation) { setError('上次接收尚未完成，请先重试或取消。'); return; }
    const instruction = text.trim();
    const route=chatMaterialRoute(instruction,attachments.length,materialPurpose);
    if(route==='choose'){setError('请选择资料用途，再发送。');return;}
    if(session?.supplierCreation){setError('请先完成或取消供应商报价接收。');return;}
    setError('');
    chatScroll.follow.current = true;
    append({role: 'user', content: instruction || (references.items.length ? '请核对引用内容。' : attachments.map(file => file.name).join('、')), attachments, references: references.items});
    setInput('');
    setAttachments([]);
    setAttachmentEpoch(number => number + 1);
    patch({context:undefined});
    setMaterialPurpose('auto');
    if(route==='supplier'){patch({supplierCreation:{attachments,operator}});return;}
    if (route==='inquiry') {
      await receiveInquiry({requestId: crypto.randomUUID(), instruction, attachments, operator});
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    request.current = controller;
    const activeReferences = conversationReferences(references.items, turns);
    append({role: 'assistant', content: ''});
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/x-ndjson'}, signal: controller.signal,
        body: JSON.stringify({
          references: activeReferences,
          instruction: instruction || (references.items.length ? '请解释引用的内容和需要核对的条件。' : '请根据附件内容简洁总结需求，未识别的附件不要推断。'),
          context: session?.context,
          history: turns.filter(turn => turn.content.trim()).slice(-6).map(turn => ({role: turn.role, content: turn.content.slice(0, 2000)})),
        }),
      });
      await readChatStream(response, content => {
        if (controller.signal.aborted) return;
        setSessions(old => {
          const saved = old[conversationKey];
          if (!saved) return old;
          const updated = [...saved.turns];
          const last = updated.length - 1;
          if (updated[last]?.role !== 'assistant') return old;
          updated[last] = {...updated[last], content};
          return {...old, [conversationKey]: {...saved, turns: updated}};
        });
      });
      references.clear();
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (quickMessage && seen.current !== quickMessage.id) {
      seen.current = quickMessage.id;
      onQuickHandled();
      void send(quickMessage.text);
    }
  }, [quickMessage]);

  return <section className={`platform-chat ${standalone ? 'standalone-chat' : ''}`} aria-label="AI 对话">
    {!standalone && <header className="copilot-header"><strong>报价助手</strong><div>
      <button className="copilot-icon" aria-label="打开 AI 对话页" title="打开 AI 对话页" onClick={onHistory}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 18 6M8 6h10v10"/></svg></button>
      <button className="copilot-icon" aria-label={docked ? '恢复浮窗' : '展开到右侧'} title={docked ? '恢复浮窗' : '展开到右侧'} onClick={onDock}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={docked ? 'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5' : 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'}/></svg></button>
      <button className="copilot-icon" aria-label="收起报价助手" title="收起报价助手" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>
    </div></header>}
    <div className="platform-chat-messages" ref={chatScroll.containerRef} onScroll={chatScroll.onScroll}>
      {!turns.length && <div className="chat-start">{standalone && <h1>今天需要处理哪份询价？</h1>}<div>
        <button className="btn" onClick={() => form.current?.querySelector<HTMLInputElement>('input[type=file]')?.click()}>上传询价</button>
        <button className="btn" onClick={() => send('怎样从上传询价到生成报价单？')}>了解报价流程 ↗</button>
      </div></div>}
      {turns.map((turn, index) => <article className={`rfq-chat-turn ${turn.role}`} key={index}>
        {turn.role === 'assistant' && <div className="rfq-chat-speaker">Quanta</div>}
        <div className="rfq-chat-text">
          {turn.references && <ReferenceList items={turn.references}/>}
          {turn.attachments && <div className="chat-attachment-strip">{turn.attachments.map(file => <ChatAttachmentPreview key={file.id} attachment={file}/>)}</div>}
          {turn.supplier ? <ChatSupplierResult receipt={turn.supplier} operator={operator} onOpen={()=>onOpenInquiry?.(turn.supplier!.inquiryId,conversationKey)} onImported={batch=>onInquiryCreated?.(batch,conversationKey)}/> : turn.inquiry ? <ChatInquiryReceipt result={turn.inquiry} onOpen={() => onOpenInquiry?.(turn.inquiry!.id, conversationKey)}/> : <ChatMarkdown text={turn.content}/>}
        </div>
      </article>)}
      {busy && <p role="status">{session?.creation ? '正在接收原件、提取物料并查询依据…' : '正在回复…'}</p>}
      {error && <p role="alert">{error}</p>}
      {session?.creation && !busy && <div className="chat-intake-recovery">
        <button className="btn" onClick={() => receiveInquiry(session.creation!)}>重试接收</button>
        <button className="btn" onClick={() => {patch({creation: undefined}); setError('');}}>放弃重试</button>
      </div>}
    </div>
    {standalone && <MessageRail container={chatScroll.containerRef} turns={turns}/>}
    <form ref={form} className="platform-chat-form" onSubmit={event => {event.preventDefault(); void send();}}>
      {references.composer}
      {attachments.length>0&&<ChatMaterialPurpose value={materialPurpose} onChange={setMaterialPurpose} disabled={busy||!!session?.creation}/> }
      <ChatFiles showPicker key={attachmentEpoch} disabled={busy || !!session?.creation} onChange={setAttachments} onRead={context => patch({context})}/>
      <textarea rows={2} aria-label="向平台助手提问" placeholder="输入消息…" maxLength={2000} disabled={!!session?.creation}
        onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
        value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229 && !event.repeat) {
            event.preventDefault(); void send();
          }
        }}/>
      {busy ? <button type="button" className="btn" onClick={() => request.current?.abort()}>停止</button> :
        <button aria-label="发送消息" className="chat-send" disabled={!!session?.creation || (!input.trim() && !attachments.length && !references.items.length) || attachments.some(file => file.status === 'reading')}>↑</button>}
    </form>
    {session?.supplierCreation&&<ChatSupplierFlow request={session.supplierCreation} onTarget={id=>patch({supplierCreation:{...session.supplierCreation!,inquiryId:id}})} onCancel={()=>patch({supplierCreation:undefined})} onReceived={receipt=>{append({role:'assistant',content:'',supplier:receipt});patch({supplierCreation:undefined,context:undefined});}}/>}
  </section>;
}
export function ConversationList({tasks,selected,onSelect,onNew}:{tasks:TaskSummary[];selected:string;onSelect:(key:string)=>void;onNew:()=>void}){
 const [sessions,setSessions]=useState(()=>readStored<Record<string,Session>>('rfq-chat-v1',{}));
 const [meta,setMeta]=useState(conversationMeta),[query,setQuery]=useState(''),[archived,setArchived]=useState(false);
 const [historyOpen,setHistoryOpen]=useState(false);
 const tools=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  const reload=()=>{setSessions(readStored('rfq-chat-v1',{}));setMeta(conversationMeta());};
  window.addEventListener('rfq-chat-updated',reload);
  return()=>window.removeEventListener('rfq-chat-updated',reload);
 },[]);
 useEffect(()=>{
  if(!historyOpen)return;
  const outside=(event:PointerEvent)=>{if(!tools.current?.contains(event.target as Node))setHistoryOpen(false);};
  document.addEventListener('pointerdown',outside);
  return()=>document.removeEventListener('pointerdown',outside);
 },[historyOpen]);
 const keys=[...new Set([...Object.keys(sessions),...Object.keys(meta)])];
 const records=keys.filter(key=>sessions[key]?.turns?.some(t=>t.role==='user')&&!!meta[key]?.archived===archived).sort((a,b)=>(sessions[b]?.turns.slice(-1)[0]?.createdAt||meta[b]?.createdAt||'').localeCompare(sessions[a]?.turns.slice(-1)[0]?.createdAt||meta[a]?.createdAt||'')).map(key=>{
  const turns=sessions[key]?.turns||[];
  const task=tasks.find(t=>Object.prototype.hasOwnProperty.call(meta[key]||{},'taskKey')?t.key===normalizeConversationTask(meta[key]?.taskKey || ''):key===t.key||key.startsWith(t.key+':line:'));
  const title=turns.find(t=>t.role==='user')?.content.split('\n')[0]||'文件询价';
  return {key,title,task,search:[title,task?.title,...turns.map(t=>t.content)].join(' ').toLowerCase()};
 }).filter(record=>record.search.includes(query.trim().toLowerCase()));
 const choose=(key:string)=>{onSelect(key);setHistoryOpen(false);trigger.current?.focus();};
 const recordList=()=><nav className="history-records" aria-label="历史会话">{records.map(record=><article className="history-record" key={record.key}>
  <button className={selected===record.key?'active':''} disabled={!record.key.startsWith('chat:')&&record.key!=='__no_task__'&&!record.task} onClick={()=>choose(record.key)}><strong title={record.title}>{record.title}</strong>{record.task&&<span title={record.task.title}>{record.task.title}</span>}</button>
  <button className="history-archive" onClick={()=>updateConversation(record.key,{archived:!archived})} aria-label={`${archived?'恢复':'归档'}对话 ${record.title}`}>{archived?'恢复':'归档'}</button>
 </article>)}{!records.length&&<p className="history-empty">{query.trim()?'没有匹配的对话':archived?'暂无归档对话':'暂无历史对话'}</p>}</nav>;
 const search=<input className="history-search" aria-label="搜索对话" placeholder="搜索对话或询价" value={query} onChange={e=>setQuery(e.target.value)}/>;
 return <div className="ai-conversation-tools" ref={tools} onKeyDown={event=>{if(event.key==='Escape'&&historyOpen){event.preventDefault();setHistoryOpen(false);trigger.current?.focus();}}}>
  <button ref={trigger} className="chat-history-open btn" aria-expanded={historyOpen} aria-controls="chat-history-panel" onClick={()=>{setHistoryOpen(!historyOpen);setArchived(false);setQuery('');}}>历史对话</button>
  <button className="chat-new" onClick={()=>{setArchived(false);setQuery('');setHistoryOpen(false);onNew();}}>新建对话 <span aria-hidden="true">＋</span></button>
  {historyOpen&&<section id="chat-history-panel" className="history-popover" aria-label="历史对话">
    {search}
    <div className="history-filters"><button className="btn" aria-pressed={!archived} onClick={()=>setArchived(false)}>最近</button><button className="btn" aria-pressed={archived} onClick={()=>setArchived(true)}>已归档</button></div>
    {recordList()}

  </section>}
 </div>;
}
export function ConversationTaskLink({tasks,taskKey,onLink}:{tasks:TaskSummary[];taskKey?:string;onLink:(key:string)=>void}){
 const [choosing,setChoosing]=useState(false),[query,setQuery]=useState('');const task=tasks.find(t=>t.key===taskKey),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(choosing&&!dialog.current?.open)dialog.current?.showModal();else if(!choosing&&dialog.current?.open)dialog.current.close();},[choosing]);
 return <div className="conversation-task-link">{task&&<span title={task.title}>{task.title}</span>}<button className="btn" onClick={()=>setChoosing(true)}>{task?'更换询价':'关联询价'}</button>{task&&<button className="btn" onClick={()=>onLink('')}>解除关联</button>}<dialog className="chat-history-dialog inquiry-link-dialog" ref={dialog} onCancel={()=>setChoosing(false)} onClose={()=>setChoosing(false)}><header><h2>选择询价</h2><button className="copilot-icon" aria-label="关闭询价选择" onClick={()=>setChoosing(false)}>×</button></header><input className="chat-history-search" aria-label="搜索关联询价" placeholder="搜索询价" value={query} onChange={e=>setQuery(e.target.value)}/><div className="conversation-task-choices">{tasks.filter(t=>`${t.title} ${t.customer}`.toLowerCase().includes(query.toLowerCase())).slice(0,12).map(t=><button className="btn" key={t.key} onClick={()=>{onLink(t.key);setChoosing(false);}}>{t.title}</button>)}</div></dialog></div>;
}
