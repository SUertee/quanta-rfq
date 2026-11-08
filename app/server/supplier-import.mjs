import { readOcr } from "./ocr-reader.mjs";
import { extractSupplierSemantic } from "./supplier-extract.mjs";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { decodeFile, INTAKE_PARSER_VERSION } from "./intake-parser.mjs";
import {
  normalizePartNumber,
  normalizeUnit,
  normalizeQuantity,
  validDate,
} from "./normalization.mjs";
import { canonicalJson } from "../shared/quote-state.mjs";
import { rows } from "./intake.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const aliases = {
  partNumber: ["件号", "料号", "partnumber", "pn", "p/n"],
  supplierName: ["供应商", "供应商名称", "supplier", "suppliername"],
  uom: ["单位", "unit", "uom"],
  condition: ["件状", "condition"],
  unitPrice: ["单价", "供应商单价", "unitprice", "price"],
  currency: ["币种", "currency"],
  moq: ["起订量", "最小起订量", "moq"],
  leadDays: ["交期天数", "交期", "leaddays"],
  validFrom: ["生效日期", "报价日期", "validfrom", "quotedate"],
  validUntil: ["有效期", "有效期至", "validuntil"],
  certType: ["证书", "证书类型", "certtype", "certificate"],
  taxBasis: ["税基", "含税口径", "taxbasis"],
  remark: ["备注", "remark", "remarks"],
};
const headerKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]/g, "");
const fieldFor = (value) =>
  Object.keys(aliases).find((key) => aliases[key].includes(headerKey(value)));
const text = z.string().max(4000);
const editableSchema = z
  .object({
    id: z.string().uuid(),
    partNumber: text,
    supplierName: text,
    uom: text,
    condition: text,
    unitPrice: z.number().positive().finite().max(1e12).nullable(),
    currency: text,
    moq: z.number().positive().finite().max(1e12).nullable(),
    leadDays: z.number().nonnegative().finite().max(3650).nullable(),
    validFrom: text,
    validUntil: text,
    certType: text,
    taxBasis: text,
    remark: text,
    authorized: z.boolean(),
  })
  .strict();
function normalizeResource(row) {
  return {
    ...row,
    partNumber: normalizePartNumber(row.partNumber),
    uom: normalizeUnit(row.uom),
    condition: row.condition.trim().toUpperCase(),
    currency: row.currency.trim().toUpperCase(),
    supplierName: row.supplierName.trim(),
    validFrom: row.validFrom.trim(),
    validUntil: row.validUntil.trim(),
    taxBasis:
      { 含税: "inclusive", 不含税: "exclusive", 未税: "exclusive" }[
        row.taxBasis.trim()
      ] || row.taxBasis.trim(),
  };
}

