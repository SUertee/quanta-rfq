// 联网搜索（腾讯元宝搜索 WSA · SearchPro 接口）。
// 用途：非标品市场估价的取证；搜索结果只做估价参考并附来源链接，不直接进报价。
import { getAiConfig } from './config';

export const searchConfigured = () => {
  const s = getAiConfig().search;
  return s.enabled && s.apiKey.length > 0;
};

export interface SearchItem {
  title: string;
  url: string;
  site: string;
  date: string;
  passage: string;
}

export interface SearchResult {
  text: string;
  items: SearchItem[];
}

export async function webSearch(query: string, limit = 5): Promise<SearchResult | null> {
  const s = getAiConfig().search;
  if (!s.enabled || !s.apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(`${s.baseUrl}/SearchPro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({ Query: query }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`搜索失败 ${r.status}：${(await r.text()).slice(0, 150)}`);
    const j = await r.json();
    const pages: unknown[] = j.Response?.Pages ?? [];
    const items: SearchItem[] = [];
    for (const p of pages) {
      try {
        const o = (typeof p === 'string' ? JSON.parse(p) : p) as Record<string, string>;
        if (o.passage) items.push({ title: o.title ?? '', url: o.url ?? '', site: o.site ?? '', date: o.date ?? '', passage: o.passage });
      } catch { /* 跳过坏条目 */ }
    }
    const top = items.slice(0, limit);
    const text = top
      .map((it, i) => `【${i + 1}】${it.title}（${it.site} ${it.date}）\n${it.passage}`)
      .join('\n\n');
    return { text, items: top };
  } finally {
    clearTimeout(timer);
  }
}
