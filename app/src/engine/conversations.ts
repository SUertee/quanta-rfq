import {readStored,workspaceStorageKey} from './persistence';
export type ConversationMeta={createdAt:string;lastOpenedAt?:string;archived?:boolean;taskKey?:string|null};
export const conversationMeta=()=>readStored<Record<string,ConversationMeta>>('chat-meta-v1',{});
export function updateConversation(key:string,patch:Partial<ConversationMeta>){
 const next={...conversationMeta()};next[key]={...next[key],...patch,createdAt:patch.createdAt||next[key]?.createdAt||new Date().toISOString()};
 try{localStorage.setItem(workspaceStorageKey('chat-meta-v1'),JSON.stringify(next));}catch{window.dispatchEvent(new Event('quanta-save-failed'));return false;}
 window.dispatchEvent(new Event('rfq-chat-updated'));return true;
}
export function newConversation(){const key='chat:'+crypto.randomUUID();return updateConversation(key,{createdAt:new Date().toISOString()})?key:null;}

export function normalizeConversationTask(key: string) {
  return key.replace(/^(email|kanban):/, '$1-');
}

/** Resume the latest active inquiry conversation, including conversations made before metadata existed. */
export function inquiryConversation(taskKey: string, preferredKey?: string | null) {
  taskKey = normalizeConversationTask(taskKey);
  const metadata = conversationMeta();
  const sessions = readStored<Record<string, { turns?: { createdAt?: string }[] }>>('rfq-chat-v1', {});
  const belongsToTask = (key: string) => {
    const linked = normalizeConversationTask(metadata[key]?.taskKey || key);
    return linked === taskKey || linked.startsWith(taskKey + ':line:');
  };
  if (preferredKey && belongsToTask(preferredKey) && !metadata[preferredKey]?.archived) return preferredKey;
  const candidates = [...new Set([...Object.keys(metadata), ...Object.keys(sessions)])]
    .filter(key => belongsToTask(key) && !metadata[key]?.archived);
  const latestTime = (key: string) => {
    const turnTime = sessions[key]?.turns?.slice(-1)[0]?.createdAt || metadata[key]?.createdAt || '';
    const openedAt = metadata[key]?.lastOpenedAt || '';
    return openedAt > turnTime ? openedAt : turnTime;
  };
  candidates.sort((a, b) => latestTime(b).localeCompare(latestTime(a)));
  if (candidates.length) return candidates[0];
  if (!metadata[taskKey]?.archived) return taskKey;
  const key = newConversation();
  if (key) updateConversation(key, { taskKey });
  return key || taskKey;
}

export function clearConversationReferences(...keys: (string | null | undefined)[]) {
  const drafts = readStored<Record<string, unknown>>('reference-drafts-v1', {});
  for (const key of keys) if (key) delete drafts[key];
  try {
    localStorage.setItem(workspaceStorageKey('reference-drafts-v1'), JSON.stringify(drafts));
  } catch {
    window.dispatchEvent(new Event('quanta-save-failed'));
  }
}
