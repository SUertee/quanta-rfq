// S1 解析：投递形态识别 + 脏/净数据切分（规则见 15 号文档 §3 S1）
import type { EmailSample } from '../types';

export type DeliveryForm = 'dirty-inline' | 'clean-inline' | 'xlsx-attach' | 'pdf-attach' | 'empty';

export const FORM_LABEL: Record<DeliveryForm, string> = {
  'dirty-inline': '正文内嵌 · 字段连写（脏数据）',
  'clean-inline': '正文内嵌 · Tab 规范表（净数据）',
  'xlsx-attach': '一句话 + xlsx 附件',
  'pdf-attach': '一句话 + PDF 附件',
  empty: '空正文',
};

export interface RawRow {
  lineNo: number;
  raw: string;
  rfqId?: string;
  partNumber?: string;
  description?: string;
  quantity?: number;
  uom?: string;
  priority?: string;
  requirement?: string;
  mpn?: string;
  condition?: string;
  manualPn?: string;
  productScope?: string;
  dueDate?: string;
  needByDate?: string;
  quoteDeadline?: string;
  issues: string[];
  /** 经 LLM 归一并通过 schema 校验的行（审计标记，依据链可回溯） */
  llmFixed?: boolean;
  contentId?: string;
  persistedLineId?: string;
  version?: number;
  evidence?:import('../types').ResourceEvidence[];
}

export function detectForm(e: EmailSample): DeliveryForm {
  const att = e.attachments.join(' ').toLowerCase();
  if (att.includes('.xlsx')) return 'xlsx-attach';
  if (att.includes('.pdf')) return 'pdf-attach';
  if (e.body.split(/\r?\n/).some(l => l.includes('Part Number\t') && l.includes('Quantity'))) return 'clean-inline';
  const lines = e.body.split(/\r?\n/).filter((l) => l.trim());
  const dataLines = lines.filter((l) => /\d{4}-\d{2}-\d{2}/.test(l));
  if (dataLines.some((l) => l.includes('\t'))) return 'clean-inline';
  if (dataLines.length) return 'dirty-inline';
  return 'empty';
}

// 件号定位正则（按 15 号文档：PN-\d{4} / MS\d+ / AS568-\d+ 等，先定位件号再向两侧切）
const PN_RE = /(PN-\d{4}|AP-\d{4}|MS\d+[A-Z0-9-]*|AS\d+-\d+|[A-Z]{2,}\d[A-Z0-9-]*)/g;

/** 脏数据单行切分：按位置特征切，不靠空格 */
export function parseDirtyLine(line: string, lineNo: number): RawRow {
  const issues: string[] = [];
  let s = line.trim();
  const row: RawRow = { lineNo, raw: line, issues };

  const dm = s.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*$/);
  if (dm) { row.dueDate = `${dm[1]} ${dm[2]}`; s = s.slice(0, dm.index).trim(); }
  else issues.push('缺日期');

  const nm = s.match(/^(\d{10})/);
  if (nm) { row.rfqId = nm[1]; s = s.slice(nm[1].length); }
  else issues.push('缺询价单号');

  const pns = [...s.matchAll(PN_RE)];
  if (!pns.length) { issues.push('未识别件号'); return row; }

  row.partNumber = pns[0][0];
  const midEnd = pns.length > 1 ? pns[1].index! : s.length;
  const mid = s.slice(pns[0].index! + row.partNumber.length, midEnd);

  const qm = mid.match(/(\d+(?:\.\d+)?)\s*(EA|IN|FT|Each)/);
  if (qm) {
    row.quantity = Number(qm[1]);
    row.uom = qm[2];
    row.description = mid.slice(0, qm.index).trim();
    const rest = mid.slice(qm.index! + qm[0].length);
    const pm = rest.match(/(NOR|USR|WSP)/);
    if (pm) row.priority = pm[1];
    row.requirement = rest.replace(/(NOR|USR|WSP)/, '').trim() || undefined;
  } else {
    row.description = mid.trim();
    issues.push('缺数量/单位');
  }

  if (pns[1]) {
    row.mpn = pns[1][0];
    const after2End = pns[2]?.index ?? s.length;
    const after2 = s.slice(pns[1].index! + pns[1][0].length, after2End);
    const cm = after2.match(/(FN|NE|OH|SV)/);
    if (cm) row.condition = cm[1];
    else issues.push('件状缺失');
  }
  if (pns[2]) {
    row.manualPn = pns[2][0];
    row.productScope = s.slice(pns[2].index! + pns[2][0].length).trim() || undefined;
  } else issues.push('件号层级不足3级');

  return row;
}

const CLEAN_HEADERS = ['RFQ No.', 'Part Number', 'Description', 'Quantity', 'Unit of Measure',
  '优先级', '询价产品要求话术', '询价MPN', '件状条件', '手册件号', '产品范围', 'Due Date'];

/** 净数据：识别表头行，按 Tab 列切分 */
export function parseCleanBody(body: string): RawRow[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  const headerIdx = lines.findIndex((l) => l.includes('Part Number') && l.includes('\t'));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx].split('\t');
  const colOf = (name: string) => header.indexOf(name);
  const rows: RawRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    if (cells.length < 5 || !cells[colOf('Part Number')]) continue;
    const get = (n: string) => (colOf(n) >= 0 ? cells[colOf(n)]?.trim() ?? '' : '');
    rows.push({
      lineNo: rows.length + 1,
      raw: lines[i],
      rfqId: get('RFQ No.') || undefined,
      partNumber: get('Part Number') || undefined,
      description: get('Description') || undefined,
      quantity: Number(get('Quantity')) || undefined,
      uom: get('Unit of Measure') || undefined,
      priority: get('优先级') || undefined,
      requirement: get('询价产品要求话术') || undefined,
      mpn: get('询价MPN') || undefined,
      condition: get('件状条件') || undefined,
      manualPn: get('手册件号') || undefined,
      productScope: get('产品范围') || undefined,
      dueDate: get('Due Date') || undefined,
      issues: [],
    });
  }
  return rows;
}

export function parseEmailBody(e: EmailSample): { form: DeliveryForm; rows: RawRow[] } {
  const form = detectForm(e);
  if (form === 'pdf-attach' && e.body.includes('Part Number\t')) return { form, rows: parseCleanBody(e.body) };
  if (form === 'clean-inline') return { form, rows: parseCleanBody(e.body) };
  if (form === 'dirty-inline') {
    const lines = e.body.split(/\r?\n/).filter((l) => /\d{4}-\d{2}-\d{2}/.test(l));
    return { form, rows: lines.map((l, i) => parseDirtyLine(l, i + 1)) };
  }
  return { form, rows: [] };
}