/** Parse each sheet independently and retain original row values. A purchase quantity is never inferred as MOQ. */
export function extractSupplierRows(chunks) {
  const output = [],
    issues = [];
  const headers = new Map();
  for (const chunk of chunks) {
    if (!chunk.cells?.length) {
      if (chunk.text.trim())
        issues.push("存在非表格正文，需补充结构化报价表后入库");
      continue;
    }
    const group = String(chunk.locator.sheet || "table");
    const columns = chunk.cells.map(fieldFor);
    if (columns.includes("partNumber") && columns.includes("unitPrice")) {
      const mapped = columns.filter(Boolean);
      if (new Set(mapped).size !== mapped.length) {
        issues.push(`${group} 存在重复字段列，请核对原表`);
        headers.delete(group);
        continue;
      }
      headers.set(group, columns);
      continue;
    }
    const header = headers.get(group);
    if (!header) {
      if (chunk.cells.some((value) => String(value || "").trim()))
        issues.push(`${group} 缺少件号与单价表头`);
      continue;
    }
    const fields = {},
      rawFields = {};
    chunk.cells.forEach((cell, index) => {
      const raw = String(cell ?? "").trim();
      if (header[index]) fields[header[index]] = raw;
      rawFields[String(index + 1)] = raw;
    });
    if (!Object.values(rawFields).some(Boolean)) continue;
    const unknown = chunk.cells.some(
      (cell, index) => String(cell ?? "").trim() && !header[index],
    );
    if (unknown)
      issues.push(
        `${group} 第 ${chunk.locator.row || "?"} 行存在未映射列，请使用完整字段表头`,
      );
    const lead = fields.leadDays;
    output.push({
      id: randomUUID(),
      contentId: chunk.id,
      locator: chunk.locator,
      rawFields,
      values: normalizeResource({
        partNumber: fields.partNumber || "",
        supplierName: fields.supplierName || "",
        uom: fields.uom || "",
        condition: fields.condition || "",
        unitPrice: normalizeQuantity(fields.unitPrice),
        currency: fields.currency || "",
        moq: normalizeQuantity(fields.moq),
        leadDays: /^0(?:\.0+)?$/.test(lead || "") ? 0 : normalizeQuantity(lead),
        validFrom: fields.validFrom || "",
        validUntil: fields.validUntil || "",
        certType: fields.certType || "",
        taxBasis: fields.taxBasis || "",
        remark: fields.remark || "",
        authorized: false,
      }),
    });
  }
  if (!output.length) issues.push("未读取到供应商报价行");
  if (output.length > 150) issues.push("供应商报价超过150行，请拆分文件");
  return { rows: output.slice(0, 150), issues: [...new Set(issues)] };
}

