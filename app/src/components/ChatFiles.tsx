import {appFetch as fetch} from '../engine/appUrl';
import {useEffect,useRef,useState} from 'react';
import {saveChatFile,type ChatAttachment} from '../engine/chatAttachments';
import {ChatAttachmentPreview} from './ChatAttachmentPreview';
export function ChatFiles({onRead,onChange,excerptLimit=24000,disabled=false,showPicker=false}:{showPicker?:boolean;excerptLimit?:number;disabled?:boolean;onRead:(text:string)=>void;onChange?:(files:ChatAttachment[])=>void}){
 const area=useRef<HTMLDivElement>(null),live=useRef(true),items=useRef<ChatAttachment[]>([]),callbacks=useRef({onRead,onChange});callbacks.current={onRead,onChange};
 const filePicker=useRef<HTMLInputElement>(null),imagePicker=useRef<HTMLInputElement>(null);
 const [files,setFiles]=useState<ChatAttachment[]>([]),[error,setError]=useState('');
 useEffect(()=>{live.current=true;return()=>{live.current=false;}},[]);
 const publish=(next:ChatAttachment[])=>{if(!live.current)return;items.current=next;setFiles(next);callbacks.current.onChange?.(next);callbacks.current.onRead(next.filter(f=>f.text).map(f=>`附件 ${f.name}\n${f.text}`).join('\n\n').slice(0,excerptLimit));};
 const read=async(incoming:File[])=>{
  if(disabled||!incoming.length)return;
  if(items.current.length+incoming.length>6||incoming.some(f=>f.size>8*1024*1024)||items.current.reduce((n,f)=>n+f.size,0)+incoming.reduce((n,f)=>n+f.size,0)>24*1024*1024){setError('最多6个文件，每个8MB，总计24MB');return;}
  const added:ChatAttachment[]=incoming.map(f=>({id:crypto.randomUUID(),name:f.name,mime:f.type,size:f.size,status:'reading'}));setError('');
  try{
   await Promise.all(incoming.map((f,i)=>saveChatFile(added[i].id,f)));
   if(!live.current)return;publish([...items.current,...added]);
   // Display the local preview immediately; parsing runs independently.
   setFiles([...items.current]);
   const entries=await Promise.all(incoming.map(f=>new Promise<{name:string;mime:string;base64:string}>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:f.name,mime:f.type,base64:String(r.result).split(',')[1]});r.onerror=()=>reject(Error('读取文件失败'));r.readAsDataURL(f);})));const response=await fetch('/api/assistant/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:entries}),signal:AbortSignal.timeout(120000)});const result=await response.json();if(!response.ok)throw Error(result.error||'文件解析失败');
   publish(items.current.map(file=>{const index=added.findIndex(f=>f.id===file.id);if(index<0)return file;const parsed=result.files[index];return {...file,text:parsed.text,status:parsed.text?'ready':'unread',error:parsed.error||(parsed.truncated?'聊天使用内容节选':undefined)};}));
  }catch(e){if(live.current)setError(e instanceof Error?e.message:String(e));publish(items.current.map(f=>added.some(a=>a.id===f.id)?{...f,status:'unread',error:e instanceof Error?e.message:String(e)}:f));}
 };
 useEffect(()=>{const root=area.current?.closest('.platform-chat,.rfq-chat');if(!root)return;const paste=(event:Event)=>{const e=event as ClipboardEvent;const added=Array.from(e.clipboardData?.files||[]);if(added.length){e.preventDefault();void read(added);}};const drop=(event:Event)=>{const e=event as DragEvent;if(e.dataTransfer?.files.length){e.preventDefault();void read(Array.from(e.dataTransfer.files));}};const over=(e:Event)=>{if((e as DragEvent).dataTransfer?.types.includes('Files'))e.preventDefault();};root.addEventListener('paste',paste);root.addEventListener('drop',drop);root.addEventListener('dragover',over);return()=>{root.removeEventListener('paste',paste);root.removeEventListener('drop',drop);root.removeEventListener('dragover',over);};},[disabled,excerptLimit]);
 return <div className="chat-files-inline" hidden={!showPicker&&!files.length&&!error} ref={area}><div className="chat-attachment-strip">{files.map(file=><ChatAttachmentPreview key={file.id} attachment={file} onRemove={disabled?undefined:()=>publish(items.current.filter(f=>f.id!==file.id))}/>)}</div>{error&&<p role="alert">{error}</p>}{showPicker&&<div className="chat-upload-actions"><button type="button" disabled={disabled} onClick={()=>filePicker.current?.click()}>上传文件</button><button type="button" disabled={disabled} onClick={()=>imagePicker.current?.click()}>图片</button><input ref={filePicker} type="file" hidden multiple aria-label="选择聊天文件" accept=".pdf,.xlsx,.xls,.csv,.tsv,.eml,.txt,.md,image/*" onChange={e=>{void read(Array.from(e.currentTarget.files||[]));e.currentTarget.value='';}}/><input ref={imagePicker} type="file" hidden multiple aria-label="选择聊天图片" accept="image/*" onChange={e=>{void read(Array.from(e.currentTarget.files||[]));e.currentTarget.value='';}}/></div>}</div>;
}
