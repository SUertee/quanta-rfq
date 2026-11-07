import {appFetch as fetch} from './appUrl';
// B9 评测接口（15 号文档 §6）。指标计算函数已就绪；评测集（人工标注 ground truth）待录入。
// 评测集约定：两案例 244 行 + 按陷阱清单构造的合成变体（单位混用/-ALT/件状错配/过期价/MOQ不足/缺证书）。
// 红线：不报训练集回放成绩当效果；不确定的标注"未验证"。
import type { Dataset } from '../data';
import type { FlagCode, InquiryLine } from '../types';
import { parseEmailBody } from './parse';
import { fromRaw } from './structure';
import { isYellow, priceAll } from './pricing';

/** 人工标注的期望结构化结果；flags = 该行期望的标黄（可选，用于标黄召回） */
export interface GroundTruthLine {
  partNumber: string; description: string; quantity: number; uom: string;
  condition: string; mpn: string; manualPn: string; productScope: string; dueDate: string;
  flags?: FlagCode[];
}

/** 评测集文件格式：`public/data/eval/ground-truth-<caseId>.json` */
export interface GroundTruthFile {
  caseId: string;
  inputKind: 'dirty' | 'clean' | 'synthetic';
  emailId: string;
  lines: GroundTruthLine[];
}

export const EVAL_FIELDS = [
  'partNumber', 'description', 'quantity', 'uom', 'condition',
  'mpn', 'manualPn', 'productScope', 'dueDate',
] as const;
export type EvalField = (typeof EVAL_FIELDS)[number];

export interface FieldAcc {
  field: EvalField;
  correct: number;
  total: number;
  acc: number;
}

export interface EvalReport {
  caseId: string;
  inputKind: string;
  total: number;
  /** 字段抽取准确率（分字段） */
  fieldAcc: FieldAcc[];
  /** 字段抽取准确率（总体） */
  fieldAccOverall: number;
  /** 端到端人工修改率 = 1 - 全字段正确行占比 */
  humanEditRate: number;
  /** 件号匹配率（三级命中>0） */
  matchRate?: number;
  /** 条件筛查召回：期望标黄行中被实际标黄的比例 */
  flagRecall?: number;
}

/** 录入评测集；文件不存在返回 null（= 接口已留、数据未录入） */
export async function loadGroundTruth(caseId: string): Promise<GroundTruthFile | null> {
  try {
    const r = await fetch(`/data/eval/ground-truth-${caseId}.json`);
    if (!r.ok) return null;
    return (await r.json()) as GroundTruthFile;
  } catch {
    return null;
  }
}

const norm = (v: unknown) => String(v ?? '').trim();

export function evaluate(actual: InquiryLine[], gt: GroundTruthFile, actualYellow?: boolean[]): EvalReport {
  const total = gt.lines.length;
  const fieldAcc = EVAL_FIELDS.map((field) => {
    let correct = 0;
    gt.lines.forEach((exp, i) => {
      if (i < actual.length && norm(actual[i][field as keyof InquiryLine]) === norm(exp[field])) correct++;
    });
    return { field, correct, total, acc: total ? correct / total : 0 };
  });
  const sumCorrect = fieldAcc.reduce((s, f) => s + f.correct, 0);
  const exactRows = gt.lines.filter((exp, i) => {
    if (i >= actual.length) return false;
    return EVAL_FIELDS.every((f) => norm(actual[i][f as keyof InquiryLine]) === norm(exp[f]));
  }).length;

  const report: EvalReport = {
    caseId: gt.caseId,
    inputKind: gt.inputKind,
    total,
    fieldAcc,
    fieldAccOverall: total ? sumCorrect / (total * EVAL_FIELDS.length) : 0,
    humanEditRate: total ? 1 - exactRows / total : 0,
  };

  if (actualYellow) {
    const expectedIdx = gt.lines.map((l, i) => (l.flags?.length ? i : -1)).filter((i) => i >= 0);
    if (expectedIdx.length) {
      const hit = expectedIdx.filter((i) => actualYellow[i]).length;
      report.flagRecall = hit / expectedIdx.length;
    }
  }
  return report;
}

/** 端到端跑一个案例：邮件解析 → 结构化 → 核价 → 对照 ground truth */
export async function runCaseEvaluation(ds: Dataset, gt: GroundTruthFile): Promise<EvalReport | null> {
  const email = ds.emails.find((e) => e.id === gt.emailId);
  if (!email) return null;
  const { rows } = parseEmailBody(email);
  const lines = rows.map((r) => fromRaw(r, email));
  const priced = priceAll(lines, ds);
  const matched = priced.filter((p) => p.matchLevel > 0).length;
  const report = evaluate(lines, gt, priced.map(isYellow));
  report.matchRate = lines.length ? matched / lines.length : 0;
  return report;
}
