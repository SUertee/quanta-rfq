import type { DragEvent } from 'react';

export const REFERENCE_MIME = 'application/x-quanta-reference';
export type ChatReference = {
  id: string;
  label: string;
  excerpt: string;
  inquiryId?: string;
  lineId?: string;
  contentId?: string;
  evidenceId?: string;
  version?: number;
  matchedAt?: string;
  stage?:number;
  stageVersion?:string;
  draftVersion?:number;
};

export function readReference(value: unknown): ChatReference | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.label !== 'string' || typeof item.excerpt !== 'string' || !item.excerpt.trim()) return null;
  const reference: ChatReference = { id: typeof item.id === 'string' ? item.id.slice(0,200) : crypto.randomUUID(), label: item.label.slice(0,200), excerpt: item.excerpt.slice(0,2000) };
  for (const field of ['inquiryId','lineId','contentId','evidenceId','matchedAt','stageVersion'] as const) {
    if (typeof item[field] === 'string') reference[field] = item[field].slice(0,200);
  }
  if (Number.isInteger(item.version) && Number(item.version)>0) reference.version=Number(item.version);
  if(Number.isInteger(item.stage)&&Number(item.stage)>=1&&Number(item.stage)<=6)reference.stage=Number(item.stage);
  if(Number.isInteger(item.draftVersion)&&Number(item.draftVersion)>=0)reference.draftVersion=Number(item.draftVersion);
  return reference;
}

export function dragReference(event: DragEvent, reference: ChatReference) {
  event.dataTransfer.setData(REFERENCE_MIME, JSON.stringify(reference));
  event.dataTransfer.setData('text/plain', reference.excerpt);
  event.dataTransfer.effectAllowed='copy';
}

export function citeReference(reference: ChatReference) {
  window.dispatchEvent(new CustomEvent('quanta-reference', { detail: reference }));
}

export function conversationReferences(drafts:ChatReference[], turns:readonly {role:string;references?:ChatReference[]}[]) {
  if(drafts.length)return drafts;
  return [...turns].reverse().find(turn=>turn.role==='user'&&turn.references?.length)?.references||[];
}
