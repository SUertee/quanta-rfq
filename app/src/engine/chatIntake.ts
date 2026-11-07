import {loadChatFile, type ChatAttachment} from './chatAttachments';
import {createIntake} from './intake';

export interface ChatIntakeRequest {
  requestId: string;
  instruction: string;
  attachments: ChatAttachment[];
  operator: string;
}

/** Route only the user's request, never instructions found inside an attachment. */
export function shouldCreateChatInquiry(instruction: string, attachmentCount: number) {
  if (/(不要|不|别|无需|不需要|不用|禁止)\s*(?:再|自动|帮我|给我|为我|额外|重新)?\s*(创建|新建|建立|生成)\s*(?:新的?|一个|这份)?\s*(询价|任务|记录|RFQ)/i.test(instruction)) return false;
  if (/(如何|怎么|怎样).{0,16}(创建|新建|建立|生成|上传|导入)/.test(instruction)) return false;
  const createRequest = /(创建|新建|建立|生成).{0,8}(询价|RFQ)/i.test(instruction);
  const quotationRequest = /(报价|核对询价|提取需求|分析询价)/.test(instruction);
  if (createRequest) return attachmentCount > 0 || /(件号|料号|数量|P\/N|\bQTY\b|[A-Z0-9]+[-/][A-Z0-9]+)/i.test(instruction);
  if (attachmentCount) {
    const explanation = /(解释|翻译|总结|是什么|为什么|如何|怎么)/.test(instruction);
    return quotationRequest || !explanation;
  }
  return /件号\s*[:：]?\s*[\w-]+/i.test(instruction) && /数量\s*[:：]?\s*\d/.test(instruction);
}

/** Reuse the formal intake pipeline with original bytes, including unread OCR files. */
export async function submitChatInquiry(request: ChatIntakeRequest, signal: AbortSignal) {
  const files = await Promise.all(request.attachments.map(async attachment => {
    const blob = await loadChatFile(attachment.id);
    if (!blob) throw new Error(`原文件“${attachment.name}”在本机不可用，请重新添加。`);
    return new File([blob], attachment.name, {type: attachment.mime || blob.type});
  }));
  signal.throwIfAborted();
  return createIntake(files, request.instruction, request.operator, request.requestId, {source:'chat', signal});
}
