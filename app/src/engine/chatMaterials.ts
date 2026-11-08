import { loadChatFile, type ChatAttachment } from "./chatAttachments";
import { supplierRequest, uploadSupplier } from "./supplierImport";
import { shouldCreateChatInquiry } from "./chatIntake";
export type MaterialPurpose =
  | "auto"
  | "customer_inquiry"
  | "supplier_quote"
  | "question";
export interface ChatSupplierRequest {
  attachments: ChatAttachment[];
  inquiryId?: string;
  operator: string;
}
export interface ChatSupplierReceipt {
  inquiryId: string;
  imports: { id: string; fileName: string }[];
}

export function chatMaterialRoute(
  instruction: string,
  count: number,
  purpose: MaterialPurpose,
) {
  if (!count)
    return shouldCreateChatInquiry(instruction, count) ? "inquiry" : "question";
  if (
    /(不要|不用|无需|别|不需要|不).{0,12}(导入|入库|创建|生成)/.test(
      instruction,
    )
  )
    return "question";
  if (/(如何|怎么|怎样).{0,16}(导入|接收|入库|创建|生成)/.test(instruction))
    return "question";
  if (purpose === "question") return "question";
  if (purpose === "supplier_quote") return "supplier";
  if (purpose === "customer_inquiry")
    return shouldCreateChatInquiry(instruction, count) ? "inquiry" : "question";
  if (
    /(解释|翻译|总结|是什么|为什么|如何|怎么)/.test(instruction) &&
    !/(导入|接收|入库|作为|补充|添加)/.test(instruction)
  )
    return "question";
  if (/(供应商|上游).{0,12}(报价|价格)|导入.{0,8}报价依据/.test(instruction))
    return "supplier";
  if (/(解释|翻译|总结|是什么|为什么|如何|怎么)/.test(instruction))
    return "question";
  if (/(客户询价|创建询价|新建询价|提取需求|分析询价)/.test(instruction))
    return "inquiry";
  return "choose";
}
export async function submitChatSupplier(
  request: ChatSupplierRequest,
  inquiryId: string,
): Promise<ChatSupplierReceipt> {
  const imports = [];
  for (const attachment of request.attachments) {
    const blob = await loadChatFile(attachment.id);
    if (!blob)
      throw new Error(`原文件“${attachment.name}”在本机不可用，请重新添加。`);
    const file = new File([blob], attachment.name, {
      type: attachment.mime || blob.type,
    });
    const imported = await uploadSupplier(
      inquiryId,
      file,
      request.operator,
      attachment.id,
      "chat",
    );
    imports.push({ id: imported.id, fileName: imported.fileName });
  }
  return { inquiryId, imports };
}
export async function refreshChatInquiry(inquiryId: string) {
  return supplierRequest(
    `/api/inquiries/${encodeURIComponent(inquiryId)}/evidence`,
    {},
  );
}
