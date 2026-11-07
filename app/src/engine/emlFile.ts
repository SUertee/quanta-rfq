// 客户端 .eml 解码：新建任务入口用（浏览器无服务端，自行解 MIME）
import type { EmailSample } from '../types';

function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeWord(s: string): string {
  try {
    return s.replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, b) => b64ToUtf8(b));
  } catch {
    return s;
  }
}

const header = (raw: string, name: string) =>
  decodeWord((raw.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi')) || [, ''])[1]).trim();

/** 解析 .eml 原文为 EmailSample；若内容不是邮件格式（用户直接粘贴清单），整体作为正文 */
export function parseEmlText(fileName: string, raw: string): Omit<EmailSample, 'id' | 'caseNo'> {
  const isEml = /^(Content-Type|Subject|From):/im.test(raw);
  if (!isEml) {
    return {
      file: fileName, subject: fileName.replace(/\.\w+$/, '') || '手工录入询价',
      from: '手工录入', to: '', date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      body: raw, attachments: [],
    };
  }

  const subject = header(raw, 'Subject');
  const from = header(raw, 'From');
  const to = header(raw, 'To');
  const date = header(raw, 'Date');
  const boundary = (raw.match(/boundary="?([^"\r\n]+)"?/) || [])[1];

  let body = '';
  if (boundary) {
    const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const part of parts) {
      if (/Content-Type:\s*text\/plain/i.test(part)) {
        const payload = part.split(/\r?\n\r?\n/)[1] ?? '';
        body = /base64/i.test(part) ? b64ToUtf8(payload) : payload.trim();
        if (body) break;
      }
    }
  } else {
    body = (raw.split(/\r?\n\r?\n/)[1] ?? '').trim();
  }
  const attachments = [...raw.matchAll(/filename="?([^"\r\n;]+)"?/g)].map((m) => decodeWord(m[1]));

  return {
    file: fileName, subject: subject || fileName, from: from || '未知发件人', to, date, body, attachments,
  };
}
