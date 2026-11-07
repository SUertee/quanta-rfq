// 官方素材 xlsx/eml → 前端演示 JSON
// 数据源：知识库/询价信息素材（哈希已核验的官方考卷）
// 解析器：server/xlsx.mjs（自研零依赖，不引 xlsx 库）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSheet } from '../server/xlsx.mjs';

const BASE = process.argv[2];
if (!BASE) throw new Error('Usage: npm run convert:data -- /path/to/source-materials');
const OUT = fileURLToPath(new URL('../public/data', import.meta.url));
mkdirSync(OUT, { recursive: true });

// Excel 序列日期 → 'YYYY-MM-DD HH:mm'
function xdate(v) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n)) return String(v ?? '');
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function sheetRows(file) {
  return parseSheet(file, readFileSync(join(BASE, file))).rows;
}

// ---------- 1) 看板 249 行 ----------
const kanban = sheetRows('询价报价清单_看板演示数据.xlsx').map((r) => ({
  rfqId: String(r['询价单号']),
  rfqNo: String(r['RFQ No']),
  inquiryDate: xdate(r['询价日期']),
  airline: String(r['航空公司']),
  urgency: String(r['紧急程度']),
  lineNo: Number(r['行号']),
  partNumber: String(r['Part Number']),
  description: String(r['Description']),
  quantity: Number(r['Quantity']),
  uom: String(r['Unit Of Measure']),
  requirement: String(r['询价产品要求']),
  mpn: String(r['询价MPN']),
  condition: String(r['件状条件']),
  manualPn: String(r['手册件号']),
  productScope: String(r['产品范围']),
  dueDate: xdate(r['截止报价日期']),
}));
writeFileSync(join(OUT, 'kanban.json'), JSON.stringify(kanban));

// ---------- 2) 内部物料成本表 ----------
const cost = sheetRows('内部物料成本表_演示数据.xlsx').map((r) => ({
  partNumber: String(r['Part Number']),
  description: String(r['Description']),
  productScope: String(r['产品范围']),
  uom: String(r['Unit Of Measure']),
  stockQty: Number(r['库存数量']),
  warehouse: String(r['仓库']),
  stockCondition: String(r['库存件状']),
  stdCost: Number(r['标准成本']),
  avgCost: Number(r['平均成本']),
  lastPurchasePrice: Number(r['最近采购价']),
  currency: String(r['币种']),
  lastPurchaseDate: xdate(r['最近采购日期']),
  preferredSupplier: String(r['首选供应商编码']),
  costUpdateDate: xdate(r['成本更新日期']),
}));
writeFileSync(join(OUT, 'cost.json'), JSON.stringify(cost));

// ---------- 3) 价格资源表 ----------
const prices = sheetRows('价格资源表_演示数据.xlsx').map((r) => ({
  id: String(r['价格资源编号']),
  partNumber: String(r['Part Number']),
  supplierCode: String(r['供应商编码']),
  supplierName: String(r['供应商名称']),
  supplierType: String(r['供应商类型']),
  country: String(r['国家地区']),
  condition: String(r['件状条件']),
  unitPrice: Number(r['单价']),
  currency: String(r['币种']),
  fxToCny: Number(r['汇率到CNY']),
  moq: Number(r['最小起订量']),
  leadDays: Number(r['交期天数']),
  inStock: String(r['是否现货']),
  certType: String(r['证书类型']),
  quoteDate: xdate(r['报价日期']),
  validUntil: xdate(r['有效期至']),
  statusLabel: String(r['价格状态']),
  remark: String(r['备注']),
}));
writeFileSync(join(OUT, 'prices.json'), JSON.stringify(prices));

// ---------- 4) 两案例附件清单 ----------
for (const c of ['1', '2']) {
  const rows = sheetRows(`${c}/附件/询价报价清单.xlsx`);
  writeFileSync(join(OUT, `attachment-${c}.json`), JSON.stringify(rows));
}

// ---------- 5) 6 封邮件解码 ----------
function decodeWord(s) {
  return s.replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, b) =>
    Buffer.from(b, 'base64').toString('utf-8'),
  );
}
function parseEml(file) {
  const raw = readFileSync(join(BASE, file), 'utf-8');
  const boundary = (raw.match(/boundary="?([^"\r\n]+)"?/) || [])[1];
  const subject = decodeWord((raw.match(/^Subject:\s*(.+)$/m) || [, ''])[1]).trim();
  const from = decodeWord((raw.match(/^From:\s*(.+)$/m) || [, ''])[1]).trim();
  const to = decodeWord((raw.match(/^To:\s*(.+)$/m) || [, ''])[1]).trim();
  const date = ((raw.match(/^Date:\s*(.+)$/m) || [, ''])[1] || '').trim();

  // 提取 text/plain base64 正文
  let body = '';
  const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const part of parts) {
    if (/Content-Type:\s*text\/plain/i.test(part) && /base64/i.test(part)) {
      const b64 = part.split(/\r?\n\r?\n/)[1] || '';
      body = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf-8');
    }
  }
  // 附件文件名（如有）
  const attachments = [...raw.matchAll(/filename="?([^"\r\n;]+)"?/g)].map((m) => decodeWord(m[1]));
  return { file: basename(file), subject, from, to, date, body, attachments };
}

const emailFiles = [
  ['case1-dirty', '1/航空配件询价（RFQ-20260901）.eml'],
  ['case1-attach', '1/航空询价（RFQ-20260902）.eml'],
  ['case1-en', '1/Request for Quotation - Spare Parts for Airline Project.eml'],
  ['case2-clean', '2/航空配件询价（RFQ-20260911）.eml'],
  ['case2-attach', '2/航空询价（RFQ-20260912）.eml'],
  ['case2-en', '2/Request for Quotation - Components for Fleet Maintenance.eml'],
];
const emails = emailFiles.map(([id, f]) => ({ id, caseNo: id.startsWith('case1') ? 1 : 2, ...parseEml(f) }));
writeFileSync(join(OUT, 'emails.json'), JSON.stringify(emails));

// ---------- 统计输出 ----------
const costPn = new Set(cost.map((r) => r.partNumber));
const pricePn = new Set(prices.map((r) => r.partNumber));
const kbPn = new Set(kanban.map((r) => r.partNumber));
const hitCost = [...kbPn].filter((p) => costPn.has(p)).length;
const hitPrice = [...kbPn].filter((p) => pricePn.has(p)).length;
console.log(`kanban=${kanban.length} cost=${cost.length} prices=${prices.length} emails=${emails.length}`);
console.log(`看板件号去重=${kbPn.size}，命中成本表=${hitCost}，命中价格资源表=${hitPrice}`);
for (const e of emails) console.log(`${e.id}: body=${e.body.length}chars att=[${e.attachments}] subj=${e.subject}`);
