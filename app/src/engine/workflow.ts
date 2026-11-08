export type InquiryStage = 1 | 2 | 3 | 4 | 5 | 6;
export type StageState = "done" | "attention" | "pending";
export interface WorkflowInput {
  materialCount: number;
  lineCount: number;
  extractionGaps: number;
  matchedLines: number;
  reviewedLines: number;
  activeLines: number;
  pricedLines: number;
  exportAllowed: boolean;
  exported: boolean;
}
export const INQUIRY_STAGES = [
  "接收询价",
  "提取需求",
  "查询依据",
  "检查条件",
  "报价草稿",
  "确认导出",
] as const;
export function inquiryStages(v: WorkflowInput) {
  return [
    {
      id: 1 as InquiryStage,
      label: INQUIRY_STAGES[0],
      state: v.materialCount ? "done" : "pending",
      detail: v.materialCount ? `${v.materialCount} 份材料` : "待上传",
    },
    {
      id: 2 as InquiryStage,
      label: INQUIRY_STAGES[1],
      state: !v.lineCount ? "pending" : v.extractionGaps ? "attention" : "done",
      detail: !v.lineCount
        ? "待提取"
        : v.extractionGaps
          ? `${v.extractionGaps} 项待核对`
          : `${v.lineCount} 行已提取`,
    },
    {
      id: 3 as InquiryStage,
      label: INQUIRY_STAGES[2],
      state: !v.lineCount
        ? "pending"
        : v.matchedLines < v.lineCount
          ? "attention"
          : "done",
      detail: !v.lineCount
        ? "待查询"
        : `${v.matchedLines} 行有依据，${v.lineCount-v.matchedLines} 行待补全`,
    },
    {
      id: 4 as InquiryStage,
      label: INQUIRY_STAGES[3],
      state: !v.activeLines
        ? "pending"
        : v.reviewedLines === v.activeLines
          ? "done"
          : "attention",
      detail: v.activeLines
        ? `${v.reviewedLines} 行已核对，${v.activeLines-v.reviewedLines} 行待核对`
        : "待核对",
    },
    {
      id: 5 as InquiryStage,
      label: INQUIRY_STAGES[4],
      state: !v.activeLines
        ? "pending"
        : v.pricedLines === v.activeLines
          ? "done"
          : v.pricedLines
            ? "attention"
            : "pending",
      detail: v.activeLines
        ? `${v.pricedLines} 行已定价，${v.activeLines-v.pricedLines} 行待定价`
        : "待生成",
    },
    {
      id: 6 as InquiryStage,
      label: INQUIRY_STAGES[5],
      state: v.exported ? "done" : v.exportAllowed ? "pending" : "attention",
      detail: v.exported
        ? "已生成导出文件"
        : v.exportAllowed
          ? "可导出"
          : "待处理阻断项",
    },
  ].map((s) => ({ ...s, state: s.state as StageState }));
}

export type WorkflowRun = {stage:InquiryStage; revealed:InquiryStage; state:"queued"|"running"|"attention"|"done"|"failed"|"stopped";error?:string};