export function createSupplierImportStore(
  db,
  persist,
  getInquiry,
  {
    modelConfig,
    ocrConfig,
    semantic = extractSupplierSemantic,
    ocr = readOcr,
  } = {},
) {
  db.run(
    `CREATE TABLE IF NOT EXISTS resource_import(id TEXT PRIMARY KEY,inquiry_id TEXT NOT NULL REFERENCES inquiry(id),file_id TEXT NOT NULL REFERENCES file(id),request_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,confirm_hash TEXT,operator TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`,
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS resource_import_inquiry ON resource_import(inquiry_id)",
  );
  db.run(
    "UPDATE file SET status='failed',error='供应商报价处理因重启中断' WHERE id IN (SELECT file_id FROM resource_import WHERE status='processing')",
  );
  for (const interrupted of rows(
    db,
    "SELECT id,data FROM resource_import WHERE status='processing'",
  )) {
    const data = JSON.parse(interrupted.data);
    db.run("UPDATE resource_import SET status='failed',data=? WHERE id=?", [
      JSON.stringify({
        ...data,
        rows: [],
        issues: ["处理因服务重启中断，请重新提取"],
      }),
      interrupted.id,
    ]);
  }
  const record = (id) =>
    rows(db, "SELECT * FROM resource_import WHERE id=?", [id])[0];
  const view = (row) =>
    row
      ? {
          id: row.id,
          inquiryId: row.inquiry_id,
          fileId: row.file_id,
          fileName:
            rows(db, "SELECT name FROM file WHERE id=?", [row.file_id])[0]
              ?.name || "报价文件",
          status: row.status,
          version: row.version,
          ...JSON.parse(row.data),
          sources: rows(
            db,
            "SELECT id,locator,text FROM file_content WHERE file_id=? ORDER BY ordinal",
            [row.file_id],
          ).map((source) => ({
            ...source,
            locator: JSON.parse(source.locator),
            truncated: source.text.length > 10000,
            text: source.text.slice(0, 10000),
          })),
        }
      : null;
  function read(inquiryId, id) {
    const item = record(id);
    if (!item || item.inquiry_id !== inquiryId) fail(404, "报价导入记录不存在");
    return view(item);
  }
  function list(inquiryId) {
    if (!getInquiry(inquiryId)) fail(404, "询价不存在");
    return rows(
      db,
      "SELECT * FROM resource_import WHERE inquiry_id=? ORDER BY created_at DESC",
      [inquiryId],
    ).map(view);
  }
  async function create(inquiryId, input) {
    if (!getInquiry(inquiryId)) fail(404, "询价不存在");
    const parsed = z
      .object({
        requestId: z.string().uuid(),
        operator: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(255),
        mime: z.string().max(200),
        base64: z
          .string()
          .min(1)
          .max(12_000_000)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) fail(400, "供应商报价文件无效");
    const body = parsed.data,
      bytes = Buffer.from(body.base64, "base64");
    if (!bytes.length || bytes.length > 8_000_000)
      fail(413, "单文件不得超过8MB");
    const payloadHash = digest(canonicalJson({ inquiryId, ...body }));
    const duplicate = rows(
      db,
      "SELECT * FROM resource_import WHERE request_id=?",
      [body.requestId],
    )[0];
    if (duplicate) {
      if (duplicate.payload_hash !== payloadHash)
        fail(409, "导入请求内容已变化，请重新选择文件");
      return view(duplicate);
    }
    const id = randomUUID(),
      fileId = randomUUID(),
      time = new Date().toISOString();
    const transaction = (action) => {
      try {
        db.run("BEGIN");
        action();
        db.run("COMMIT");
        persist();
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {}
        db.run("DELETE FROM resource_import WHERE id=?", [id]);
        db.run("DELETE FROM file_content WHERE file_id=?", [fileId]);
        db.run("DELETE FROM file WHERE id=?", [fileId]);
        throw error;
      }
    };
    transaction(() => {
      db.run(
        "INSERT INTO file(id,inquiry_id,parent_id,source,file_type,document_type,mime_type,name,sha256,size,raw,status,parser_version,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          fileId,
          inquiryId,
          null,
          "manual_upload",
          body.name.split(".").pop().toLowerCase(),
          "supplier_quote",
          body.mime,
          body.name,
          digest(bytes),
          bytes.length,
          bytes,
          "processing",
          INTAKE_PARSER_VERSION,
          "{}",
          time,
        ],
      );
      db.run("INSERT INTO resource_import VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [
        id,
        inquiryId,
        fileId,
        body.requestId,
        payloadHash,
        "processing",
        1,
        JSON.stringify({ rows: [], issues: [] }),
        null,
        body.operator,
        time,
        time,
      ]);
    });
    return processFile(inquiryId, id);
  }
  async function processFile(inquiryId, id) {
    const item = record(id),
      file = rows(db, "SELECT name,mime_type,raw FROM file WHERE id=?", [
        item.file_id,
      ])[0];
    const metadata = JSON.parse(item.data).lastRetry
      ? { lastRetry: JSON.parse(item.data).lastRetry }
      : {};
    try {
      const decoded = await decodeFile(file.name, Buffer.from(file.raw)),
        readIssues = [];
      let chunks = decoded.chunks,
        needsOcr = !!decoded.needsOcr;
      if (needsOcr) {
        try {
          const recognized = await ocr(
            Buffer.from(file.raw),
            file.name,
            file.mime_type,
            ocrConfig,
          );
          const pages = new Map(
            recognized?.map((chunk) => [chunk.locator.page, chunk]) || [],
          );
          chunks = chunks.map((chunk) =>
            chunk.text.trim() ? chunk : pages.get(chunk.locator.page) || chunk,
          );
          needsOcr = chunks.some((chunk) => !chunk.text.trim());
        } catch {
          readIssues.push("OCR读取失败，原件已保留，可重新提取");
        }
        if (needsOcr)
          readIssues.push("扫描件或图片尚未完整读取，请配置 OCR 后重新提取");
      }
      if (decoded.kind === "text" && chunks.length) {
        chunks = [
          {
            locator: { line: 1, lineEnd: chunks.length },
            text: chunks.map((chunk) => chunk.text).join("\n"),
            format: "text",
          },
        ];
      }
      chunks = chunks.map((chunk, ordinal) => ({
        ...chunk,
        id: randomUUID(),
        ordinal,
      }));
      // Persist readable source before calling the model, so a failed extraction retains its text.
      db.run("BEGIN");
      try {
        db.run("DELETE FROM file_content WHERE file_id=?", [item.file_id]);
        for (const chunk of chunks)
          db.run("INSERT INTO file_content VALUES(?,?,?,?,?,?,?)", [
            chunk.id,
            item.file_id,
            chunk.ordinal,
            JSON.stringify(chunk.locator),
            chunk.format,
            chunk.text,
            chunk.cells ? JSON.stringify(chunk.cells) : null,
          ]);
        db.run("UPDATE file SET status=?,error=NULL WHERE id=?", [
          needsOcr
            ? "needs_ocr"
            : decoded.unsupported
              ? "unsupported"
              : "parsed",
          item.file_id,
        ]);
        db.run("COMMIT");
        persist();
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {}
        throw error;
      }
      let extracted;
      if (decoded.kind === "spreadsheet")
        extracted = extractSupplierRows(chunks);
      else {
        try {
          extracted = await semantic(chunks, modelConfig);
        } catch {
          extracted = {
            rows: [],
            issues: ["报价字段提取失败，原文已保留，可重新提取"],
          };
        }
      }
      if (decoded.children?.length)
        readIssues.push("邮件附件需分别导入，当前保留邮件原件并读取正文");
      if (decoded.unsupported)
        readIssues.push("暂不支持此文件格式，请补充可读取文件");
      extracted.issues = [...new Set([...extracted.issues, ...readIssues])];
      db.run(
        "UPDATE resource_import SET status='needs_review',version=version+1,data=?,updated_at=? WHERE id=?",
        [
          JSON.stringify({ ...extracted, ...metadata }),
          new Date().toISOString(),
          id,
        ],
      );
      persist();
    } catch (error) {
      db.run(
        "UPDATE resource_import SET status='failed',version=version+1,data=? WHERE id=?",
        [
          JSON.stringify({
            rows: [],
            issues: ["报价读取失败，请核对格式后重新提取"],
            ...metadata,
          }),
          id,
        ],
      );
      db.run("UPDATE file SET status='failed',error=? WHERE id=?", [
        "供应商报价读取失败",
        item.file_id,
      ]);
      persist();
    }
    return read(inquiryId, id);
  }
  async function retry(inquiryId, id, input) {
    const item = record(id);
    if (!item || item.inquiry_id !== inquiryId) fail(404, "报价导入记录不存在");
    const parsed = z
      .object({
        version: z.number().int().positive(),
        requestId: z.string().uuid(),
        operator: z.string().trim().min(1).max(100),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) fail(400, "重新提取请求无效");
    const body = parsed.data,
      requestHash = digest(canonicalJson(body)),
      data = JSON.parse(item.data);
    if (data.lastRetry?.requestId === body.requestId) {
      if (data.lastRetry.requestHash !== requestHash)
        fail(409, "重试请求内容已变化");
      return read(inquiryId, id);
    }
    if (
      item.status === "confirmed" ||
      item.status === "processing" ||
      item.version !== body.version
    )
      fail(409, "导入版本已变化或正在处理，请重新打开");
    const lastRetry = { requestId: body.requestId, requestHash };
    const originalFile = rows(db, "SELECT status,error FROM file WHERE id=?", [
      item.file_id,
    ])[0];
    db.run("BEGIN");
    try {
      db.run(
        "UPDATE resource_import SET status='processing',version=version+1,data=?,operator=?,updated_at=? WHERE id=?",
        [
          JSON.stringify({ rows: [], issues: [], lastRetry }),
          body.operator,
          new Date().toISOString(),
          id,
        ],
      );
      db.run("UPDATE file SET status='processing',error=NULL WHERE id=?", [
        item.file_id,
      ]);
      db.run("COMMIT");
      persist();
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {}
      db.run(
        "UPDATE resource_import SET status=?,version=?,data=?,operator=?,updated_at=? WHERE id=?",
        [
          item.status,
          item.version,
          item.data,
          item.operator,
          item.updated_at,
          id,
        ],
      );
      db.run("UPDATE file SET status=?,error=? WHERE id=?", [
        originalFile.status,
        originalFile.error,
        item.file_id,
      ]);
      throw error;
    }
    return processFile(inquiryId, id);
  }
  function confirm(inquiryId, id, input) {
    const item = record(id);
    if (!item || item.inquiry_id !== inquiryId) fail(404, "报价导入记录不存在");
    const parsed = z
      .object({
        version: z.number().int().positive(),
        operator: z.string().trim().min(1).max(100),
        rows: z.array(editableSchema).min(1).max(150),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) fail(400, "报价核对字段无效");
    const body = parsed.data,
      fingerprint = digest(canonicalJson(body));
    if (item.status === "confirmed") {
      if (item.confirm_hash === fingerprint) return read(inquiryId, id);
      fail(409, "该报价已入库，请重新导入修订版");
    }
    if (item.status !== "needs_review" || item.version !== body.version)
      fail(409, "导入版本已变化，请重新打开");
    const data = JSON.parse(item.data),
      expected = new Set(data.rows.map((row) => row.id));
    if (data.issues.length)
      fail(409, "原表仍有未读取或未映射内容，请补充完整结构化文件");
    if (
      body.rows.length !== expected.size ||
      new Set(body.rows.map((row) => row.id)).size !== expected.size ||
      body.rows.some((row) => !expected.has(row.id))
    )
      fail(400, "报价行与原文件不一致");
    const values = body.rows.map(normalizeResource);
    for (const row of values) {
      if (!row.partNumber || !row.unitPrice || !row.supplierName)
        fail(400, "请补充件号、供应商与有效单价");
      if (
        (row.validFrom && !validDate(row.validFrom)) ||
        (row.validUntil && !validDate(row.validUntil))
      )
        fail(400, "日期请填写 YYYY-MM-DD");
      if (
        row.validFrom &&
        row.validUntil &&
        row.validFrom.slice(0, 10) > row.validUntil.slice(0, 10)
      )
        fail(400, "生效日期不能晚于有效期");
      if (row.taxBasis && !["inclusive", "exclusive"].includes(row.taxBasis))
        fail(400, "税基请选择 inclusive 或 exclusive");
    }
    const file = rows(db, "SELECT name FROM file WHERE id=?", [
        item.file_id,
      ])[0],
      time = new Date().toISOString();
    db.run("BEGIN");
    try {
      for (const value of values) {
        const origin = data.rows.find((row) => row.id === value.id),
          { id: resourceId, ...fields } = value;
        const resource = {
          id: resourceId,
          ...fields,
          sourceDocument: {
            inquiryId,
            fileId: item.file_id,
            contentId: origin.contentId,
            fileName: file.name,
            locator: origin.locator,
            rawFields: origin.rawFields,
            fieldSources: origin.fieldSources,
            rowExcerpt: origin.rowExcerpt,
            operator: body.operator,
            confirmedAt: time,
          },
        };
        db.run(
          "INSERT INTO price_resource(id,part_number,data,source,updated_at,normalized_part_number) VALUES(?,?,?,?,?,?)",
          [
            resourceId,
            value.partNumber,
            JSON.stringify(resource),
            "supplier_upload",
            time,
            value.partNumber,
          ],
        );
      }
      db.run(
        "UPDATE resource_import SET status='confirmed',version=version+1,data=?,confirm_hash=?,operator=?,updated_at=? WHERE id=?",
        [
          JSON.stringify({
            ...data,
            rows: data.rows.map((row) => ({
              ...row,
              values: values.find((value) => value.id === row.id),
            })),
          }),
          fingerprint,
          body.operator,
          time,
          id,
        ],
      );
      db.run("COMMIT");
      persist();
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {}
      // Undo an in-memory commit when durable persistence fails, preserving retry semantics.
      for (const value of values)
        db.run("DELETE FROM price_resource WHERE id=?", [value.id]);
      db.run(
        "UPDATE resource_import SET status=?,version=?,data=?,confirm_hash=?,operator=?,updated_at=? WHERE id=?",
        [
          item.status,
          item.version,
          item.data,
          item.confirm_hash,
          item.operator,
          item.updated_at,
          id,
        ],
      );
      throw error;
    }
    // Refresh is explicit in the workbench. Existing quotes keep their source fingerprint until the operator refreshes.
    return read(inquiryId, id);
  }
  return { create, confirm, retry, read, list };
}
