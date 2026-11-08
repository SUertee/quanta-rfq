/** Shared configured OCR adapter for customer inquiries and supplier source documents. */
export async function readOcr(
  bytes,
  name = "document.pdf",
  mime = "application/pdf",
  config,
  { fetchImpl = fetch } = {},
) {
  if (!config?.baseURL) return null;
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), name);
  form.append("api_key", config.apiKey || "");
  form.append("output_formats", "json");
  const response = await fetchImpl(
    config.baseURL.replace(/\/$/, "") + "/parse/sync",
    { method: "POST", body: form, signal: AbortSignal.timeout(90000) },
  );
  if (!response.ok) throw new Error(`OCR服务失败（HTTP ${response.status}）`);
  const data = await response.json(),
    pages = data.data?.result?.outputs?.json?.pages;
  if (!Array.isArray(pages)) throw new Error("OCR响应缺少页面内容");
  return pages.map((page, index) => ({
    locator: { page: index + 1, engine: "ocr" },
    format: "text",
    text: (page.blocks || [])
      .map((block) => block.content || "")
      .join("\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/(td|th)>/gi, "\t")
      .replace(/<[^>]*>/g, ""),
  }));
}
