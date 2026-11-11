/** Reference follow-ups use contextual chat unless the user requests a business operation. */
export function isReferenceQuestion(instruction: string, hasReferences: boolean) {
  if (!hasReferences) return false;
  const requestsOperation = /(生成|形成|输出|制作|出具|计算|填入|执行|重新核价|检查|核对|查询|分析)/.test(instruction);
  return !requestsOperation;
}
