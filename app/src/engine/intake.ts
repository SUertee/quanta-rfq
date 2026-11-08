import {appFetch as fetch} from './appUrl';
import type { EmailSample } from "../types";
import type { RawRow } from "./parse";
export interface FieldSourceEvidence {contentId:string|null;method:string;value?:string|number|null;locator?:Record<string,unknown>}
export interface IntakeBatch {
  id: string;
  title: string;
  source: string;
  operator: string;
  created_at: string;
  status: string;
  issues: string[];
  files: {
    id: string;
    name: string;
    source: string;
    file_type: string;
    document_type: string;
    status: string;
    parent_id: string | null;
    error: string | null;
    metadata: { subject?: string; from?: string; to?: string; date?: string };
  }[];
  contents: {
    id: string;
    file_id: string;
    text: string;
    cells?: string[];
    locator: Record<string, unknown>;
  }[];
  lines: (Partial<RawRow> & {
    id: string;
    version?: number;
    contentId: string;
    method: string;
    rawFields?: Record<string, unknown>;
    fieldSources?: Record<string, { contentId: string | null; method: string; locator?: Record<string, unknown>; confirmation?:{value:unknown;reason:string;operator:string;at:string;version:number}; sources?: FieldSourceEvidence[];rejectedSources?:FieldSourceEvidence[];previousSources?:FieldSourceEvidence[] }>;
    normalizationVersion?: string;
    rawFieldsStatus?: string;
  })[];
}
export function batchEmail(b: IntakeBatch): EmailSample {
  const mail = b.files.find(
    (f) => f.metadata.subject || f.metadata.from,
  )?.metadata;
  return {
    id: "intake-" + b.id,
    caseNo: 0,
    intakeBatchId: b.id,
    intakeStatus: b.status,
    intakeIssues: b.issues,
    file: b.files.map((f) => f.name).join(", "),
    subject: mail?.subject || b.title,
    from: mail?.from || "客户待补",
    to: mail?.to || "",
    date: mail?.date || b.created_at,
    body: b.contents.map((c) => c.text).join("\n"),
    attachments: b.files.map((f) => f.name),
    parsedRows: b.lines.map(
      (l, i) =>
        ({
          ...l,
          lineNo: i + 1,
          raw: l.raw || "",
          issues: l.issues || [],
          persistedLineId: l.id,
          llmFixed: l.method === "llm",
        }) as RawRow,
    ),
  };
}
export async function loadIntakeEmails(): Promise<EmailSample[]> {
  const r = await fetch("/api/inquiries");
  if (!r.ok) throw new Error("无法读取服务端询价记录");
  const { inquiries } = (await r.json()) as { inquiries: { id: string }[] };
  return Promise.all(
    inquiries.map(async (b) => {
      const d = await fetch("/api/inquiries/" + encodeURIComponent(b.id));
      if (!d.ok) throw new Error("无法恢复询价记录");
      return batchEmail(await d.json());
    }),
  );
}
export async function createIntake(
  files: File[],
  text: string,
  operator: string,
  requestId: string,
  options: {source?: 'manual_upload' | 'paste' | 'chat'; signal?: AbortSignal} = {},
) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(240000)])
    : AbortSignal.timeout(240000);
  signal.throwIfAborted();
  const entries = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      mime: f.type,
      base64: await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
        fr.onerror = () => reject(new Error("文件读取失败"));
        fr.readAsDataURL(f);
      }),
    })),
  );
  if (text.trim())
    entries.push({
      name: "询价补充.txt",
      mime: "text/plain",
      base64: bytesBase64(new TextEncoder().encode(text)),
    });
  const r = await fetch("/api/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      source: options.source || (files.length ? "manual_upload" : "paste"),
      operator,
      files: entries,
    }),
    signal,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "接收失败");
  let batch = j as IntakeBatch;
  // A retry can arrive while the original request is still parsing its files.
  while (batch.status === 'processing') {
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, 600);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    });
    const response = await fetch('/api/inquiries/' + encodeURIComponent(batch.id), {signal});
    if (!response.ok) throw new Error('询价已接收，读取处理结果失败，请重试。');
    batch = await response.json() as IntakeBatch;
  }
  return batch;
}
function bytesBase64(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
