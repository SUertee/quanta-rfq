import {accountStorageKey} from './persistence';
import {useEffect,useState} from 'react';
import {validateSignature,type QuoteSignature} from '../../shared/signature.mjs';

/** A signature is usable only for the exact current quote content. */
export function useQuoteSignature(taskKey:string,content:string) {
  const [basis,setBasis]=useState<{content:string;hash:string;storageKey:string}|null>(null);
  const [saved,setSaved]=useState<QuoteSignature|null>(null);
  const [error,setError]=useState('');
  const storageKey=accountStorageKey(`rfq-quote-signature:${taskKey}`);
  useEffect(()=>{
    let active=true;
    setError('');
    void (async()=>{
      try{
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content));
        const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
        if(!active)return;
        setBasis({content,hash,storageKey});
        let restored:QuoteSignature|null=null;
        try{const raw=localStorage.getItem(storageKey);if(raw)restored=validateSignature(JSON.parse(raw),hash);}catch{/* Changed or malformed signatures cannot confirm this quote. */}
        setSaved(restored);
      }catch{if(active){setBasis(null);setError('签名校验暂不可用，请刷新后重试');}}
    })();
    return()=>{active=false;};
  },[content,storageKey]);
  const currentBasis=basis?.content===content&&basis.storageKey===storageKey?basis.hash:null;
  const signature=saved?.basis===currentBasis?saved:null;
  const save=(value:QuoteSignature)=>{
    const validated=validateSignature(value,currentBasis||'');
    setSaved(validated);setError('');
    try{localStorage.setItem(storageKey,JSON.stringify(validated));}
    catch{setError('本机签名恢复未保存，导出时会保存服务端签名快照');}
  };
  const clear=()=>{
    setSaved(null);setError('');
    try{localStorage.removeItem(storageKey);}catch{setError('本机签名缓存未清除，请刷新后核对');}
  };
  return {basis:currentBasis,signature,save,clear,error};
}
