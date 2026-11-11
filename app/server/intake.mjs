import {fieldConflictIssues} from '../shared/field-review.mjs';
import {readOcr} from './ocr-reader.mjs';
import { normalizeLine, normalizePartNumber, DOCUMENT_TYPES, NORMALIZATION_VERSION } from "./normalization.mjs";
import { evaluateResource } from "./resource-match.mjs";
import { randomUUID, createHash } from "node:crypto";
import { decodeFile, INTAKE_PARSER_VERSION } from "./intake-parser.mjs";
import { extractStructured, extractSemantic, mergeExtractedRequirements, mergeSemanticLines, extractionFieldLabel, hasUnmappedText, hasGlobalScope, containsPartNumber } from "./intake-extract.mjs";
import { DEFAULT_SCHEMA, conditionRequired } from '../shared/field-schema.mjs';
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
 CREATE TABLE IF NOT EXISTS review_log(id INTEGER PRIMARY KEY AUTOINCREMENT,task TEXT DEFAULT '',pn TEXT DEFAULT '',action TEXT DEFAULT '',detail TEXT DEFAULT '',operator TEXT DEFAULT '',created_at TEXT DEFAULT '');
 `);
  migrateNormalization(db);
  migrateRequirementScope(db);
}
function migrateRequirementScope(db) {
  const migration='requirement-scope-v2';
  if (rows(db,'SELECT id FROM schema_migration WHERE id=?',[migration]).length) return;
  db.run('BEGIN');
  try {
    for (const inquiry of rows(db,'SELECT id,issues FROM inquiry')) {
      const stored=rows(db,'SELECT * FROM inquiry_line WHERE inquiry_id=?',[inquiry.id]);
      const lines=stored.map(row=>JSON.parse(row.fields));
      const chunks=rows(db,'SELECT c.* FROM file_content c JOIN file f ON f.id=c.file_id WHERE f.inquiry_id=?',[inquiry.id]).map(chunk=>({...chunk,locator:JSON.parse(chunk.locator)}));
      for (const row of stored) {
        const line=JSON.parse(row.fields), issues=JSON.parse(row.issues);
        for (const [key,origin] of Object.entries(line.fieldSources || {})) {
          const sources=origin.sources || [];
          const invalid=sources.some(source=>{const chunk=chunks.find(chunk=>chunk.id===source.contentId);return source.scope==='all'?!hasGlobalScope(chunk||{text:''},lines):source.scope==='part'&&(!source.partNumber||!chunk||!chunk.text.split(/[\r\n；;。]/).some(fragment=>containsPartNumber(fragment,source.partNumber)&&fragment.includes(source.value)));});
          const lost=origin.method==='manual'&&!origin.previousSources&&rows(db,'SELECT fields FROM line_revision WHERE line_id=?',[row.id]).some(revision=>JSON.parse(revision.fields).fieldSources?.[key]?.sources?.some(source=>source.scope==='all'));
          if (invalid||lost) issues.push(`共同要求的${extractionFieldLabel(key)}适用范围需确认`);
        }
        if (JSON.stringify(issues)===row.issues) continue;
        line.issues=[...new Set(issues)];
        db.run('INSERT INTO line_revision VALUES(?,?,?,?,?,?)',[randomUUID(),row.id,row.version,row.fields,'requirement_scope_migration',new Date().toISOString()]);
        db.run('UPDATE inquiry_line SET fields=?,issues=?,version=version+1 WHERE id=?',[JSON.stringify(line),JSON.stringify(line.issues),row.id]);
        db.run("UPDATE inquiry SET status='needs_input' WHERE id=?",[inquiry.id]);
      }
    }
    db.run('INSERT INTO schema_migration VALUES(?,?)',[migration,new Date().toISOString()]);
    db.run('COMMIT');
  } catch(error) { db.run('ROLLBACK');throw error; }
}
export function migrateNormalization(db) {
  const has = (table, name) => rows(db, `PRAGMA table_info("${table}")`).some(column => column.name === name);
  db.run("BEGIN");
  try {
    if (!has('inquiry', 'requirements')) db.run("ALTER TABLE inquiry ADD COLUMN requirements TEXT NOT NULL DEFAULT '[]'");
    if (!has('file', 'document_type')) db.run("ALTER TABLE file ADD COLUMN document_type TEXT NOT NULL DEFAULT 'unknown'");
    if (!has('inquiry_line', 'part_number')) db.run("ALTER TABLE inquiry_line ADD COLUMN part_number TEXT");
    db.run("CREATE INDEX IF NOT EXISTS inquiry_line_part_number ON inquiry_line(part_number)");
    if (!has('inventory', 'normalized_part_number')) db.run("ALTER TABLE inventory ADD COLUMN normalized_part_number TEXT");
    if (!has('price_resource', 'normalized_part_number')) db.run("ALTER TABLE price_resource ADD COLUMN normalized_part_number TEXT");
    db.run("CREATE INDEX IF NOT EXISTS price_resource_normalized_part ON price_resource(normalized_part_number)");
    db.run("CREATE INDEX IF NOT EXISTS inventory_normalized_part ON inventory(normalized_part_number)");
    for (const stock of rows(db, 'SELECT partNumber FROM inventory')) db.run('UPDATE inventory SET normalized_part_number=? WHERE partNumber=?', [normalizePartNumber(stock.partNumber), stock.partNumber]);
    for (const price of rows(db, 'SELECT id,part_number FROM price_resource')) db.run('UPDATE price_resource SET normalized_part_number=? WHERE id=?', [normalizePartNumber(price.part_number), price.id]);
    const migrationId = `normalization-v${NORMALIZATION_VERSION}`;
    const applied = rows(db, "SELECT id FROM schema_migration WHERE id=?", [migrationId]).length > 0;
    if (applied) { db.run("COMMIT"); return; }
    for (const row of rows(db, "SELECT id,inquiry_id,fields,issues,version,content_id,method FROM inquiry_line")) {
      const previous = JSON.parse(row.fields);
      // 数据库迁移发生在服务初始化阶段，此时企业字段定义尚未加载；按默认件状必填迁移，实际规则在业务调用时生效
      const fields = normalizeLine({ ...previous, rawFields: previous.rawFields || {}, rawFieldsStatus: previous.rawFields ? "recorded" : "legacy_unknown" }, { contentId: previous.rawFields ? row.content_id : null, method: previous.rawFields ? row.method : "legacy_unknown", requireCondition: conditionRequired(DEFAULT_SCHEMA) });
      const changed = ['partNumber','quantity','uom','condition','dueDate'].some(key=>previous[key]!==fields[key]) || row.issues !== JSON.stringify(fields.issues);
      if (changed) {
        db.run("INSERT INTO line_revision VALUES(?,?,?,?,?,?)", [randomUUID(), row.id, row.version, row.fields, "normalization_migration", new Date().toISOString()]);
        db.run("UPDATE inquiry_line SET version=version+1 WHERE id=?", [row.id]);
        const inquiry = rows(db, 'SELECT issues FROM inquiry WHERE id=?', [row.inquiry_id])[0];
        const issues = [...new Set([...JSON.parse(inquiry.issues), '标准字段已更新，请刷新依据'])];
        db.run("UPDATE inquiry SET status='needs_input',issues=? WHERE id=?", [JSON.stringify(issues), row.inquiry_id]);
      }
      db.run("UPDATE inquiry_line SET fields=?,issues=?,part_number=? WHERE id=?", [JSON.stringify(fields), JSON.stringify(fields.issues), fields.partNumber, row.id]);
    }
    db.run("INSERT INTO schema_migration VALUES(?,?)", [migrationId, new Date().toISOString()]);
    db.run("COMMIT");
  } catch (error) { db.run("ROLLBACK"); throw error; }
}
export function seedPrices(db, seed) {
  if (
    rows(db, "SELECT id FROM schema_migration WHERE id=?", ["prices-v1"]).length
  )
    return;
  db.run("BEGIN");
  try {
    for (const p of seed) {
      db.run("INSERT OR IGNORE INTO price_resource(id,part_number,data,source,updated_at,normalized_part_number) VALUES(?,?,?,?,?,?)", [
        p.id,
        p.partNumber,
        JSON.stringify(p),
        "official_demo",
        new Date().toISOString(),
        normalizePartNumber(p.partNumber),
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
export function recoverInterruptedIntakes(db) {
  for (const inquiry of rows(db,"SELECT id,issues FROM inquiry WHERE status='processing'")) {
    const issues=[...new Set([...JSON.parse(inquiry.issues||'[]'),'服务重启中断了处理，已保留已接收文件'])];
    db.run("UPDATE inquiry SET status='interrupted',issues=? WHERE id=?",[JSON.stringify(issues),inquiry.id]);
  }
}

export function createIntakeService(
  db,
  persist,
  { modelConfig, ocrConfig, semantic = extractSemantic, getSchema = () => DEFAULT_SCHEMA } = {},
) {
  const one = (sql, args) => rows(db, sql, args)[0];
  const now = () => new Date().toISOString();
  // 多账户：列/表存在性在服务工厂创建时确定（index.mjs 在 accounts-v1 迁移后创建服务）
  const ownerColumn = rows(db, "PRAGMA table_info(inquiry)").some((c) => c.name === "owner_id");
  const accountTable = rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='account'").length > 0;
  const priceAccountColumn = rows(db, "PRAGMA table_info(price_resource)").some((c) => c.name === "account_id");
  const inventoryAccountColumn = rows(db, "PRAGMA table_info(inventory)").some((c) => c.name === "account_id");
  const ownerJoin = ownerColumn && accountTable;
  const ownerOf = (id) => (ownerColumn ? one("SELECT owner_id FROM inquiry WHERE id=?", [id])?.owner_id ?? null : null);
  const schemaFor = (inquiryId) => getSchema({ accountId: ownerOf(inquiryId) });
  /** 写操作归属校验：子账户只能操作自己的询价；master 可改任意账户。 */
  function assertWrite(ctx, id) {
    if (!ownerColumn || !ctx || ctx.role === "master") return;
    const row = one("SELECT owner_id FROM inquiry WHERE id=?", [id]);
    if (!row) throw Object.assign(new Error("询价不存在"), { status: 404 });
    if (row.owner_id !== ctx.accountId)
      throw Object.assign(new Error("无权操作他人询价"), { status: 403 });
  }
  function list(filters = {}, ctx) {
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
    if (ownerColumn && ctx && ctx.role !== "master") {
      clauses.push("(b.owner_id=? OR b.owner_id IS NULL)");
      args.push(ctx.accountId);
    }
    return rows(
      db,
      `SELECT b.*, ${ownerJoin ? "a.display_name owner_name," : ""} (SELECT count(*) FROM file f WHERE f.inquiry_id=b.id) file_count,(SELECT count(*) FROM inquiry_line l WHERE l.inquiry_id=b.id) line_count FROM inquiry b ${ownerJoin ? "LEFT JOIN account a ON a.id=b.owner_id" : ""} ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY created_at DESC`,
      args,
    ).map((b) => ({ ...b, issues: JSON.parse(b.issues) }));
  }
  function detail(id, ctx) {
    const batch = one(
      `SELECT b.*${ownerJoin ? ",a.display_name owner_name" : ""} FROM inquiry b ${ownerJoin ? "LEFT JOIN account a ON a.id=b.owner_id" : ""} WHERE b.id=?`,
      [id],
    );
    if (!batch) return null;
    if (ownerColumn && ctx && ctx.role !== "master" && batch.owner_id && batch.owner_id !== ctx.accountId) return null;
    return {
      ...batch,
      issues: JSON.parse(batch.issues),
      requirements: JSON.parse(batch.requirements || "[]"),
      files: rows(
        db,
        "SELECT id,inquiry_id,parent_id,source,file_type,document_type,mime_type,name,sha256,size,status,parser_version,metadata,error,created_at FROM file WHERE inquiry_id=? ORDER BY rowid",
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
        evidence: (ownerColumn && !batch.owner_id ? [] : rows(db, "SELECT * FROM evidence WHERE line_id=?", [
          l.id,
        ])).map((e) => {
          const snapshot = JSON.parse(e.snapshot);
          return { ...e, snapshot, current_match: evaluateResource(JSON.parse(l.fields), snapshot, { source: e.source, sourceKey: e.source_key }) };
        }),
      })),
    };
  }
  function matchEvidence(lineId, partNumber) {
    const fields = JSON.parse(one("SELECT fields FROM inquiry_line WHERE id=?", [lineId]).fields);
    partNumber = normalizePartNumber(partNumber);
    db.run("UPDATE inquiry_line SET part_number=? WHERE id=?", [partNumber, lineId]);
    db.run(
      "INSERT INTO evidence_history SELECT *,? FROM evidence WHERE line_id=?",
      [now(), lineId],
    );
    db.run("DELETE FROM evidence WHERE line_id=?", [lineId]);
    if (!partNumber) return;
    // 基础数据按账号隔离：依据只匹配询价归属账户的库存与价格
    const lineOwner = ownerColumn
      ? one("SELECT i.owner_id FROM inquiry_line l JOIN inquiry i ON i.id=l.inquiry_id WHERE l.id=?", [lineId])?.owner_id ?? null
      : null;
    const scope = (hasColumn) => (hasColumn && ownerColumn ? { clause: " AND account_id=?", args: [lineOwner] } : { clause: "", args: [] });
    const stockScope = scope(inventoryAccountColumn);
    const stocks = rows(db, `SELECT * FROM inventory WHERE normalized_part_number=?${stockScope.clause}`, [partNumber, ...stockScope.args]);
    for (const stock of stocks)
      db.run("INSERT INTO evidence VALUES(?,?,?,?,?,?)", [
        randomUUID(),
        lineId,
        "inventory",
        stock.partNumber,
        JSON.stringify({ ...stock, match: evaluateResource(fields, stock, { source: "inventory", sourceKey: stock.partNumber }) }),
        now(),
      ]);
    const priceScope = scope(priceAccountColumn);
    for (const price of rows(db, `SELECT * FROM price_resource WHERE normalized_part_number=?${priceScope.clause}`, [partNumber, ...priceScope.args]))
      db.run("INSERT INTO evidence VALUES(?,?,?,?,?,?)", [
        randomUUID(),
        lineId,
        "supplier_price",
        price.id,
        JSON.stringify({
          ...JSON.parse(price.data),
          dataSource: price.source,
          dataUpdatedAt: price.updated_at,
          match: evaluateResource(fields, JSON.parse(price.data), { source: "supplier_price", sourceKey: price.id }),
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
  const ocr=(bytes,name,mime)=>readOcr(bytes,name,mime,ocrConfig);
  function storeOriginal(file, id, parentId, source, at) {
    const fid = randomUUID();
    db.run(
      "INSERT INTO file(id,inquiry_id,parent_id,source,file_type,mime_type,name,sha256,size,raw,status,parser_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [fid, id, parentId, parentId ? "email_attachment" : source,
        file.name.split(".").pop().toLowerCase(), file.mime, file.name,
        hash(file.bytes), file.bytes.length, file.bytes, "processing", INTAKE_PARSER_VERSION, at],
    );
    db.run("UPDATE file SET document_type=? WHERE id=?", [file.documentType || "customer_inquiry", fid]);
    return fid;
  }
  function assertNotProcessing(id) {
    if (one('SELECT status FROM inquiry WHERE id=?', [id])?.status === 'processing') {
      throw Object.assign(new Error('材料仍在处理中，请稍后核对'), {status: 409});
    }
  }
  async function create(input, onProgress = () => {}, ctx) {
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
      if (f.document_type && !DOCUMENT_TYPES.includes(f.document_type)) throw Object.assign(new Error("无效资料类型"), { status: 400 });
      const bytes = Buffer.from(f.base64, "base64");
      if (bytes.length > 8_000_000)
        throw Object.assign(new Error("单文件不得超过8MB"), { status: 413 });
      return {
        name: f.name,
        bytes,
        mime: String(f.mime || "application/octet-stream"),
        documentType: f.document_type || "customer_inquiry",
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
        files: files.map((f) => f.documentType === "customer_inquiry" ? [f.name, hash(f.bytes)] : [f.name, hash(f.bytes), f.documentType]),
      }),
    );
    const ownerId = ownerColumn ? ctx?.accountId ?? null : null;
    const old = one(
      ownerColumn ? "SELECT * FROM inquiry WHERE request_id=? AND owner_id IS ?" : "SELECT * FROM inquiry WHERE request_id=?",
      ownerColumn ? [input.requestId, ownerId] : [input.requestId],
    );
    if (old) {
      if (old.payload_hash !== digest)
        throw Object.assign(new Error("requestId已用于其他内容"), {
          status: 409,
        });
      return detail(old.id);
    }
    const id = randomUUID(),
      at = now();
    db.run("BEGIN");
    try {
      db.run(
        ownerColumn
          ? "INSERT INTO inquiry(id,request_id,payload_hash,source,operator,title,status,created_at,updated_at,issues,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
          : "INSERT INTO inquiry(id,request_id,payload_hash,source,operator,title,status,created_at,updated_at,issues) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ownerColumn
          ? [id, input.requestId, digest, source, operator, title, "processing", at, at, "[]", ownerId]
          : [id, input.requestId, digest, source, operator, title, "processing", at, at, "[]"],
      );
      for(const file of files) file.id=storeOriginal(file,id,null,source,at);
      db.run('COMMIT');
      persist();
    } catch(error) {
      try { db.run('ROLLBACK'); } catch {}
      db.run('DELETE FROM file WHERE inquiry_id=?',[id]);
      db.run('DELETE FROM inquiry WHERE id=?',[id]);
      throw error;
    }
    onProgress(1, detail(id));
    return process(id,files,source,at,onProgress);
  }
  async function process(id,files,source,at,onProgress=()=>{},reuseAttachments=false) {
    const oldAttachments = reuseAttachments ? rows(db,'SELECT * FROM file WHERE inquiry_id=? AND parent_id IS NOT NULL ORDER BY rowid',[id]) : [];
    const seenFiles = new Set();
    const issues = [],
      chunks = [];
    let count = 0,
      total = 0;
    async function add(file, parentId = null, depth = 0, ordinal = 0) {
      if (
        ++count > 60 ||
        depth > 3 ||
        (total += file.bytes.length) > 32_000_000
      )
        throw new Error("邮件附件展开超过数量、层级或大小限制");
      const oldAttachment = oldAttachments.filter(item=>item.parent_id===parentId)[ordinal];
      const previous = file.id || (oldAttachment?.name===file.name && oldAttachment.sha256===hash(file.bytes) ? oldAttachment.id : null);
      const fid = previous || storeOriginal(file,id,parentId,source,at);
      seenFiles.add(fid);
      db.run("UPDATE file SET status='processing',error=NULL,parser_version=? WHERE id=?",[INTAKE_PARSER_VERSION,fid]);
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
          const cid = one('SELECT id FROM file_content WHERE file_id=? AND ordinal=?',[fid,ordinal])?.id || randomUUID();
          const chunk = { ...c, id: cid, fileId: fid };
          db.run("INSERT INTO file_content VALUES(?,?,?,?,?,?,?) ON CONFLICT(file_id,ordinal) DO UPDATE SET locator=excluded.locator,format=excluded.format,text=excluded.text,cells=excluded.cells", [
            cid,
            fid,
            ordinal,
            JSON.stringify(c.locator),
            c.format,
            c.text,
            c.cells ? JSON.stringify(c.cells) : null,
          ]);
          if (!file.documentType || file.documentType === "customer_inquiry") chunks.push(chunk);
        }
        db.run('DELETE FROM file_content WHERE file_id=? AND ordinal>=?',[fid,extracted.length]);
        db.run("UPDATE file SET status=? WHERE id=?", [state, fid]);
        if (file.documentType && file.documentType !== "customer_inquiry") issues.push(`${file.name}：该资料已保存，需单独分类处理后使用`);
        if (state === "needs_ocr")
          issues.push(
            `${file.name}：部分页面无文本，待配置OCR或补充可读取材料`,
          );
        if (parsed.unsupported)
          issues.push(`${file.name}：暂不支持此文件类型，原件已保存`);
        for (const [index,child] of parsed.children.entries()) await add({ ...child, documentType: file.documentType || "customer_inquiry" }, fid, depth + 1,index);
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
      for(const attachment of oldAttachments.filter(file=>!seenFiles.has(file.id))){
        const message=`${attachment.name}：重新解析未复现该附件，请核对原件`;
        db.run("UPDATE file SET status='unsupported',error=? WHERE id=?",[message,attachment.id]);
        issues.push(message);
      }
      onProgress(2, detail(id));
      const schema = schemaFor(id);
      const result = extractStructured(chunks, schema);
      let extra = { lines: [], issues: [] };
      try {
        extra = await semantic(result.unresolved, modelConfig, {knownLines:result.lines, schema});
      } catch (e) {
        extra.issues = [e.message];
      }
      issues.push(...extra.issues);
      const semanticResult = mergeSemanticLines(result.lines,extra.lines,schema);
      issues.push(...semanticResult.issues);
      const requirements=[...result.requirements,...(extra.requirements || [])].filter(requirement=>{
        if (requirement.scope!=='all') return true;
        const chunk=chunks.find(chunk=>chunk.id===requirement.contentId);
        const valid=chunk&&hasGlobalScope(chunk,semanticResult.lines);
        if (!valid) issues.push('共同要求适用范围需确认，请核对原文');
        return valid;
      });
      const merged=mergeExtractedRequirements(semanticResult.lines,requirements,chunks,schema);
      const pending=result.unresolved.filter(chunk=>{
        if(requirements.some(requirement=>requirement.contentId===chunk.id&&!merged.appliedRequirements.has(requirement)))return true;
        const values=[...semanticResult.lines.filter(line=>line.contentId===chunk.id).flatMap(line=>Object.values(line.rawFields || {})),...requirements.filter(requirement=>requirement.contentId===chunk.id&&merged.appliedRequirements.has(requirement)).flatMap(requirement=>[requirement.value,...(requirement.scope==='part'?[requirement.partNumber]:[])])];
        if (!values.length) return /[0-9]|要求|证书|交期|有效|截止|FAA|EASA|certificate|delivery|condition|MOQ/i.test(chunk.text);
        return hasUnmappedText(chunk.text,Object.fromEntries(values.map((value,index)=>[index,value])));
      });
      if (pending.length)
        issues.push(
          `${pending.length}处原文包含未落实到物料行的要求或数据，需核对原文`,
        );
      const all = merged.lines;
      db.run("BEGIN");
      try {
        db.run('UPDATE inquiry SET requirements=? WHERE id=?',[JSON.stringify(requirements),id]);
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
      db.run('UPDATE inquiry SET issues=?,updated_at=? WHERE id=?',[JSON.stringify(issues),now(),id]);
      persist();
      onProgress(3, detail(id));
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
      issues.push('处理失败：'+String(e.message).slice(0, 300));
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
  function recovery(id, ctx) {
    const batch = detail(id, ctx);
    if (!batch) throw Object.assign(new Error('询价不存在'), {status: 404});
    const originals = rows(db, 'SELECT * FROM file WHERE inquiry_id=? AND parent_id IS NULL AND source=? ORDER BY rowid', [id, batch.source]);
    const digest = hash(JSON.stringify({
      source: batch.source, operator: batch.operator, title: batch.title,
      files: originals.map(file => ['customer_inquiry', 'unknown'].includes(file.document_type)
        ? [file.name, hash(file.raw)] : [file.name, hash(file.raw), file.document_type]),
    }));
    const complete = originals.length > 0 && digest === batch.payload_hash
      && originals.every(file => hash(file.raw) === file.sha256);
    const reason = !['interrupted', 'failed'].includes(batch.status) ? '当前材料无需恢复处理'
      : !complete ? '已保存原件不完整，请补充原始上传材料' : '';
    return {fingerprint: hash(JSON.stringify(batch)), canRecover: !reason, reason};
  }
  async function recover(id, input, {background = false} = {}, ctx) {
    assertWrite(ctx, id);
    if (!input || typeof input.requestId !== 'string' || input.requestId.length < 8
      || input.requestId.length > 120 || typeof input.fingerprint !== 'string'
      || typeof input.operator !== 'string' || !input.operator.trim() || input.operator.length > 100) {
      throw Object.assign(new Error('恢复请求无效'), {status: 400});
    }
    const prior = rows(db, "SELECT detail,operator FROM review_log WHERE task=? AND action='恢复材料处理' ORDER BY id DESC", [id])
      .find(row => JSON.parse(row.detail).requestId === input.requestId);
    if (prior) {
      if (JSON.parse(prior.detail).fingerprint !== input.fingerprint || prior.operator !== input.operator.trim()) {
        throw Object.assign(new Error('requestId已用于其他恢复请求'), {status: 409});
      }
      persist();
      return detail(id);
    }
    const check = recovery(id);
    if (!check.canRecover || check.fingerprint !== input.fingerprint) {
      throw Object.assign(new Error(check.reason || '材料已变化，请重新载入后恢复'), {status: 409});
    }
    const batch = detail(id);
    const audit = {
      requestId: input.requestId, fingerprint: input.fingerprint, issues: batch.issues,
      fileIds: batch.files.map(file => file.id),
      lineVersions: batch.lines.map(line => ({id: line.id, version: line.version})),
      mode: batch.lines.length ? 'resume_saved_lines' : 'reprocess_originals',
    };
    db.run('BEGIN');
    let logId;
    try {
      db.run("UPDATE inquiry SET status='processing',issues='[]',updated_at=? WHERE id=?", [now(), id]);
      db.run("INSERT INTO review_log(task,action,detail,operator,created_at) VALUES(?,?,?,?,?)",
        [id, '恢复材料处理', JSON.stringify(audit), input.operator.trim(), now()]);
      logId = one('SELECT last_insert_rowid() id').id;
      db.run('COMMIT');
      persist();
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      db.run('UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?', [batch.status, JSON.stringify(batch.issues), batch.updated_at, id]);
      if (logId) db.run('DELETE FROM review_log WHERE id=?', [logId]);
      throw error;
    }
    const failRecovery = error => {
      const current = detail(id);
      const issues = [...new Set([...current.issues, '处理失败：'+String(error.message).slice(0,300)])];
      db.run("UPDATE inquiry SET status='failed',issues=?,updated_at=? WHERE id=?", [JSON.stringify(issues),now(),id]);
      // Keep memory retryable if the filesystem remains unavailable. Replay retries persistence.
      try { persist(); } catch {}
      return detail(id);
    };
    if (batch.lines.length) {
      try {
        const issues = batch.issues.filter(issue => issue !== '服务重启中断了处理，已保留已接收文件' && !issue.startsWith('处理失败：'));
        db.run('UPDATE inquiry SET issues=? WHERE id=?', [JSON.stringify(issues), id]);
        updateStatus(id);
        persist();
        return detail(id);
      } catch(error) { return failRecovery(error); }
    }
    const originals = rows(db, 'SELECT * FROM file WHERE inquiry_id=? AND parent_id IS NULL AND source=? ORDER BY rowid', [id, batch.source]);
    const files = originals.map(file => ({
      id: file.id, name: file.name, bytes: Buffer.from(file.raw), mime: file.mime_type,
      documentType: file.document_type === 'unknown' ? 'customer_inquiry' : file.document_type,
    }));
    const work = process(id, files, batch.source, now(), () => {}, true).catch(failRecovery);
    if (background) {
      // Processing persists terminal status. HTTP clients can reconnect through polling.
      void work.catch(() => {});
      return detail(id);
    }
    return work;
  }
  function refresh(id, ctx) {
    assertNotProcessing(id);
    assertWrite(ctx, id);
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
    const current = one('SELECT issues FROM inquiry WHERE id=?', [id]);
    db.run('UPDATE inquiry SET issues=? WHERE id=?', [JSON.stringify(JSON.parse(current.issues).filter(issue=>issue!=='标准字段已更新，请刷新依据')),id]);
    updateStatus(id);
    persist();
    return detail(id);
  }
  function applyInquiryRequirements(batchId, line, lineId=null) {
    const inquiry=detail(batchId);
    const chunks=inquiry.contents;
    let requirements=inquiry.requirements;
    if (!requirements.length) {
      // Legacy part-scoped provenance belongs to its original demand; only global requirements inherit onto a new line.
      requirements=inquiry.lines.flatMap(existing=>Object.entries(existing.fieldSources || {}).flatMap(([field,origin])=>[...(origin.sources || []),...(origin.previousSources || []),...(origin.rejectedSources || [])].filter(source=>source.scope==='all'&&source.value).map(source=>({contentId:source.contentId,field,value:source.value,scope:'all'}))));
      requirements=requirements.filter(requirement=>{
        const chunk=chunks.find(content=>content.id===requirement.contentId);
        return chunk&&hasGlobalScope(chunk,inquiry.lines);
      });
    }
    const others=inquiry.lines.filter(existing=>existing.id!==lineId);
    return mergeExtractedRequirements([...others,line],requirements,chunks,schemaFor(batchId)).lines.at(-1);
  }
  function addLine(
    batchId,
    { partNumber, quantity, uom, description = "", operator = "本机用户" },
    ctx,
  ) {
    assertNotProcessing(batchId);
    assertWrite(ctx, batchId);
    if (!one("SELECT id FROM inquiry WHERE id=?", [batchId]))
      throw Object.assign(new Error("询价不存在"), { status: 404 });
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
    const fields = applyInquiryRequirements(batchId,normalizeLine({
      partNumber: partNumber.trim(),
      quantity,
      uom: uom.trim(),
      description,
      condition: null,
      issues: [],
      contentId: cid,
      method: "manual",
    }, { requireCondition: conditionRequired(schemaFor(batchId)) }));
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
      db.run("UPDATE file SET document_type=? WHERE id=?", ["customer_inquiry", fid]);
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
    { version, patch, operator = "本机用户", confirmFields = [], confirmationReason = "" },
    ctx,
  ) {
    assertNotProcessing(batchId);
    assertWrite(ctx, batchId);
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
        "needByDate",
        "quoteDeadline",
        "mpn",
        "priority",
        "manualPn",
        "productScope",
        "rfqId",
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
    }
    if(!Array.isArray(confirmFields)||confirmFields.length>allowed.length||new Set(confirmFields).size!==confirmFields.length||confirmFields.some(key=>!allowed.includes(key)||!fieldConflictIssues(fields,key).length))throw Object.assign(new Error('确认字段不存在待处理的提取冲突'),{status:400});
    if(confirmFields.length&&(typeof confirmationReason!=='string'||!confirmationReason.trim()||confirmationReason.length>1000))throw Object.assign(new Error('请填写确认取值的依据'),{status:400});
    const effective=normalizeLine({...fields,...patch},{requireCondition:conditionRequired(schemaFor(batchId))});
    patch=Object.fromEntries(Object.entries(patch).filter(([key])=>String(effective[key] ?? '')!==String(fields[key] ?? '')).map(([key])=>[key,effective[key]]));
    if (!Object.keys(patch).length&&!confirmFields.length) return detail(batchId);
    const beforeFields=structuredClone(fields);
    const reviewed=[...new Set([...Object.keys(patch),...confirmFields])];
    const resolvedIssues=new Set(reviewed.flatMap(key=>fieldConflictIssues(fields,key)));
    Object.assign(fields,patch);
    fields.issues=(fields.issues||[]).filter(issue=>!resolvedIssues.has(issue));
    const fieldSources={...fields.fieldSources};
    for(const key of reviewed){
      const origin=beforeFields.fieldSources?.[key]||{};
      const {previousSources=[],sources,rejectedSources=[],confirmation,...direct}=origin;
      fieldSources[key]={contentId:null,originalContentId:old.content_id,method:'manual',operator:String(operator).slice(0,100),value:fields[key],previousSources:[...previousSources,...(sources||[{...direct,value:beforeFields[key]}]),...rejectedSources],
        ...(confirmFields.includes(key)?{confirmation:{value:fields[key],reason:confirmationReason.trim(),operator:String(operator).slice(0,100),at:now(),version:old.version,issues:fieldConflictIssues(beforeFields,key)}}:{})};
    }
    const normalized=normalizeLine({...fields,fieldSources},{requireCondition:conditionRequired(schemaFor(batchId))});
    Object.assign(fields, normalized);
    if ('partNumber' in patch) {
      for(const [key,origin] of Object.entries(fields.fieldSources || {})) {
        if(origin.sources?.some(source=>source.scope==='part'&&normalizePartNumber(source.partNumber)!==fields.partNumber)) fields.issues.push(`共同要求的${extractionFieldLabel(key)}适用范围需确认`);
      }
      Object.assign(fields,applyInquiryRequirements(batchId,fields,lineId));
    }
    const issues = [...fields.issues];
    fields.issues = issues;
    const oldInquiry=one('SELECT status,issues,updated_at FROM inquiry WHERE id=?',[batchId]);
    const oldEvidence=rows(db,'SELECT * FROM evidence WHERE line_id=?',[lineId]);
    const revisionId=randomUUID();
    db.run("BEGIN");
    try {
      db.run("INSERT INTO line_revision VALUES(?,?,?,?,?,?)", [
        revisionId,
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
      updateStatus(batchId);
      persist();
    } catch (e) {
      try{db.run("ROLLBACK");}catch{}
      db.run('UPDATE inquiry_line SET fields=?,issues=?,method=?,version=?,part_number=? WHERE id=?',[old.fields,old.issues,old.method,old.version,old.part_number,lineId]);
      db.run('DELETE FROM line_revision WHERE id=?',[revisionId]);
      db.run('DELETE FROM evidence WHERE line_id=?',[lineId]);
      for(const evidence of oldEvidence){
        db.run('DELETE FROM evidence_history WHERE id=?',[evidence.id]);
        db.run('INSERT INTO evidence VALUES(?,?,?,?,?,?)',[evidence.id,evidence.line_id,evidence.source,evidence.source_key,evidence.snapshot,evidence.matched_at]);
      }
      db.run('UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?',[oldInquiry.status,oldInquiry.issues,oldInquiry.updated_at,batchId]);
      throw e;
    }
    return detail(batchId);
  }
  return {
    create,
    recovery,
    recover,
    list,
    detail,
    refresh,
    updateLine,
    addLine,
    setOwner(id, ownerId, {claim=false}={}) {
      assertNotProcessing(id);
      db.run('BEGIN');
      try {
        db.run('UPDATE inquiry SET owner_id=?,updated_at=? WHERE id=?'+(claim?' AND owner_id IS NULL':''),[ownerId,now(),id]);
        if(!db.getRowsModified())throw Object.assign(new Error('该询价已被认领'),{status:409});
        for(const line of rows(db,'SELECT id,fields FROM inquiry_line WHERE inquiry_id=?',[id])) {
          matchEvidence(line.id,JSON.parse(line.fields).partNumber);
        }
        db.run('COMMIT');
      } catch(error) {db.run('ROLLBACK');throw error;}
      updateStatus(id);
      persist();
      return detail(id);
    },
    ownerOf(id) {
      if (!ownerColumn) return undefined;
      return one("SELECT owner_id FROM inquiry WHERE id=?", [id])?.owner_id;
    },
    rawFile(id) {
      return one("SELECT raw,mime_type,name FROM file WHERE id=?", [id]);
    },
    prices(ctx) {
      const join = priceAccountColumn && accountTable;
      const scoped = priceAccountColumn && ctx && ctx.role !== "master";
      const sql =
        `SELECT p.*${join ? ",a.display_name account_name" : ""} FROM price_resource p${join ? " LEFT JOIN account a ON a.id=p.account_id" : ""}` +
        (scoped ? " WHERE p.account_id=?" : "") +
        " ORDER BY p.id";
      return rows(db, sql, scoped ? [ctx.accountId] : []).map((p) => ({
        ...JSON.parse(p.data),
        ...(priceAccountColumn ? { account_id: p.account_id } : {}),
        ...(join ? { account_name: p.account_name } : {}),
      }));
    },
  };
}
