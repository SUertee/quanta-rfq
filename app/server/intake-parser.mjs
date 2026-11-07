import { simpleParser } from "mailparser";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";

export const INTAKE_PARSER_VERSION = "rfq-intake-1";
const textCell = (c) => c?.text ?? "";
export async function decodeFile(name, bytes) {
  const ext = name.split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","webp"].includes(ext)) return {kind:"image",chunks:[{locator:{page:1},text:"",format:"text"}],children:[],needsOcr:true};
  if (ext === "eml") {
    const mail = await simpleParser(bytes, {
      skipImageLinks: true,
      skipTextToHtml: true,
      maxHtmlLengthToParse: 2_000_000,
    });
    return {
      kind: "email",
      metadata: {
        subject: mail.subject || "",
        from: mail.from?.text || "",
        to: mail.to?.text || "",
        date: mail.date?.toISOString() || "",
      },
      chunks: [
        { locator: { part: "body" }, text: mail.text || "", format: "text" },
      ],
      children: mail.attachments.map((a) => ({
        name: a.filename || "attachment.bin",
        bytes: a.content,
        mime: a.contentType,
      })),
    };
  }
  if (ext === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    const chunks = [];
    for (const ws of wb.worksheets) {
      if (ws.rowCount > 10000 || ws.columnCount > 150)
        throw new Error("工作表超过10000行或150列限制");
      ws.eachRow((row, n) => {
        const cells = [];
        row.eachCell({ includeEmpty: true }, (c, i) => {
          cells[i - 1] = textCell(c);
        });
        chunks.push({
          locator: { sheet: ws.name, row: n },
          text: cells.join("\t"),
          format: "table_row",
          cells,
        });
      });
    }
    return { kind: "spreadsheet", chunks, children: [] };
  }
  if (ext === "csv") {
    const rows = parseCsv(bytes.toString("utf8"), {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 500000,
    });
    if (rows.length > 10000) throw new Error("CSV超过10000行限制");
    return {
      kind: "spreadsheet",
      chunks: rows.map((cells, i) => ({
        locator: { sheet: "CSV", row: i + 1 },
        text: cells.join("\t"),
        cells,
        format: "table_row",
      })),
      children: [],
    };
  }
  if (ext === "pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
    });
    const doc = await loading.promise;
    try {
      if (doc.numPages > 80) throw new Error("PDF超过80页限制");
      const chunks = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let text = "";
        let lastY = null;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const y = item.transform[5];
          if (lastY !== null && Math.abs(y - lastY) > 3) text += "\n";
          text += item.str + (item.hasEOL ? "\n" : " ");
          lastY = y;
        }
        chunks.push({
          locator: { page: i },
          text: text.trim(),
          format: "text",
        });
      }
      return {
        kind: "pdf",
        chunks,
        children: [],
        needsOcr: chunks.some((c) => !c.text.trim()),
      };
    } finally {
      await loading.destroy();
    }
  }
  if (["txt", "text", "md"].includes(ext))
    return {
      kind: "text",
      chunks: bytes
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map((text, i) => ({ locator: { line: i + 1 }, text, format: "text" })),
      children: [],
    };
  return { kind: "unsupported", chunks: [], children: [], unsupported: true };
}
