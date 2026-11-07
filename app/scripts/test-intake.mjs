import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import ExcelJS from "exceljs";
import {
  createIntakeService,
  initIntake,
  seedPrices,
  rows,
} from "../server/intake.mjs";
import { extractSemantic } from "../server/intake-extract.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {fileURLToPath} from 'node:url';
const SQL = await initSqlJs();
let db = new SQL.Database();
db.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
db.run("INSERT INTO inventory VALUES('PN-0001','EA',5,100,'CNY','FN')");
initIntake(db);
seedPrices(db, [
  {
    id: "price-test",
    partNumber: "PN-0001",
    unitPrice: 90,
    currency: "CNY",
    moq: 2,
    validUntil: "2027-01-01",
  },
]);
let saved;
const persist = () => {
  saved = db.export();
};
let svc = createIntakeService(db, persist, {});
const csv =
  '件号,描述,数量,单位,件状\nPN-0001,"FILTER, AIR",2,EA,FN\nPN-MISSING,unknown,,EA,\n';
const attachment = Buffer.from(csv).toString("base64");
const eml = `From: buyer@example.test\r\nTo: quote@example.test\r\nSubject: =?UTF-8?B?${Buffer.from("真实上传测试").toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPlease quote attached.\r\n--test\r\nContent-Type: text/csv; name="parts.csv"\r\nContent-Disposition: attachment; filename="parts.csv"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment}\r\n--test--\r\n`;
const wb = new ExcelJS.Workbook();
for (const name of ["第一张", "第二张"]) {
  const sh = wb.addWorksheet(name);
  sh.addRow(["Part Number", "Quantity", "Unit", "Condition"]);
  sh.addRow(["PN-0001", name === "第一张" ? 1 : 3, "EA", "FN"]);
}
const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
const input = {
  requestId: "test-batch-01",
  source: "manual_upload",
  operator: "tester",
  files: [
    { name: "request.eml", base64: Buffer.from(eml).toString("base64") },
    { name: "two-sheets.xlsx", base64: xlsx.toString("base64") },
  ],
};
const b = await svc.create(input);
assert.equal(b.files.length, 3);
assert.equal(b.files.filter((f) => f.parent_id).length, 1);
assert.equal(b.lines.length, 4);
assert.equal(b.files[0].metadata.subject, "真实上传测试");
assert.equal(b.lines.find((l) => l.partNumber === "PN-MISSING").quantity, null);
assert.ok(
  b.lines
    .filter((l) => l.partNumber === "PN-0001")
    .every((l) => l.evidence.length === 2),
);
assert.ok(
  b.contents.some((c) => c.locator.sheet === "第二张" && c.locator.row === 2),
);
assert.equal(Buffer.from(svc.rawFile(b.files[0].id).raw).toString(), eml);
assert.equal((await svc.create(input)).id, b.id);
assert.equal(svc.list().length, 1);
await assert.rejects(
  () => svc.create({ ...input, title: "different" }),
  /requestId/,
);
const fresh = await svc.create({ ...input, requestId: "test-batch-02" });
assert.notEqual(fresh.id, b.id);
const bad = await svc.create({
  requestId: "test-batch-bad",
  files: [
    { name: "bad.pdf", base64: Buffer.from("broken pdf").toString("base64") },
    { name: "good.csv", base64: attachment },
  ],
});
assert.ok(bad.files.some((f) => f.status === "failed"));
assert.equal(bad.lines.length, 2);
assert.equal(bad.status, "needs_input");
const unsupported = await svc.create({
  requestId: "unsupported-01",
  files: [{ name: "old.xls", base64: Buffer.from("old").toString("base64") }],
});
assert.equal(unsupported.files[0].status, "unsupported");
assert.equal(unsupported.status, "needs_input");
const semantics = await extractSemantic(
  [{ id: "c1", text: "PN-0001 needs 2 EA", locator: { line: 1 } }],
  { apiKey: "test", baseURL: "https://example.test/v1", model: "test" },
  {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  { contentId: "c1", partNumber: "INVENTED", quantity: 2 },
                  {
                    contentId: "c1",
                    partNumber: "PN-0001",
                    quantity: 999,
                    uom: "FT",
                  },
                  { contentId: "fake", partNumber: "PN-0001", quantity: 2 },
                ],
              }),
            },
          },
        ],
      }),
    }),
  },
);
assert.equal(semantics.lines.length, 1);
assert.equal(semantics.lines[0].quantity, null);
assert.equal(semantics.lines[0].uom, null);
db.run("UPDATE inventory SET lastPurchasePrice=120 WHERE partNumber='PN-0001'");
assert.equal(
  b.lines[0].evidence.find((e) => e.source === "inventory").snapshot
    .lastPurchasePrice,
  100,
);
assert.equal(
  svc.refresh(b.id).lines[0].evidence.find((e) => e.source === "inventory")
    .snapshot.lastPurchasePrice,
  120,
);
persist();
db.close();
db = new SQL.Database(saved);
initIntake(db);
svc = createIntakeService(db, persist, {});
assert.equal(svc.detail(b.id).lines.length, 4);
assert.equal(svc.detail(b.id).files.length, 3);
console.log(
  "PASS: EML MIME正文及附件、CSV引号、多工作表、原件回读、缺失值、两类DB依据、批次隔离、幂等冲突、部分失败、来源验证、依据刷新、重开恢复",
);
// Real HTTP route and on-disk persistence, isolated from user's inventory DB and model credentials.
const temp = mkdtempSync(join(tmpdir(), "rfq-intake-"));
const path = join(temp, "test.sqlite");
const port = 14304;
async function start() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/index.mjs",import.meta.url))], {
    env: {
      ...process.env,
      RFQ_DB_PATH: path,
      RFQ_PORT: String(port),
      RFQ_INTAKE_MODEL: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error("test server startup timeout " + log);
}
let child;
try {
  child = await start();
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + "/api/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "http-test-01",
      operator: "HTTP tester",
      files: [{ name: "parts.csv", base64: attachment }],
    }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.lines.length, 2);
  const raw = await fetch(
    base + "/api/files/" + data.files[0].id + "/raw",
  );
  assert.equal(await raw.text(), csv);
  assert.ok(
    (await (await fetch(base + "/api/price-resources")).json()).prices.length >
      0,
  );
  child.kill();
  await once(child, "exit");
  child = await start();
  assert.equal(
    (await (await fetch(base + "/api/inquiries/" + data.id)).json()).lines
      .length,
    2,
  );
  console.log("PASS: HTTP接收/原件下载/统一价格接口及服务重启持久化");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  rmSync(temp, { recursive: true, force: true });
}
function pdf(text) {
  const stream = text ? `BT /F1 10 Tf 20 100 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
const textPdf = await svc.create({
  requestId: "pdf-text-01",
  files: [
    {
      name: "text.pdf",
      base64: pdf("PN: PN-0001 Quantity: 2 Unit: EA Condition: FN").toString(
        "base64",
      ),
    },
  ],
});
assert.equal(textPdf.lines.length, 1);
assert.equal(textPdf.lines[0].partNumber, "PN-0001");
assert.equal(textPdf.contents[0].locator.page, 1);
const scan = await svc.create({
  requestId: "pdf-scan-01",
  files: [{ name: "scan.pdf", base64: pdf("").toString("base64") }],
});
assert.equal(scan.files[0].status, "needs_ocr");
assert.equal(scan.lines.length, 0);
const edited = svc.updateLine(b.id, b.lines[0].id, {
  version: 1,
  patch: { quantity: 4, partNumber: "PN-MISSING" },
  operator: "editor",
});
assert.equal(edited.lines[0].quantity, 4);
assert.equal(edited.lines[0].version, 2);
assert.equal(edited.lines[0].evidence.length, 0);
assert.equal(
  rows(db, "SELECT * FROM line_revision WHERE line_id=?", [b.lines[0].id])
    .length,
  1,
);
assert.throws(
  () =>
    svc.updateLine(b.id, b.lines[0].id, { version: 1, patch: { quantity: 5 } }),
  /已修改/,
);
console.log(
  "PASS: PDF文本层及页码、扫描页待OCR、人工修改写库及修订留存、旧版本冲突、修改后依据重查",
);
const added = svc.addLine(b.id, {
  partNumber: "PN-0001",
  quantity: 1,
  uom: "EA",
  operator: "manual tester",
});
assert.equal(added.lines.length, 5);
assert.equal(added.lines.at(-1).condition, null);
assert.equal(added.lines.at(-1).method, "manual");
assert.equal(added.files.at(-1).source, "manual_entry");
assert.equal(
  svc.list({ operator: "tester", source: "manual_upload" }).length,
  2,
);
assert.equal(svc.list({ operator: "unrelated-user" }).length, 0);
console.log("PASS: 人工新增物料纳入文件/内容/需求及依据、批次来源与执行人筛选");

const noteSvc = createIntakeService(db, persist, {
  semantic: async () => ({ lines: [], issues: [] }),
});
const withNote = await noteSvc.create({
  requestId: "unhandled-requirement-01",
  files: [
    {
      name: "data.csv",
      base64: Buffer.from(
        "PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN",
      ).toString("base64"),
    },
    {
      name: "note.txt",
      base64: Buffer.from("全部物料要求 FAA 证书，交期 2026-12-01").toString(
        "base64",
      ),
    },
  ],
});
assert.equal(withNote.status, "needs_input");
assert.ok(withNote.issues.some((i) => i.includes("未落实到物料行")));
console.log("PASS: 未应用到物料行的全局证书/交期要求不静默放行");
// Migrate a populated pre-rename database, preserving IDs, content, source, and FKs.
const legacy = new SQL.Database(db.export());
const beforeCount=rows(legacy,'SELECT count(*) n FROM inquiry')[0].n;
const renames={inquiry:'rfq_batch',file:'rfq_file',file_content:'rfq_content',inquiry_line:'rfq_line',evidence:'rfq_evidence',evidence_history:'rfq_evidence_history',line_revision:'rfq_line_revision',schema_migration:'rfq_migration'};
for(const [current,old] of Object.entries(renames))legacy.run(`ALTER TABLE "${current}" RENAME TO "${old}"`);
for(const name of ['rfq_file','rfq_line'])legacy.run(`ALTER TABLE "${name}" RENAME COLUMN inquiry_id TO batch_id`);
initIntake(legacy);
assert.equal(rows(legacy,'SELECT count(*) n FROM inquiry')[0].n,beforeCount);
assert.ok(rows(legacy,'SELECT id FROM inquiry WHERE id=?',[b.id]).length);
assert.equal(rows(legacy,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rfq_%'").length,0);
assert.equal(rows(legacy,'PRAGMA foreign_key_check').length,0);
assert.ok(rows(legacy,'SELECT name FROM pragma_table_info(?)',['file']).some(c=>c.name==='inquiry_id'));
initIntake(legacy);assert.equal(rows(legacy,'SELECT count(*) n FROM inquiry')[0].n,beforeCount);
legacy.run('CREATE TABLE rfq_batch(id TEXT)');assert.throws(()=>initIntake(legacy),/同时存在/);assert.equal(rows(legacy,'SELECT count(*) n FROM inquiry')[0].n,beforeCount);legacy.close();
console.log('PASS: 带数据旧表迁移、去除前缀、询价外键改名、重复迁移与名称冲突保护');
