import {appFetch as fetch} from './appUrl';
// OXR（SoMark 开源文档解析，免费 API）：扫描件/复杂版面 PDF → 阅读顺序文本（表格转 Tab 行）。
// 协议：POST {base}/parse/sync，multipart：file + api_key + output_formats=markdown,json
// 返回 data.result.outputs.json.pages[].blocks[]: {type, content, format}
import { getAiConfig } from './config';

export const oxrConfigured = () => {
  const o = getAiConfig().oxr;
  return o.enabled && o.baseUrl.length > 0;
};

const decodeEnt = (s: string) =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** 表格 HTML → Tab 分隔行（列语义交给下游 LLM 归一） */
function tableToText(html: string): string {
  return html
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decodeEnt(l).replace(/\t+$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

interface OxrBlock { type?: string; content?: string; format?: string }

export interface OxrResult {
  text: string;
  pages: number;
  ms: number;
}

export async function parseWithOxr(file: File): Promise<OxrResult | null> {
  const cfg = getAiConfig().oxr;
  if (!cfg.enabled || !cfg.baseUrl) return null;
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('api_key', cfg.apiKey || 'dummy');
  fd.append('output_formats', 'markdown');
  fd.append('output_formats', 'json');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000); // 扫描件解析较慢
  try {
    const r = await fetch(`${cfg.baseUrl}/parse/sync`, { method: 'POST', body: fd, signal: ctrl.signal });
    if (!r.ok) throw new Error(`OXR ${r.status}：${(await r.text()).slice(0, 150)}`);
    const j = await r.json();
    if (j.code !== 0 && j.code !== undefined) throw new Error(`OXR 返回错误：${JSON.stringify(j.data?.error ?? j).slice(0, 150)}`);
    const pages = j.data?.result?.outputs?.json?.pages ?? [];
    const lines: string[] = [];
    for (const page of pages) {
      const blocks: OxrBlock[] = page.blocks ?? [];
      for (const b of blocks) {
        const content = b.content ?? '';
        if (!content) continue;
        if (b.type === 'Table' || b.format === 'html') lines.push(tableToText(content));
        else lines.push(decodeEnt(content));
      }
    }
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
      text: text.slice(0, 200000),
      pages: pages.length,
      ms: j.data?.metadata?.processing_time_ms ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}