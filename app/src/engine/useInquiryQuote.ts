import {accountStorageKey} from './persistence';
import {canonicalJson} from '../../shared/quote-state.mjs';
import {useEffect,useRef,useState} from 'react';
import {appFetch} from './appUrl';
import type {PricingPolicy} from './pricingPolicy';
import type {QuoteDocument} from './quoteDocument';
import type {EstCost} from '../types';

export interface QuoteDraftState {document?:QuoteDocument;policy:PricingPolicy;lines:{key:string;price:number|null;manual:boolean;reviewed:boolean;skipped:boolean;manualCost:EstCost|null;selectedBasisId?:string|null}[];}
interface Reply {version:number;sourceFingerprint:string;state:QuoteDraftState|null;stale:boolean;}
interface Pending {requestId:string;version:number;sourceFingerprint:string;state:QuoteDraftState;}
interface Slot {id:string;sourceRevision:string;version:number;sourceFingerprint:string;last:string;pending:QuoteDraftState|null;pendingId:string;flight:Promise<void>|null;timer:ReturnType<typeof setTimeout>|null;error:string;conflict:boolean;}
const journalKey=(id:string)=>accountStorageKey(`rfq-quote-pending:${id}`);
const messageOf=(error:unknown)=>error instanceof Error?error.message:'报价保存失败，请重试';

