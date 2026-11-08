/** Issue labels shared by extraction, source review and manual conflict confirmation. */
export const FIELD_REVIEW_LABELS = {
  partNumber: "件号",
  rfqId: "询价单号",
  description: "描述",
  quantity: "数量",
  uom: "单位",
  condition: "件状",
  requirement: "要求",
  needByDate: "交期",
  quoteDeadline: "报价截止日期",
  dueDate: "截止日期",
  mpn: "mpn",
  priority: "优先级",
  manualPn: "手册件号",
  productScope: "产品范围",
};
export function fieldConflictIssues(line, field) {
  const label = FIELD_REVIEW_LABELS[field];
  if (!label) return [];
  const messages = [
    `共同要求与物料行的${label}冲突，需核对原文`,
    `语义提取与已识别的${label}不一致，需核对原文`,
    `共同要求的${label}适用范围需确认`,
    `多列${label}不一致，需核对原文`,
  ];
  return [...new Set((line.issues || []).filter((issue) => messages.includes(issue)))];
}
