import { useEffect, useRef, useState } from 'react';
import { INQUIRY_STAGES } from '../engine/workflow';
import { readStored, useStoredState } from '../engine/persistence';
import { REFERENCE_MIME, readReference, type ChatReference } from '../engine/chatReferences';

export function ReferenceList({items,onRemove}:{items:ChatReference[];onRemove?:(id:string)=>void}) {
  if (!items.length) return null;
  return <div className="chat-references" aria-label="引用内容">{items.map(item=><blockquote key={item.id} className="chat-reference" title={`${item.label}\n${item.excerpt}`}>
    <svg className="chat-reference-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 12h8M8 16h6"/></svg>
    <div className="chat-reference-content"><strong>{item.stage ? INQUIRY_STAGES[item.stage - 1] : item.label}</strong><p>{item.excerpt}</p></div>
    {onRemove&&<button type="button" aria-label={`移除引用 ${item.label}`} onClick={()=>onRemove(item.id)}>×</button>}
  </blockquote>)}</div>;
}

/** References are drafts until sent and are stored with their conversation. */
export function useChatReferences(conversationKey:string,disabled:boolean) {
  const anchor=useRef<HTMLDivElement>(null);
  const [drafts,setDrafts]=useStoredState<Record<string,ChatReference[]>>('reference-drafts-v1',{});
  const [error,setError]=useState('');
  const callbacks=useRef({disabled,conversationKey});callbacks.current={disabled,conversationKey};
  const items=drafts[conversationKey]||[];
  useEffect(()=>{
    const root=anchor.current?.closest('.platform-chat,.rfq-chat');
    if (!root) return;
    const add=(value:unknown)=>{
      if (callbacks.current.disabled) return;
      const item=readReference(value);
      if (!item) { setError('引用内容无效，请重新选择');return; }
      const key=callbacks.current.conversationKey;
      // Read the latest stored drafts so simultaneous drag/click actions cannot overwrite one another.
      const current=readStored<Record<string,ChatReference[]>>('reference-drafts-v1',{});
      const existing=current[key]||[];
      if(existing.some(value=>value.id===item.id))return;
      if(existing.length>=6){setError('每次最多引用 6 项');return;}
      setError('');setDrafts({...current,[key]:[...existing,item]});
      root.querySelector<HTMLTextAreaElement>('textarea')?.focus({preventScroll:true});
    };
    const drop=(event:Event)=>{
      const drag=event as DragEvent;
      if(drag.dataTransfer?.files.length)return;
      const custom=drag.dataTransfer?.getData(REFERENCE_MIME);
      const text=drag.dataTransfer?.getData('text/plain');
      if(!custom&&!text?.trim())return;
      event.preventDefault();
      try { add(custom?JSON.parse(custom):{label:'选中文字',excerpt:text}); }
      catch {setError('引用内容无效，请重新选择');}
      root.removeAttribute('data-reference-drop');
    };
    const over=(event:Event)=>{
      const drag=event as DragEvent;
      if(!callbacks.current.disabled&&drag.dataTransfer?.types.some(type=>type===REFERENCE_MIME||type==='text/plain')){
        event.preventDefault();drag.dataTransfer.dropEffect='copy';root.setAttribute('data-reference-drop','true');
      }
    };
    const leave=(event:Event)=>{if(!root.contains((event as DragEvent).relatedTarget as Node))root.removeAttribute('data-reference-drop');};
    const cite=(event:Event)=>add((event as CustomEvent).detail);
    root.addEventListener('drop',drop);root.addEventListener('dragover',over);root.addEventListener('dragleave',leave);
    window.addEventListener('quanta-reference',cite);
    return()=>{root.removeEventListener('drop',drop);root.removeEventListener('dragover',over);root.removeEventListener('dragleave',leave);window.removeEventListener('quanta-reference',cite);};
  },[setDrafts]);
  const remove=(id:string)=>setDrafts(current=>({...current,[conversationKey]:(current[conversationKey]||[]).filter(item=>item.id!==id)}));
  const clear=()=>{setError('');setDrafts(current=>({...current,[conversationKey]:[]}));};
  const restore=(sent:ChatReference[])=>{
    if(!sent.length)return;
    setDrafts(current=>{
      const existing=current[conversationKey]||[];
      return {...current,[conversationKey]:[...existing,...sent.filter(item=>!existing.some(value=>value.id===item.id))].slice(0,6)};
    });
  };
  const composer=<div className="chat-reference-drafts" ref={anchor} hidden={!items.length&&!error}><ReferenceList items={items} onRemove={disabled?undefined:remove}/>{error&&<p role="alert">{error}</p>}</div>;
  return {items,clear,restore,composer};
}
