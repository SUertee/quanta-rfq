import { appFetch } from "./appUrl";
export interface SupplierValues {
  partNumber: string;
  supplierName: string;
  uom: string;
  condition: string;
  unitPrice: number | null;
  currency: string;
  moq: number | null;
  leadDays: number | null;
  validFrom: string;
  validUntil: string;
  certType: string;
  taxBasis: string;
  remark: string;
  authorized: boolean;
}
export interface SupplierImport {
  id: string;
  inquiryId: string;
  fileId: string;
  fileName: string;
  status: string;
  version: number;
  issues: string[];
  rows: {
    id: string;
    contentId: string;
    locator: Record<string, unknown>;
    rawFields: Record<string, string>;
    values: SupplierValues;
  }[];
}
export async function supplierRequest(path: string, body?: unknown) {
  const response = await appFetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "供应商报价处理失败");
  return data;
}
export async function uploadSupplier(
  inquiryId: string,
  file: File,
  operator: string,
  requestId: string,
): Promise<SupplierImport> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
  return supplierRequest(`/api/inquiries/${inquiryId}/supplier-imports`, {
    requestId,
    operator,
    name: file.name,
    mime: file.type,
    base64,
  });
}
