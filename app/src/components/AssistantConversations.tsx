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
export function PlatformChat({standalone=false,onNewInquiry,conversationKey='__no_task__',quickMessage,onQuickHandled,onClose,onHistory}:{standalone?:boolean;onNewInquiry?:()=>void;conversationKey?:string;quickMessage:{id:number;text:string}|null;onQuickHandled:()=>void;onClose:()=>void;onHistory:()=>void}){
 const [sessions,setSessions]=useStoredState<Record<string,Session>>('rfq-chat-v1',{});
 const [attachments,setAttachments]=useState<ChatAttachment[]>([]),[attachmentEpoch,setAttachmentEpoch]=useState(0);
 const [input,setInput]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
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
 return <section className={`platform-chat ${standalone?'standalone-chat':''}`} aria-label="AI 对话">{!standalone&&<header className="copilot-header"><strong>报价助手</strong><div><button className="copilot-icon" aria-label="对话记录" onClick={onHistory}>☷</button><button className="copilot-icon" aria-label="收起报价助手" onClick={onClose}>−</button></div></header>}<div className="platform-chat-messages" ref={chatScroll.containerRef} onScroll={chatScroll.onScroll}>{!turns.length&&<div className="chat-start">{standalone&&<h1>今天需要处理哪份询价？</h1>}<div>{onNewInquiry&&<button className="btn" onClick={onNewInquiry}>上传询价 ↗</button>}<button className="btn" onClick={()=>send('怎样从上传询价到生成报价单？')}>了解报价流程 ↗</button></div></div>}{turns.map((turn,i)=><article className={`rfq-chat-turn ${turn.role}`} key={i}><strong>{turn.role==='user'?'你':'Quanta'}</strong>{turn.attachments&&<div className="chat-attachment-strip">{turn.attachments.map(file=><ChatAttachmentPreview key={file.id} attachment={file}/>)}</div>}<ChatMarkdown text={turn.content}/></article>)}{busy&&<p role="status">正在回复…</p>}{error&&<p role="alert">{error}</p>}</div><form className="platform-chat-form" onSubmit={e=>{e.preventDefault();void send();}}><ChatFiles key={attachmentEpoch} disabled={busy} onChange={setAttachments} onRead={text=>setSessions(old=>({...old,[conversationKey]:{...old[conversationKey],turns:old[conversationKey]?.turns||[],context:text}}))}/><textarea rows={2} aria-label="向平台助手提问" placeholder="输入消息…" maxLength={2000} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&!composing.current&&e.keyCode!==229&&!e.repeat){e.preventDefault();void send();}}}/>{busy?<button type="button" className="btn" onClick={()=>{request.current?.abort();}}>停止</button>:<button aria-label="发送消息" className="chat-send" disabled={(!input.trim()&&!attachments.length)||attachments.some(f=>f.status==='reading')}>↑</button>}</form></section>;
}
export function ConversationList({tasks,selected,onSelect,onNew}:{tasks:TaskSummary[];selected:string;onSelect:(key:string)=>void;onNew:()=>void}){
 const [sessions,setSessions]=useState(()=>readStored<Record<string,Session>>('rfq-chat-v1',{}));
 const [meta,setMeta]=useState(conversationMeta),[query,setQuery]=useState(''),[archived,setArchived]=useState(false);
 useEffect(()=>{const reload=()=>{setSessions(readStored('rfq-chat-v1',{}));setMeta(conversationMeta());};window.addEventListener('rfq-chat-updated',reload);return()=>window.removeEventListener('rfq-chat-updated',reload);},[]);
 const [historyOpen,setHistoryOpen]=useState(false);const historyDialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=historyDialog.current;if(historyOpen&&!dialog?.open)dialog?.showModal();else if(!historyOpen&&dialog?.open)dialog.close();},[historyOpen]);
 const keys=[...new Set([...Object.keys(sessions),...Object.keys(meta)])];
 const records=keys.filter(key=>sessions[key]?.turns?.some(t=>t.role==='user')&&!!meta[key]?.archived===archived).sort((a,b)=>(sessions[b]?.turns.slice(-1)[0]?.createdAt||meta[b]?.createdAt||'').localeCompare(sessions[a]?.turns.slice(-1)[0]?.createdAt||meta[a]?.createdAt||''));
 return <div className="ai-conversation-tools"><button className="chat-new" onClick={()=>{setArchived(false);setQuery('');setHistoryOpen(false);onNew();}}>新建对话 <span aria-hidden="true">＋</span></button><button className="chat-history-open btn" onClick={()=>setHistoryOpen(true)}>历史</button><dialog className="chat-history-dialog" ref={historyDialog} onCancel={()=>setHistoryOpen(false)} onClose={()=>setHistoryOpen(false)}><header><h2>历史对话</h2><button className="copilot-icon" aria-label="关闭历史对话" onClick={()=>setHistoryOpen(false)}>×</button></header><div className="ai-conversation-list"><input className="chat-history-search" aria-label="搜索对话" placeholder="搜索对话或询价" value={query} onChange={e=>setQuery(e.target.value)}/><div className="chat-history-filters"><button className="btn" aria-pressed={!archived} onClick={()=>setArchived(false)}>最近</button><button className="btn" aria-pressed={archived} onClick={()=>setArchived(true)}>已归档</button></div><nav aria-label="历史会话">{records.map(key=>{const turns=sessions[key]?.turns||[],task=tasks.find(t=>Object.prototype.hasOwnProperty.call(meta[key]||{},'taskKey')?t.key===meta[key]?.taskKey:key===t.key||key.startsWith(t.key+':line:'));const title=turns.find(t=>t.role==='user')?.content.split('\n')[0].slice(0,32)||'新建对话';if(![title,task?.title,...turns.map(t=>t.content)].join(' ').toLowerCase().includes(query.toLowerCase()))return null;return <article className="conversation-list-row" key={key}><button disabled={!key.startsWith('chat:')&&key!=='__no_task__'&&!task} className={selected===key?'active':''} onClick={()=>{onSelect(key);setHistoryOpen(false);}}><strong>{title}</strong><span>{task?.title||''}</span></button><button className="conversation-archive" onClick={()=>updateConversation(key,{archived:!archived})} aria-label={`${archived?'恢复':'归档'}对话 ${title}`}>{archived?'恢复':'归档'}</button></article>;})}{!records.length&&<p>{archived?'暂无归档对话':'暂无对话'}</p>}</nav></div></dialog></div>;
}
export function ConversationTaskLink({tasks,taskKey,onLink}:{tasks:TaskSummary[];taskKey?:string;onLink:(key:string)=>void}){
 const [choosing,setChoosing]=useState(false),[query,setQuery]=useState('');const task=tasks.find(t=>t.key===taskKey),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(choosing&&!dialog.current?.open)dialog.current?.showModal();else if(!choosing&&dialog.current?.open)dialog.current.close();},[choosing]);
 return <div className="conversation-task-link">{task&&<span title={task.title}>{task.title}</span>}<button className="btn" onClick={()=>setChoosing(true)}>{task?'更换询价':'关联询价'}</button>{task&&<button className="btn" onClick={()=>onLink('')}>解除关联</button>}<dialog className="chat-history-dialog inquiry-link-dialog" ref={dialog} onCancel={()=>setChoosing(false)} onClose={()=>setChoosing(false)}><header><h2>选择询价</h2><button className="copilot-icon" aria-label="关闭询价选择" onClick={()=>setChoosing(false)}>×</button></header><input className="chat-history-search" aria-label="搜索关联询价" placeholder="搜索询价" value={query} onChange={e=>setQuery(e.target.value)}/><div className="conversation-task-choices">{tasks.filter(t=>`${t.title} ${t.customer}`.toLowerCase().includes(query.toLowerCase())).slice(0,12).map(t=><button className="btn" key={t.key} onClick={()=>{onLink(t.key);setChoosing(false);}}>{t.title}</button>)}</div></dialog></div>;
}
