// 任务聚合：把邮件与看板统一为"询价任务"，供首页列表使用
import type { Dataset } from './data';
import type { EmailSample } from './types';
import { parseEmailBody, type RawRow } from './engine/parse';
import { fromAttachment, fromKanban, fromRaw } from './engine/structure';
import { isYellow, priceAll, type PriceOpts } from './engine/pricing';
import type { Source } from './App';

export interface TaskSummary {
  inquiryError?: boolean;
  intakeStatus?: string;
  key: string;
  title: string;
  customer: string;
  tag: string;
  urgent: boolean;
  total: number;
  checkCount: number;
  due: string;
  source: Source;
}

export function linesOf(ds: Dataset, source: Source) {
  if (source.kind === 'email') {
    const email = ds.emails.find((e) => e.id === source.id)!;
    if(!email) return {email:undefined,lines:[],label:'询价尚未加载，请检查数据服务'};
    const parsedRows=email.parsedRows || source.llmRows;
    const { form, rows } = parsedRows
      ? { form: 'dirty-inline' as const, rows: parsedRows }
      : parseEmailBody(email);
    if (form === 'xlsx-attach') {
      return {
        email,
        lines: (ds.attachments[String(email.caseNo)] || []).map((r, i) => fromAttachment(r, email.caseNo as 1 | 2, i + 1, ds.units)),
        label: `${email.subject}（附件清单）`,
      };
    }
    return { email, lines: rows.map((r) => fromRaw(r, email, ds.units)), label: email.subject };
  }
  const rows = ds.kanban.filter((r) => r.rfqId === source.rfqId);
  return {
    email: undefined as EmailSample | undefined,
    lines: rows.map((r) => fromKanban(r, ds.units)),
    label: `历史询价 ${source.rfqId}`,
  };
}

export function buildTasks(ds: Dataset, opts: PriceOpts = {}, taskRows: Record<string, RawRow[]> = {}): TaskSummary[] {
  const tasks: TaskSummary[] = [];

  for (const email of ds.emails) {
    const source: Source = { kind: 'email', id: email.id, ...(taskRows[email.id] ? { llmRows: taskRows[email.id] } : {}) };
    const { lines, label } = linesOf(ds, source);
    const priced = priceAll(lines, ds, opts);
    tasks.push({
      key: `email-${email.id}`,
      intakeStatus:email.intakeStatus,
      title: label.replace('（附件清单）', '') || email.file,
      customer: email.from.replace(/<.*>/, '').trim(),
      tag: email.intakeBatchId ? '文件导入' : email.id.startsWith('custom-') ? '手工录入' : '询价邮件',
      urgent: false,
      total: lines.length,
      checkCount: priced.filter(isYellow).length,
      due: lines.map((l) => l.dueDate).sort()[0] ?? '',
      source,
    });
  }

  const groups = new Map<string, typeof ds.kanban>();
  for (const r of ds.kanban) {
    const arr = groups.get(r.rfqId) ?? [];
    arr.push(r);
    groups.set(r.rfqId, arr);
  }
  for (const [rfqId] of groups) {
    const source: Source = { kind: 'kanban', rfqId };
    const { lines } = linesOf(ds, source);
    const priced = priceAll(lines, ds, opts);
    const first = lines[0];
    tasks.push({
      key: `kanban-${rfqId}`,
      title: rfqId,
      customer: first?.customer ?? '',
      tag: '历史询价',
      urgent: lines.some((l) => l.urgency === 'AOG'),
      total: lines.length,
      checkCount: priced.filter(isYellow).length,
      due: lines.map((l) => l.dueDate).sort()[0] ?? '',
      source,
    });
  }
  return tasks;
}
