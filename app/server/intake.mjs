import { randomUUID, createHash } from "node:crypto";
import { decodeFile, INTAKE_PARSER_VERSION } from "./intake-parser.mjs";
import { extractStructured, extractSemantic } from "./intake-extract.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
export function rows(db, sql, args = []) {
  const s = db.prepare(sql);
  try {
    s.bind(args);
    const out = [];
    while (s.step()) out.push(s.getAsObject());
    return out;
  } finally {
    s.free();
  }
}
export function migrateIntakeNames(db) {
  const renames = {
    rfq_batch: "inquiry",
    rfq_file: "file",
    rfq_content: "file_content",
    rfq_line: "inquiry_line",
    rfq_evidence: "evidence",
    rfq_evidence_history: "evidence_history",
    rfq_line_revision: "line_revision",
    rfq_migration: "schema_migration",
  };
  const exists = (name) =>
    rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [
      name,
    ]).length > 0;
  db.run("PRAGMA foreign_keys=ON");
  db.run("BEGIN");
  try {
    for (const [oldName, newName] of Object.entries(renames)) {
      if (exists(oldName) && exists(newName))
        throw new Error(
          `同时存在旧表${oldName}和新表${newName}，停止迁移以保留数据`,
        );
      if (exists(oldName))
        db.run(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
    }
    for (const table of ["file", "inquiry_line"])
      if (
        exists(table) &&
        rows(db, `PRAGMA table_info("${table}")`).some(
          (c) => c.name === "batch_id",
        )
      )
        db.run(`ALTER TABLE "${table}" RENAME COLUMN batch_id TO inquiry_id`);
    for (const index of [
      "rfq_file_batch",
      "rfq_line_batch",
      "rfq_evidence_line",
    ])
      db.run(`DROP INDEX IF EXISTS "${index}"`);
    if (rows(db, "PRAGMA foreign_key_check").length)
      throw new Error("表名迁移后外键检查失败");
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}
export function initIntake(db) {
  migrateIntakeNames(db);
  db.run(`PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS inquiry(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,source TEXT NOT NULL,operator TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,issues TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE IF NOT EXISTS file(id TEXT PRIMARY KEY,inquiry_id TEXT NOT NULL REFERENCES inquiry(id),parent_id TEXT REFERENCES file(id),source TEXT NOT NULL,file_type TEXT NOT NULL,mime_type TEXT NOT NULL,name TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,raw BLOB NOT NULL,status TEXT NOT NULL,parser_version TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',error TEXT,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS file_inquiry ON file(inquiry_id);
 CREATE TABLE IF NOT EXISTS file_content(id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES file(id),ordinal INTEGER NOT NULL,locator TEXT NOT NULL,format TEXT NOT NULL,text TEXT NOT NULL,cells TEXT,UNIQUE(file_id,ordinal));
 CREATE TABLE IF NOT EXISTS inquiry_line(id TEXT PRIMARY KEY,inquiry_id TEXT NOT NULL REFERENCES inquiry(id),content_id TEXT NOT NULL REFERENCES file_content(id),line_no INTEGER NOT NULL,fields TEXT NOT NULL,issues TEXT NOT NULL,method TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS inquiry_line_inquiry ON inquiry_line(inquiry_id);
 CREATE TABLE IF NOT EXISTS price_resource(id TEXT PRIMARY KEY,part_number TEXT NOT NULL,data TEXT NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS price_resource_pn ON price_resource(part_number);
 CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,line_id TEXT NOT NULL REFERENCES inquiry_line(id),source TEXT NOT NULL,source_key TEXT NOT NULL,snapshot TEXT NOT NULL,matched_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS evidence_history(id TEXT PRIMARY KEY,line_id TEXT NOT NULL REFERENCES inquiry_line(id),source TEXT NOT NULL,source_key TEXT NOT NULL,snapshot TEXT NOT NULL,matched_at TEXT NOT NULL,archived_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS evidence_line ON evidence(line_id);
 CREATE TABLE IF NOT EXISTS line_revision(id TEXT PRIMARY KEY,line_id TEXT NOT NULL REFERENCES inquiry_line(id),version INTEGER NOT NULL,fields TEXT NOT NULL,operator TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS schema_migration(id TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
 `);
}
export function seedPrices(db, seed) {
  if (
    rows(db, "SELECT id FROM schema_migration WHERE id=?", ["prices-v1"]).length
  )
    return;
  db.run("BEGIN");
  try {
    for (const p of seed) {
      db.run("INSERT OR IGNORE INTO price_resource VALUES(?,?,?,?,?)", [
        p.id,
        p.partNumber,
        JSON.stringify(p),
        "official_demo",
        new Date().toISOString(),
      ]);
    }
    db.run("INSERT INTO schema_migration VALUES(?,?)", [
      "prices-v1",
      new Date().toISOString(),
    ]);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
export function createIntakeService(
  db,
  persist,
  { modelConfig, ocrConfig, semantic = extractSemantic } = {},
) {
  const one = (sql, args) => rows(db, sql, args)[0];
  const now = () => new Date().toISOString();
  function list(filters = {}) {
    const clauses = [],
      args = [];
    for (const [key, column] of [
      ["source", "source"],
      ["operator", "operator"],
      ["from", "created_at"],
      ["to", "created_at"],
    ])
      if (filters[key]) {
        clauses.push(
          `b.${column} ${key === "from" ? ">=" : key === "to" ? "<=" : "="} ?`,
        );
        args.push(filters[key]);
      }
    return rows(
      db,
      `SELECT b.*, (SELECT count(*) FROM file f WHERE f.inquiry_id=b.id) file_count,(SELECT count(*) FROM inquiry_line l WHERE l.inquiry_id=b.id) line_count FROM inquiry b ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY created_at DESC`,
      args,
    ).map((b) => ({ ...b, issues: JSON.parse(b.issues) }));
  }
  function detail(id) {
    const batch = one("SELECT * FROM inquiry WHERE id=?", [id]);
    if (!batch) return null;
    return {
      ...batch,
      issues: JSON.parse(batch.issues),
      files: rows(
        db,
        "SELECT id,inquiry_id,parent_id,source,file_type,mime_type,name,sha256,size,status,parser_version,metadata,error,created_at FROM file WHERE inquiry_id=? ORDER BY rowid",
        [id],
      ).map((f) => ({ ...f, metadata: JSON.parse(f.metadata) })),
      contents: rows(
        db,
        "SELECT c.* FROM file_content c JOIN file f ON f.id=c.file_id WHERE f.inquiry_id=? ORDER BY f.rowid,c.ordinal",
        [id],
      ).map((c) => ({
        ...c,
        locator: JSON.parse(c.locator),
        cells: c.cells ? JSON.parse(c.cells) : undefined,
      })),
      lines: rows(
        db,
        "SELECT * FROM inquiry_line WHERE inquiry_id=? ORDER BY line_no",
        [id],
      ).map((l) => ({
        ...JSON.parse(l.fields),
        id: l.id,
        lineNo: l.line_no,
        contentId: l.content_id,
        issues: JSON.parse(l.issues),
        method: l.method,
        version: l.version,
        evidence: rows(db, "SELECT * FROM evidence WHERE line_id=?", [
          l.id,
        ]).map((e) => ({ ...e, snapshot: JSON.parse(e.snapshot) })),
      })),
    };
  }
  function matchEvidence(lineId, partNumber) {
    db.run(
      "INSERT INTO evidence_history SELECT *,? FROM evidence WHERE line_id=?",
      [now(), lineId],
    );
    db.run("DELETE FROM evidence WHERE line_id=?", [lineId]);
    if (!partNumber) return;
    const stock = one("SELECT * FROM inventory WHERE partNumber=?", [
      partNumber,
    ]);
    if (stock)
      db.run("INSERT INTO evidence VALUES(?,?,?,?,?,?)", [
        randomUUID(),
        lineId,
        "inventory",
        partNumber,
        JSON.stringify(stock),
        now(),
      ]);
    for (const price of rows(
      db,
      "SELECT * FROM price_resource WHERE part_number=?",
      [partNumber],
    ))
      db.run("INSERT INTO evidence VALUES(?,?,?,?,?,?)", [
        randomUUID(),
        lineId,
        "supplier_price",
        price.id,
        JSON.stringify({
          ...JSON.parse(price.data),
          dataSource: price.source,
          dataUpdatedAt: price.updated_at,
        }),
        now(),
      ]);
  }
  function updateStatus(id) {
    const b = one("SELECT issues FROM inquiry WHERE id=?", [id]);
    const issues = JSON.parse(b.issues).filter(
      (i) => !/^\d+行未找到精确件号/.test(i),
    );
    const lines = rows(
      db,
      "SELECT l.*, (SELECT count(*) FROM evidence e WHERE e.line_id=l.id) matched FROM inquiry_line l WHERE inquiry_id=?",
      [id],
    );
    const unmatched = lines.filter((l) => !l.matched).length;
    if (unmatched) issues.push(`${unmatched}行未找到精确件号库存或供应商依据`);
    const needs =
      !lines.length ||
      issues.length ||
      lines.some((l) => JSON.parse(l.issues).length) ||
      rows(db, "SELECT id FROM file WHERE inquiry_id=? AND status!='parsed'", [
        id,
      ]).length;
    db.run("UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?", [
      needs ? "needs_input" : "evidence_ready",
      JSON.stringify(issues),
      now(),
      id,
    ]);
  }
  async function ocr(bytes,name="document.pdf",mime="application/pdf") {
    if (!ocrConfig?.baseURL) return null;
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: mime }),
      name,
    );
    form.append("api_key", ocrConfig.apiKey || "");
    form.append("output_formats", "json");
    const r = await fetch(
      ocrConfig.baseURL.replace(/\/$/, "") + "/parse/sync",
      { method: "POST", body: form, signal: AbortSignal.timeout(90000) },
    );
    if (!r.ok) throw new Error(`OCR服务失败（HTTP ${r.status}）`);
    const j = await r.json();
    const pages = j.data?.result?.outputs?.json?.pages;
    if (!Array.isArray(pages)) throw new Error("OCR响应缺少页面内容");
    return pages.map((p, i) => ({
      locator: { page: i + 1, engine: "ocr" },
      format: "text",
      text: (p.blocks || [])
        .map((b) => b.content || "")
        .join("\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/(td|th)>/gi, "\t")
        .replace(/<[^>]*>/g, ""),
    }));
  }
  async function create(input) {
    const source = input.source || "manual_upload";
    if (!["manual_upload", "paste", "chat"].includes(source))
      throw Object.assign(new Error("无效source"), { status: 400 });
    if (
      !Array.isArray(input.files) ||
      !input.files.length ||
      input.files.length > 20
    )
      throw Object.assign(new Error("每批上传1–20个文件"), { status: 400 });
    if (
      typeof input.requestId !== "string" ||
      input.requestId.length < 8 ||
      input.requestId.length > 120
    )
      throw Object.assign(new Error("需要稳定的requestId"), { status: 400 });
    const files = input.files.map((f) => {
      if (
        typeof f.name !== "string" ||
        f.name.length > 255 ||
        !f.name.trim() ||
        typeof f.base64 !== "string" ||
        !f.base64 ||
        f.base64.length > 12_000_000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)
      )
        throw Object.assign(new Error("文件名或base64无效"), { status: 400 });
      const bytes = Buffer.from(f.base64, "base64");
      if (bytes.length > 8_000_000)
        throw Object.assign(new Error("单文件不得超过8MB"), { status: 413 });
      return {
        name: f.name,
        bytes,
        mime: String(f.mime || "application/octet-stream"),
      };
    });
    if (files.reduce((n, f) => n + f.bytes.length, 0) > 24_000_000)
      throw Object.assign(new Error("批次总大小不得超过24MB"), { status: 413 });
    const operator = String(input.operator || "本机用户").slice(0, 100),
      title = String(input.title || files[0].name).slice(0, 200);
    const digest = hash(
      JSON.stringify({
        source,
        operator,
        title,
        files: files.map((f) => [f.name, hash(f.bytes)]),
      }),
    );
    const old = one("SELECT * FROM inquiry WHERE request_id=?", [
      input.requestId,
    ]);
    if (old) {
      if (old.payload_hash !== digest)
        throw Object.assign(new Error("requestId已用于其他内容"), {
          status: 409,
        });
      return detail(old.id);
    }
    const id = randomUUID(),
      at = now();
    db.run("INSERT INTO inquiry VALUES(?,?,?,?,?,?,?,?,?,?)", [
      id,
      input.requestId,
      digest,
      source,
      operator,
      title,
      "processing",
      at,
      at,
      "[]",
    ]);
    persist();
    const issues = [],
      chunks = [];
    let count = 0,
      total = 0;
    async function add(file, parentId = null, depth = 0) {
      if (
        ++count > 60 ||
        depth > 3 ||
        (total += file.bytes.length) > 32_000_000
      )
        throw new Error("邮件附件展开超过数量、层级或大小限制");
      const fid = randomUUID();
      db.run(
        "INSERT INTO file(id,inquiry_id,parent_id,source,file_type,mime_type,name,sha256,size,raw,status,parser_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          fid,
          id,
          parentId,
          parentId ? "email_attachment" : source,
          file.name.split(".").pop().toLowerCase(),
          file.mime,
          file.name,
          hash(file.bytes),
          file.bytes.length,
          file.bytes,
          "processing",
          INTAKE_PARSER_VERSION,
          at,
        ],
      );
      persist();
      try {
        const parsed = await decodeFile(file.name, file.bytes);
        let extracted = parsed.chunks;
        db.run("UPDATE file SET metadata=? WHERE id=?", [
          JSON.stringify(parsed.metadata || {}),
          fid,
        ]);
        let state = parsed.unsupported ? "unsupported" : "parsed";
        if (parsed.needsOcr) {
          try {
            const result = await ocr(file.bytes,file.name,file.mime);
            if (result) {
              const byPage = new Map(result.map((c) => [c.locator.page, c]));
              extracted = extracted.map((c) =>
                c.text.trim() ? c : byPage.get(c.locator.page) || c,
              );
            }
            if (extracted.some((c) => !c.text.trim())) state = "needs_ocr";
          } catch (e) {
            state = "needs_ocr";
            issues.push(`${file.name}：${e.message}`);
          }
          if (!ocrConfig?.baseURL) state = "needs_ocr";
        }
        for (const [ordinal, c] of extracted.entries()) {
          const cid = randomUUID();
          const chunk = { ...c, id: cid, fileId: fid };
          db.run("INSERT INTO file_content VALUES(?,?,?,?,?,?,?)", [
            cid,
            fid,
            ordinal,
            JSON.stringify(c.locator),
            c.format,
            c.text,
            c.cells ? JSON.stringify(c.cells) : null,
          ]);
          chunks.push(chunk);
        }
        db.run("UPDATE file SET status=? WHERE id=?", [state, fid]);
        if (state === "needs_ocr")
          issues.push(
            `${file.name}：部分页面无文本，待配置OCR或补充可读取材料`,
          );
        if (parsed.unsupported)
          issues.push(`${file.name}：暂不支持此文件类型，原件已保存`);
        for (const child of parsed.children) await add(child, fid, depth + 1);
      } catch (e) {
        db.run("UPDATE file SET status=?,error=? WHERE id=?", [
          "failed",
          String(e.message).slice(0, 400),
          fid,
        ]);
        issues.push(
          `${file.name}：解析失败，原件已保存（${String(e.message).slice(0, 200)}）`,
        );
      }
      persist();
    }
    try {
      for (const f of files) await add(f);
      const result = extractStructured(chunks);
      let extra = { lines: [], issues: [] };
      try {
        extra = await semantic(result.unresolved, modelConfig);
      } catch (e) {
        extra.issues = [e.message];
      }
      issues.push(...extra.issues);
      const covered = new Set(extra.lines.map((l) => l.contentId));
      const pending = result.unresolved.filter(
        (c) =>
          !covered.has(c.id) &&
          /[0-9]|要求|证书|交期|有效|截止|FAA|EASA|certificate|delivery|condition|MOQ/i.test(
            c.text,
          ),
      );
      if (pending.length)
        issues.push(
          `${pending.length}处原文包含未落实到物料行的要求或数据，需核对原文`,
        );
      const all = [...result.lines, ...extra.lines];
      db.run("BEGIN");
      try {
        for (const [i, l] of all.entries()) {
          const lid = randomUUID();
          db.run(
            "INSERT INTO inquiry_line(id,inquiry_id,content_id,line_no,fields,issues,method,created_at) VALUES(?,?,?,?,?,?,?,?)",
            [
              lid,
              id,
              l.contentId,
              i + 1,
              JSON.stringify(l),
              JSON.stringify(l.issues),
              l.method,
              now(),
            ],
          );
          matchEvidence(lid, l.partNumber);
        }
        db.run("COMMIT");
      } catch (e) {
        db.run("ROLLBACK");
        throw e;
      }
      const unmatched =
        all.length -
        rows(
          db,
          "SELECT DISTINCT l.id FROM inquiry_line l JOIN evidence e ON e.line_id=l.id WHERE l.inquiry_id=?",
          [id],
        ).length;
      if (unmatched)
        issues.push(`${unmatched}行未找到精确件号库存或供应商依据`);
      const needs =
        issues.length || !all.length || all.some((l) => l.issues.length);
      db.run("UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?", [
        needs ? "needs_input" : "evidence_ready",
        JSON.stringify(issues),
        now(),
        id,
      ]);
    } catch (e) {
      issues.push(String(e.message).slice(0, 300));
      db.run("UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?", [
        "failed",
        JSON.stringify(issues),
        now(),
        id,
      ]);
    }
    persist();
    return detail(id);
  }
  function refresh(id) {
    if (!one("SELECT id FROM inquiry WHERE id=?", [id])) return null;
    db.run("BEGIN");
    try {
      for (const l of rows(
        db,
        "SELECT * FROM inquiry_line WHERE inquiry_id=?",
        [id],
      ))
        matchEvidence(l.id, JSON.parse(l.fields).partNumber);
      db.run("UPDATE inquiry SET updated_at=? WHERE id=?", [now(), id]);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
    updateStatus(id);
    persist();
    return detail(id);
  }
  function addLine(
    batchId,
    { partNumber, quantity, uom, description = "", operator = "本机用户" },
  ) {
    if (!one("SELECT id FROM inquiry WHERE id=?", [batchId]))
      throw Object.assign(new Error("批次不存在"), { status: 404 });
    if (
      typeof partNumber !== "string" ||
      !partNumber.trim() ||
      partNumber.length > 100 ||
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      typeof uom !== "string" ||
      !uom.trim() ||
      uom.length > 30 ||
      typeof description !== "string" ||
      description.length > 4000
    )
      throw Object.assign(new Error("请填写件号、单位及有效数量"), {
        status: 400,
      });
    const fid = randomUUID(),
      cid = randomUUID(),
      lid = randomUUID(),
      at = now();
    const fields = {
      partNumber: partNumber.trim(),
      quantity,
      uom: uom.trim(),
      description,
      condition: null,
      issues: ["缺件状"],
      contentId: cid,
      method: "manual",
    };
    const bytes = Buffer.from(JSON.stringify({ operator, ...fields }));
    db.run("BEGIN");
    try {
      db.run(
        "INSERT INTO file(id,inquiry_id,parent_id,source,file_type,mime_type,name,sha256,size,raw,status,parser_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          fid,
          batchId,
          null,
          "manual_entry",
          "txt",
          "text/plain",
          "人工补充.txt",
          hash(bytes),
          bytes.length,
          bytes,
          "parsed",
          INTAKE_PARSER_VERSION,
          at,
        ],
      );
      db.run("INSERT INTO file_content VALUES(?,?,?,?,?,?,?)", [
        cid,
        fid,
        0,
        JSON.stringify({ line: 1 }),
        "text",
        bytes.toString(),
        null,
      ]);
      const n = one(
        "SELECT COALESCE(MAX(line_no),0)+1 n FROM inquiry_line WHERE inquiry_id=?",
        [batchId],
      ).n;
      db.run(
        "INSERT INTO inquiry_line(id,inquiry_id,content_id,line_no,fields,issues,method,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          lid,
          batchId,
          cid,
          n,
          JSON.stringify(fields),
          JSON.stringify(fields.issues),
          "manual",
          at,
        ],
      );
      matchEvidence(lid, fields.partNumber);
      db.run("UPDATE inquiry SET status=?,updated_at=? WHERE id=?", [
        "needs_input",
        at,
        batchId,
      ]);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
    updateStatus(batchId);
    persist();
    return detail(batchId);
  }
  function updateLine(
    batchId,
    lineId,
    { version, patch, operator = "本机用户" },
  ) {
    const old = one("SELECT * FROM inquiry_line WHERE id=? AND inquiry_id=?", [
      lineId,
      batchId,
    ]);
    if (!old) throw Object.assign(new Error("物料行不存在"), { status: 404 });
    if (version !== old.version)
      throw Object.assign(new Error("物料已修改，请刷新后重试"), {
        status: 409,
      });
    const fields = JSON.parse(old.fields),
      allowed = [
        "partNumber",
        "description",
        "quantity",
        "uom",
        "condition",
        "requirement",
        "dueDate",
        "mpn",
        "priority",
        "manualPn",
        "productScope",
      ];
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some((k) => !allowed.includes(k))
    )
      throw Object.assign(new Error("无效修改字段"), { status: 400 });
    for (const [k, v] of Object.entries(patch)) {
      if (k === "quantity") {
        if (
          v !== null &&
          !(typeof v === "number" && Number.isFinite(v) && v > 0)
        )
          throw Object.assign(new Error("数量必须为正数或空"), { status: 400 });
      } else if (v !== null && (typeof v !== "string" || v.length > 4000))
        throw Object.assign(new Error("字段类型无效"), { status: 400 });
      fields[k] = v;
    }
    const issues = [];
    if (!fields.partNumber) issues.push("缺件号");
    if (!(fields.quantity > 0)) issues.push("缺少有效数量");
    if (!fields.uom) issues.push("缺单位");
    if (!fields.condition) issues.push("缺件状");
    fields.issues = issues;
    db.run("BEGIN");
    try {
      db.run("INSERT INTO line_revision VALUES(?,?,?,?,?,?)", [
        randomUUID(),
        lineId,
        old.version,
        old.fields,
        String(operator).slice(0, 100),
        now(),
      ]);
      db.run(
        "UPDATE inquiry_line SET fields=?,issues=?,method=?,version=version+1 WHERE id=?",
        [JSON.stringify(fields), JSON.stringify(issues), "manual", lineId],
      );
      matchEvidence(lineId, fields.partNumber);
      db.run("UPDATE inquiry SET updated_at=? WHERE id=?", [now(), batchId]);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
    updateStatus(batchId);
    persist();
    return detail(batchId);
  }
  return {
    create,
    list,
    detail,
    refresh,
    updateLine,
    addLine,
    rawFile(id) {
      return one("SELECT raw,mime_type,name FROM file WHERE id=?", [id]);
    },
    prices() {
      return rows(db, "SELECT * FROM price_resource ORDER BY id").map((p) =>
        JSON.parse(p.data),
      );
    },
  };
}