/** Serial writes, optimistic concurrency and a local journal preserve unfinished edits. */
export function useInquiryQuote({inquiryId,sourceRevision,value,operator,onRestore}:{inquiryId?:string;sourceRevision:string;value:QuoteDraftState;operator:string;onRestore:(value:QuoteDraftState)=>void}) {
  const [reload,setReload]=useState(0),[readyKey,setReadyKey]=useState(''),[notice,setNotice]=useState({id:'',version:0,error:'',saving:false,conflict:false});
  const key=inquiryId?`${inquiryId}:${sourceRevision}:${reload}`:'';
  const latest=useRef({inquiryId,key,value,operator,onRestore});latest.current={inquiryId,key,value,operator,onRestore};
  const slots=useRef(new Map<string,Slot>());
  const loading=useRef(false);
  const notify=(slot:Slot)=>{if(latest.current.inquiryId===slot.id)setNotice({id:slot.id,version:slot.version,error:slot.error,saving:!slot.error&&(!!slot.flight||!!slot.pending),conflict:slot.conflict});};
  const journal=(slot:Slot)=>{
    if(!slot.pending)return;
    localStorage.setItem(journalKey(slot.id),JSON.stringify({requestId:slot.pendingId,version:slot.version,sourceFingerprint:slot.sourceFingerprint,state:slot.pending}));
  };
  const flush=(slot:Slot):Promise<void>=>{
    if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}
    if(slot.flight)return slot.flight;
    if(!slot.pending||slot.error)return Promise.resolve();
    slot.flight=(async()=>{
      while(slot.pending&&!slot.error){
        const sent=slot.pending,sentId=slot.pendingId;slot.pending=null;
        try{
          const response=await appFetch(`/api/inquiries/${slot.id}/quote`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:sentId,version:slot.version,sourceFingerprint:slot.sourceFingerprint,operator:latest.current.operator||'local-user',...sent})});
          const reply=await response.json();
          if(!response.ok){slot.conflict=response.status===409;throw new Error(reply.error||'报价保存失败');}
          slot.version=reply.version;slot.sourceFingerprint=reply.sourceFingerprint;slot.last=canonicalJson(reply.state);
          if(latest.current.inquiryId===slot.id&&canonicalJson(latest.current.value)===canonicalJson(sent)&&reply.state)latest.current.onRestore(reply.state);
          if(slot.pending)journal(slot);else localStorage.removeItem(journalKey(slot.id));
        }catch(error){if(!slot.pending){slot.pending=sent;slot.pendingId=sentId;}slot.error=messageOf(error);try{journal(slot);}catch{slot.error+='；本机恢复记录也未保存，请保持页面打开';}}
      }
    })().finally(()=>{slot.flight=null;notify(slot);});
    notify(slot);return slot.flight;
  };
  useEffect(()=>{
    if(!inquiryId)return;
    let active=true;loading.current=true;setReadyKey('');
    const slot=slots.current.get(inquiryId)||{id:inquiryId,sourceRevision:'',version:0,sourceFingerprint:'',last:'',pending:null,pendingId:'',flight:null,timer:null,error:'',conflict:false};
    slots.current.set(inquiryId,slot);
    void(async()=>{
      try{
        await flush(slot);
        if(!active)return;
        const response=await appFetch(`/api/inquiries/${inquiryId}/quote`),reply:Reply=await response.json();
        if(!response.ok)throw new Error('无法载入询价审核，请重试');
        if(!active)return;
        let pending:Pending|null=null;
        const raw=localStorage.getItem(journalKey(inquiryId));
        if(raw){try{pending=JSON.parse(raw);}catch{slot.conflict=true;throw new Error('本机未完成的报价记录无法读取，请载入服务端版本');}}
        if(pending&&slot.sourceRevision&&slot.sourceRevision!==sourceRevision&&pending.sourceFingerprint!==reply.sourceFingerprint){pending=null;slot.pending=null;localStorage.removeItem(journalKey(inquiryId));}
        if(pending&&canonicalJson(pending.state)!==canonicalJson(reply.state)&&(pending.version!==reply.version||pending.sourceFingerprint!==reply.sourceFingerprint)){slot.conflict=true;throw new Error('未保存的修改与服务端版本不同，请核对后载入服务端版本');}
        slot.sourceRevision=sourceRevision;slot.version=reply.version;slot.sourceFingerprint=reply.sourceFingerprint;slot.error='';slot.conflict=false;
        if(pending&&canonicalJson(pending.state)!==canonicalJson(reply.state)){
          slot.pending=pending.state;slot.pendingId=pending.requestId;await flush(slot);
          if(slot.error)throw new Error(slot.error);
          if(!active)return;
          const restored=await appFetch(`/api/inquiries/${inquiryId}/quote`);if(!restored.ok)throw new Error('报价已保存，恢复显示失败，请重试');
          const saved:Reply=await restored.json();slot.last=canonicalJson(saved.state);if(saved.state)latest.current.onRestore(saved.state);
        }else{
          localStorage.removeItem(journalKey(inquiryId));
          const state=reply.state||{...latest.current.value,lines:latest.current.value.lines.map(line=>({...line,reviewed:false}))};
          slot.last=reply.state&&!reply.stale?canonicalJson(state):'';
          latest.current.onRestore(state);
        }
        loading.current=false;setReadyKey(key);notify(slot);
      }catch(error){if(active){slot.error=messageOf(error);notify(slot);}}
    })();
    return()=>{active=false;void flush(slot);};
  },[key]);
  const serialized=canonicalJson(value);
  useEffect(()=>{
    if(!inquiryId||readyKey!==key||loading.current)return;
    const slot=slots.current.get(inquiryId);if(!slot||serialized===slot.last)return;
    slot.pending=JSON.parse(serialized);slot.pendingId=crypto.randomUUID();
    try{journal(slot);}catch{slot.error='本机恢复记录保存失败，请保持页面打开并重试';notify(slot);return;}
    if(slot.timer)clearTimeout(slot.timer);
    slot.timer=setTimeout(()=>{void flush(slot);},200);notify(slot);
  },[inquiryId,key,readyKey,serialized]);
  const status=notice.id===inquiryId?notice:{version:0,error:'',saving:false,conflict:false};
  const retry=()=>{const slot=inquiryId?slots.current.get(inquiryId):null;if(slot){slot.error='';slot.conflict=false;}setReload(number=>number+1);};
  const loadServer=()=>{
    if(inquiryId){const slot=slots.current.get(inquiryId);if(slot){slot.pending=null;slot.error='';slot.conflict=false;}localStorage.removeItem(journalKey(inquiryId));}
    setReload(number=>number+1);
  };
  return {version:status.version,ready:!inquiryId||(readyKey===key&&!loading.current),error:status.error,saving:!!inquiryId&&!status.error&&(status.saving||(readyKey===key&&serialized!==slots.current.get(inquiryId)?.last)),conflict:status.conflict,retry,loadServer};
}
