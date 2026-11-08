/** Only extraction findings can be resolved by reviewing readable originals and material rows. */
export function reviewableExtractionIssue(issue) {
  return [
    /^模型返回不存在的来源，已拒绝该行$/,
    /^模型件号无法在原文定位，已拒绝该行$/,
    /^模型(?:数量|description|uom|condition|requirement|dueDate|needByDate|quoteDeadline|mpn)无法在原文定位，已清空$/,
    /^共同要求或适用范围无法在原文定位，已拒绝$/,
    /^共同要求适用范围需确认，请核对原文$/,
    /^同一原文存在重复件号，补充要求需人工确认适用行$/,
    /^\d+处原文包含未落实到物料行的要求或数据，需核对原文$/,
    /^提取模型未返回符合格式的需求，原文已保留，请重试或人工核对$/,
    /^语义提取服务失败（HTTP \d+）$/,
  ].some((pattern) => pattern.test(issue));
}
