import {MessageRail} from './MessageRail';
import {useChatScroll} from '../engine/useChatScroll';
import {appFetch as fetch} from '../engine/appUrl';
import {ChatAttachmentPreview} from './ChatAttachmentPreview';
import type {ChatAttachment} from '../engine/chatAttachments';
import {ChatMarkdown} from './ChatMarkdown';
import {readChatStream} from '../engine/chatStream';
import {ChatFiles} from './ChatFiles';
import {conversationMeta,updateConversation} from '../engine/conversations';
import {useEffect,useRef,useState} from 'react';
import {readStored,useStoredState} from '../engine/persistence';
import type {TaskSummary} from '../task';
type Turn={attachments?:ChatAttachment[];role:'user'|'assistant';content:string;createdAt?:string};
type Session={context?:string;turns:Turn[];state?:string;input?:string};
export function PlatformChat({standalone=false,docked=false,onDock,onNewInquiry,conversationKey='__no_task__',quickMessage,onQuickHandled,onClose,onHistory}:{standalone?:boolean;docked?:boolean;onDock?:()=>void;onNewInquiry?:()=>void;conversationKey?:string;quickMessage:{id:number;text:string}|null;onQuickHandled:()=>void;onClose:()=>void;onHistory:()=>void}){
 const [sessions,setSessions]=useStoredState<Record<string,Session>>('rfq-chat-v1',{});
 const [attachments,setAttachments]=useState<ChatAttachment[]>([]),[attachmentEpoch,setAttachmentEpoch]=useState(0);
 const [input,setInputState]=useState(sessions[conversationKey]?.input||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const setInput=(value:string)=>{setInputState(value);setSessions(old=>({...old,[conversationKey]:{...old[conversationKey],turns:old[conversationKey]?.turns||[],input:value}}));};
 const seen=useRef<number|null>(null),request=useRef<AbortController|null>(null),pending=useRef(false),composing=useRef(false);
 useEffect(()=>{window.dispatchEvent(new Event('rfq-chat-updated'));},[sessions]);
 const turns=sessions[conversationKey]?.turns||[];
 const chatScroll=useChatScroll(turns);
 const append=(turn:Turn)=>setSessions(old=>({...old,[conversationKey]:{...old[conversationKey],turns:[...(old[conversationKey]?.turns||[]),{...turn,createdAt:new Date().toISOString()}]}}));
 const send=async(text=input)=>{
  if((!text.trim()&&!attachments.length)||attachments.some(f=>f.status==='reading')||pending.current)return;pending.current=true;chatScroll.follow.current=true;setBusy(true);setError('');setInput('');
  const controller=new AbortController();request.current=controller;
  append({role:'user',content:text.trim(),attachments});setAttachments([]);setAttachmentEpoch(n=>n+1);append({role:'assistant',content:''});
  try{
   const r=await fetch('/api/assistant/chat',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},signal:controller.signal,body:JSON.stringify({instruction:text.trim()||(attachments.some(f=>f.status==='ready')?'请根据附件内容简洁总结需求；未识别的附件不要推断。':'附件未能读取，请说明需要提供清晰图片或文字。'),context:sessions[conversationKey]?.context,history:turns.filter(t=>t.content.trim()).slice(-6).map(t=>({role:t.role,content:t.content.slice(0,2000)}))})});
   await readChatStream(r,content=>{if(controller.signal.aborted)return;setSessions(old=>{const session=old[conversationKey];if(!session)return old;const updated=[...session.turns];const last=updated.length-1;if(updated[last]?.role!=='assistant')return old;updated[last]={...updated[last],content};return {...old,[conversationKey]:{...session,turns:updated}};});});
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));}
  finally{pending.current=false;setBusy(false);}
 };
 useEffect(()=>{if(quickMessage&&seen.current!==quickMessage.id){seen.current=quickMessage.id;onQuickHandled();void send(quickMessage.text);}},[quickMessage]);
 useEffect(()=>()=>request.current?.abort(),[]);
 return <section className={`platform-chat ${standalone?'standalone-chat':''}`} aria-label="AI 对话">{!standalone&&<header className="copilot-header"><strong>报价助手</strong><div><button className="copilot-icon" aria-label="打开 AI 对话页" title="打开 AI 对话页" onClick={onHistory}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 18 6M8 6h10v10"/></svg></button><button className="copilot-icon" aria-label={docked?'恢复浮窗':'展开到右侧'} title={docked?'恢复浮窗':'展开到右侧'} onClick={onDock}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={docked?'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5':'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'} /></svg></button><button className="copilot-icon" aria-label="收起报价助手" title="收起报价助手" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button></div></header>}<div className="platform-chat-messages" ref={chatScroll.containerRef} onScroll={chatScroll.onScroll}>{!turns.length&&<div className="chat-start">{standalone&&<h1>今天需要处理哪份询价？</h1>}<div>{onNewInquiry&&<button className="btn" onClick={onNewInquiry}>上传询价 ↗</button>}<button className="btn" onClick={()=>send('怎样从上传询价到生成报价单？')}>了解报价流程 ↗</button></div></div>}{turns.map((turn,i)=><article className={`rfq-chat-turn ${turn.role}`} key={i}>{turn.role==='assistant'&&<div className="rfq-chat-speaker">Quanta</div>}<div className="rfq-chat-text">{turn.attachments&&<div className="chat-attachment-strip">{turn.attachments.map(file=><ChatAttachmentPreview key={file.id} attachment={file}/>)}</div>}<ChatMarkdown text={turn.content}/></div></article>)}{busy&&<p role="status">正在回复…</p>}{error&&<p role="alert">{error}</p>}</div>{(standalone||docked)&&<MessageRail container={chatScroll.containerRef} turns={turns}/>}<form className="platform-chat-form" onSubmit={e=>{e.preventDefault();void send();}}><ChatFiles showPicker key={attachmentEpoch} disabled={busy} onChange={setAttachments} onRead={text=>setSessions(old=>({...old,[conversationKey]:{...old[conversationKey],turns:old[conversationKey]?.turns||[],context:text}}))}/><textarea rows={2} aria-label="向平台助手提问" placeholder="输入消息…" maxLength={2000} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&!composing.current&&e.keyCode!==229&&!e.repeat){e.preventDefault();void send();}}}/>{busy?<button type="button" className="btn" onClick={()=>{request.current?.abort();}}>停止</button>:<button aria-label="发送消息" className="chat-send" disabled={(!input.trim()&&!attachments.length)||attachments.some(f=>f.status==='reading')}>↑</button>}</form></section>;
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
  const task=tasks.find(t=>Object.prototype.hasOwnProperty.call(meta[key]||{},'taskKey')?t.key===meta[key]?.taskKey:key===t.key||key.startsWith(t.key+':line:'));
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
