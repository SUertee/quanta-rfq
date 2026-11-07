import {appFetch as fetch} from './engine/appUrl';
import {loadIntakeEmails} from './engine/intake';
import type { CostRow, EmailSample, KanbanRow, PriceRow } from './types';

export interface Dataset {
  kanban: KanbanRow[];
  cost: CostRow[];
  prices: PriceRow[];
  emails: EmailSample[];
  attachments: Record<string, Record<string, string>[]>;
  costIdx: Map<string, CostRow>;
  priceIdx: Map<string, PriceRow[]>;
  /** 库存自定义字段（后端 extra 键的并集） */
  customFields: string[];
  /** 库存是否由后端 SQLite 提供（false = 演示 JSON 兜底，仅能会话内改库存数量） */
  inventoryBackend: boolean;
  intakeLoadError?: string;
  pricesBackend?: boolean;
  /** 单位换算表：件号 → 原单位 → 每 EA 数量（如 IN/FT → EA，A2） */
  units: Record<string, Record<string, number>>;
}

async function j<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

/** 库存优先走后端（Node+SQLite），3s 超时回退演示 JSON */
async function loadInventory(): Promise<{ cost: CostRow[]; customFields: string[]; backend: boolean }> {
  try {
    const r = await fetch('/api/inventory', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const data = (await r.json()) as { cost: CostRow[]; customFields: string[] };
      if (Array.isArray(data.cost)) return { ...data, backend: true };
    }
  } catch { /* 后端未启动，回退 */ }
  return { cost: await j<CostRow[]>('/data/cost.json'), customFields: [], backend: false };
}

/** 载入演示数据（由 scripts/convert-data.mjs 从官方 xlsx/eml 生成）。
 *  TODO(后端): parse/price/export/review 平移服务端后此层仅保留 HTTP 调用。 */
export async function loadData(): Promise<Dataset> {
  const [kanban, priceResult, sampleEmails, att1, att2, inv] = await Promise.all([
    j<KanbanRow[]>('/data/kanban.json'),
    fetch('/api/price-resources').then(async r=>{if(!r.ok)throw new Error('服务端价格不可用');return (await r.json()).prices as PriceRow[]}).then(prices=>({prices,backend:true})).catch(async()=>({prices:await j<PriceRow[]>('/data/prices.json'),backend:false})),
    j<EmailSample[]>('/data/emails.json'),
    j<Record<string, string>[]>('/data/attachment-1.json'),
    j<Record<string, string>[]>('/data/attachment-2.json'),
    loadInventory(),
  ]);
  let intakeEmails:EmailSample[]=[];let intakeLoadError='';try{intakeEmails=await loadIntakeEmails();}catch{intakeLoadError='服务端询价记录未加载，当前仅显示本地与演示资料';}
  const emails=[...intakeEmails,...sampleEmails];
  const prices=priceResult.prices;
  const costIdx = new Map(inv.cost.map((c) => [c.partNumber, c]));
  const priceIdx = new Map<string, PriceRow[]>();
  for (const p of prices) {
    const arr = priceIdx.get(p.partNumber) ?? [];
    arr.push(p);
    priceIdx.set(p.partNumber, arr);
  }
  const units = await loadUnits();
  return {
    kanban, cost: inv.cost, prices, emails,
    attachments: { '1': att1, '2': att2 }, costIdx, priceIdx,
    customFields: inv.customFields, inventoryBackend: inv.backend, units, intakeLoadError, pricesBackend:priceResult.backend,
  };
}

/** 单位换算表（后端；不可用时为空表） */
async function loadUnits(): Promise<Record<string, Record<string, number>>> {
  try {
    const r = await fetch('/api/units', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return {};
    const j = (await r.json()) as { rows: { pn: string; uom: string; factor: number }[] };
    const out: Record<string, Record<string, number>> = {};
    for (const u of j.rows ?? []) {
      out[u.pn] = { ...(out[u.pn] ?? {}), [u.uom]: u.factor };
    }
    return out;
  } catch {
    return {};
  }
}
