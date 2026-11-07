import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function getRuntimeConfig() {
  const local = {};
  try {
    for (const line of readFileSync(
      fileURLToPath(new URL("../.env.local", import.meta.url)),
      "utf8",
    ).split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) local[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  const get = (k) => process.env[k] ?? local[k];
  const apiKey = get("RFQ_LLM_API_KEY"),
    baseURL = get("RFQ_LLM_BASE_URL"),
    model = get("VITE_LLM_MODEL");
  const validUrl = (url) => {
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  };
  return {
    model:
      process.env.RFQ_INTAKE_MODEL === "off"
        ? null
        : apiKey && validUrl(baseURL) && model
          ? { apiKey, baseURL, model }
          : null,
    ocr: validUrl(get("RFQ_OCR_BASE_URL"))
      ? {
          baseURL: get("RFQ_OCR_BASE_URL"),
          apiKey: get("RFQ_OCR_API_KEY") || "",
        }
      : null,
  };
}
