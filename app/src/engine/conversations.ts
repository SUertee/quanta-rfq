import {readStored} from './persistence';
export type ConversationMeta={createdAt:string;archived?:boolean;taskKey?:string|null};
export const conversationMeta=()=>readStored<Record<string,ConversationMeta>>('chat-meta-v1',{});
export function updateConversation(key:string,patch:Partial<ConversationMeta>){
 const next={...conversationMeta()};next[key]={...next[key],...patch,createdAt:patch.createdAt||next[key]?.createdAt||new Date().toISOString()};
 try{localStorage.setItem('quanta-workspace-v1:chat-meta-v1',JSON.stringify(next));}catch{window.dispatchEvent(new Event('quanta-save-failed'));return false;}
 window.dispatchEvent(new Event('rfq-chat-updated'));return true;
}
export function newConversation(){const key='chat:'+crypto.randomUUID();return updateConversation(key,{createdAt:new Date().toISOString()})?key:null;}
