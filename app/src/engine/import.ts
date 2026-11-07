import {appFetch as fetch} from './appUrl';
// 导入解析：xlsx/csv → 后端自研解析器（前端不依赖 xlsx 库）；空字段保留为空串，不猜不填

/** 映射模板记忆：表头签名 → 映射（同格式再来直接命中，降低下一户接入成本） */
const MEM_KEY = 'rfq-mapping-memory-v1';
const signatureOf = (headers: string[]) => headers.map((h) => h.trim().toLowerCase()).sort().join('|');

export function getMappingMemory(headers: string[]): Record<string, string> | null {
  try {
    const all = JSON.parse(localStorage.getItem(MEM_KEY) ?? '{}');
    return all[signatureOf(headers)] ?? null;
  } catch {
    return null;
  }
}

export function saveMappingMemory(headers: string[], mapping: Record<string, string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(MEM_KEY) ?? '{}');
    all[signatureOf(headers)] = mapping;
    localStorage.setItem(MEM_KEY, JSON.stringify(all));
  } catch { /* 存不下则放弃记忆 */ }
}

export interface ImportSheet {
  headers: string[];
  rows: Record<string, string>[];
}

export async function readSheetFile(file: File): Promise<ImportSheet> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });
  const r = await fetch('/api/parse-xlsx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, base64 }),
  });
  if (!r.ok) throw new Error(`解析失败 ${r.status}（后端未启动？双击 启动后端.bat）`);
  return r.json();
}

/** 库存目标字段 */
export const INV_FIELDS = [
  'partNumber', 'description', 'productScope', 'uom', 'stockQty',
  'warehouse', 'stockCondition', 'stdCost', 'avgCost', 'lastPurchasePrice', 'currency',
] as const;

/** 询价/订单目标字段 */
export const INQUIRY_FIELDS = [
  'rfqId', 'partNumber', 'description', 'quantity', 'uom', 'priority',
  'requirement', 'mpn', 'condition', 'manualPn', 'productScope', 'dueDate',
] as const;

export const FIELD_LABEL: Record<string, string> = {
  partNumber: '件号', description: '描述', productScope: '产品范围', uom: '单位',
  stockQty: '库存数量', warehouse: '仓库', stockCondition: '件状',
  stdCost: '标准成本', avgCost: '平均成本', lastPurchasePrice: '近采价', currency: '币种',
  rfqId: '询价单号', quantity: '数量', priority: '优先级', requirement: '产品要求',
  mpn: 'MPN', condition: '件状', manualPn: '手册件号', dueDate: '需求/截止期',
};

/** 表头别名（小写匹配） */
const ALIAS: Record<string, string> = {
  'part number': 'partNumber', 'pn': 'partNumber', '件号': 'partNumber', '料号': 'partNumber', '型号': 'partNumber',
  'description': 'description', '描述': 'description', '名称': 'description', '品名': 'description',
  '产品范围': 'productScope', 'category': 'productScope', '品类': 'productScope',
  'unit of measure': 'uom', 'unit': 'uom', '单位': 'uom',
  '库存数量': 'stockQty', '库存': 'stockQty', 'stock': 'stockQty', '仓存数': 'stockQty',
  '仓库': 'warehouse', 'warehouse': 'warehouse', '库位': 'warehouse', '货位': 'warehouse',
  '库存件状': 'stockCondition', '件状': 'stockCondition', 'condition': 'stockCondition', '件状条件': 'condition',
  '标准成本': 'stdCost', '平均成本': 'avgCost', '最近采购价': 'lastPurchasePrice', '近采价': 'lastPurchasePrice',
  '成本': 'avgCost', '单价': 'lastPurchasePrice', 'price': 'lastPurchasePrice', 'cost': 'avgCost',
  '币种': 'currency', 'currency': 'currency',
  '询价单号': 'rfqId', 'rfq no.': 'rfqId', 'rfq no': 'rfqId', 'rfq': 'rfqId', '订单号': 'rfqId',
  'quantity': 'quantity', 'qty': 'quantity', '数量': 'quantity',
  '优先级': 'priority', 'priority': 'priority',
  '询价产品要求': 'requirement', '询价产品要求话术': 'requirement', '产品要求': 'requirement', '要求': 'requirement',
  '询价mpn': 'mpn', 'mpn': 'mpn', '手册件号': 'manualPn',
  'due date': 'dueDate', '截止报价日期': 'dueDate', '截止日期': 'dueDate', '需求日期': 'dueDate', '交期': 'dueDate',
};

export function autoMapHeaders(headers: string[], targetFields: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const key = h.trim().toLowerCase();
    if (['件状', 'condition', 'stockcondition'].includes(key)) map[h] = targetFields.includes('condition') ? 'condition' : targetFields.includes('stockCondition') ? 'stockCondition' : '';
    else if (targetFields.includes(h)) map[h] = h;
    else if (ALIAS[key] && targetFields.includes(ALIAS[key])) map[h] = ALIAS[key];
    else map[h] = '';
  }
  return map;
}

/** 按映射转换导入行 */
export function applyMapping(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  numericFields: readonly string[],
): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [header, target] of Object.entries(mapping)) {
      if (!target) continue;
      const raw = r[header]?.trim() ?? '';
      if (target.startsWith('custom:')) out[target.slice(7)] = raw;
      else if (numericFields.includes(target)) out[target] = raw === '' ? 0 : Number(raw.replace(/,/g, ''));
      else out[target] = raw;
    }
    return out;
  });
}
