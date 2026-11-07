import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";
import ExcelJS from "exceljs";
import { initIntake, createIntakeService, rows } from "../server/intake.mjs";
import {
  createSupplierImportStore,
  extractSupplierRows,
} from "../server/supplier-import.mjs";
import { buildDraft } from "../server/agent.mjs";
import { businessToday, evaluateQuoteLine } from "../shared/rfq-rules.mjs";
import { quoteSourceFingerprint } from "../server/quote-draft.mjs";
const SQL = await initSqlJs(),
  db = new SQL.Database();
db.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
initIntake(db);
let durable,
  failWrite = false;
const persist = () => {
  if (failWrite) throw new Error("disk failed");
  durable = db.export();
};
const intake = createIntakeService(db, persist, {}),
  imports = createSupplierImportStore(db, persist, (id) => intake.detail(id));
const date = businessToday(),
  future = "2099-12-31";
const inquiry = await intake.create({
  source: "manual_upload",
  requestId: randomUUID(),
  operator: "QA",
  files: [
    {
      name: "inquiry.csv",
      mime: "text/csv",
      base64: Buffer.from("件号,数量,单位,件状\nAN3-5A,10,EA,FN").toString(
        "base64",
      ),
    },
  ],
});
const csv = `件号,供应商,单价,币种,单位,件状,起订量,交期天数,生效日期,有效期,证书,税基,备注\nan3-5a,QA Supplier,20.50,CNY,Each,fn,1,2,${date},${future},EASA Form 1,未税,报价依据测试\n`;
const upload = {
  requestId: randomUUID(),
  operator: "QA",
  name: "supplier.csv",
  mime: "text/csv",
  base64: Buffer.from(csv).toString("base64"),
};
const originalFingerprint = quoteSourceFingerprint(intake.detail(inquiry.id));
let preview = await imports.create(inquiry.id, upload);
assert.equal(preview.status, "needs_review");
assert.equal(preview.rows.length, 1);
assert.equal(preview.issues.length, 0);
assert.equal(preview.rows[0].values.unitPrice, 20.5);
assert.equal(preview.rows[0].values.partNumber, "AN3-5A");
assert.equal(preview.rows[0].values.authorized, false);
assert.equal(
  rows(db, "SELECT * FROM price_resource").length,
  0,
  "unconfirmed rows cannot enter matching",
);
assert.equal(
  quoteSourceFingerprint(intake.detail(inquiry.id)),
  originalFingerprint,
  "unconfirmed supplier originals do not invalidate customer demand",
);
assert.deepEqual(
  Buffer.from(intake.rawFile(preview.fileId).raw),
  Buffer.from(csv),
);
assert.equal(
  intake.detail(inquiry.id).files.find((file) => file.id === preview.fileId)
    .document_type,
  "supplier_quote",
);
assert.equal(
  (await imports.create(inquiry.id, upload)).id,
  preview.id,
  "response-loss retries do not duplicate originals",
);
await assert.rejects(
  () => imports.create(inquiry.id, { ...upload, name: "other.csv" }),
  (error) => error.status === 409,
);
assert.throws(
  () => imports.confirm("other", preview.id, {}),
  (error) => error.status === 404,
);
const confirm = {
  version: preview.version,
  operator: "QA",
  rows: preview.rows.map((row) => ({
    id: row.id,
    ...row.values,
    authorized: true,
  })),
};
assert.throws(
  () =>
    imports.confirm(inquiry.id, preview.id, {
      ...confirm,
      rows: [{ ...confirm.rows[0], id: randomUUID() }],
    }),
  (error) => error.status === 400,
);
failWrite = true;
assert.throws(
  () => imports.confirm(inquiry.id, preview.id, confirm),
  /disk failed/,
);
failWrite = false;
assert.equal(rows(db, "SELECT * FROM price_resource").length, 0);
assert.equal(imports.read(inquiry.id, preview.id).status, "needs_review");
preview = imports.confirm(inquiry.id, preview.id, confirm);
assert.equal(preview.status, "confirmed");
assert.equal(
  imports.confirm(inquiry.id, preview.id, confirm).status,
  "confirmed",
);
assert.equal(rows(db, "SELECT * FROM price_resource").length, 1);
assert.throws(
  () =>
    imports.confirm(inquiry.id, preview.id, {
      ...confirm,
      operator: "Changed",
    }),
  (error) => error.status === 409,
);
const refreshed = intake.refresh(inquiry.id),
  line = refreshed.lines[0];
assert.equal(line.evidence.length, 1);
const resource = line.evidence[0];
assert.equal(resource.snapshot.sourceDocument.fileId, preview.fileId);
assert.equal(resource.snapshot.sourceDocument.locator.row, 2);
assert.equal(resource.snapshot.sourceDocument.operator, "QA");
assert.equal(resource.snapshot.dataSource, "supplier_upload");
assert.equal(
  evaluateQuoteLine(line, line.evidence, { freightDays: 0 }).selected?.id,
  resource.id,
);
const result = buildDraft(
  {
    instruction: "生成报价草稿",
    lines: [{ ...line, key: "test", selectedBasisId: resource.id }],
    policy: { markupRate: 0.25, freightDays: 0 },
  },
  [],
  { test: line.evidence },
);
assert.equal(result.lines[0].suggestedPrice, 25.63);
assert.equal(result.lines[0].basisId, resource.id);
assert.equal(result.lines[0].basisLabel, "QA Supplier");
assert.notEqual(quoteSourceFingerprint(refreshed), originalFingerprint);
const unknown = await imports.create(inquiry.id, {
  ...upload,
  requestId: randomUUID(),
  name: "unknown.csv",
  base64: Buffer.from("件号,单价,未映射要求\nA,100,必须双证书").toString(
    "base64",
  ),
});
assert.ok(unknown.issues.some((issue) => issue.includes("未映射")));
assert.throws(
  () =>
    imports.confirm(inquiry.id, unknown.id, {
      version: unknown.version,
      operator: "QA",
      rows: unknown.rows.map((row) => ({
        id: row.id,
        ...row.values,
        supplierName: "QA",
      })),
    }),
  (error) => error.status === 409,
);
const duplicate = extractSupplierRows([
  {
    id: "header",
    locator: { row: 1 },
    cells: ["件号", "单价", "price"],
    text: "件号 单价 price",
  },
  {
    id: "data",
    locator: { row: 2 },
    cells: ["A", "10", "20"],
    text: "A 10 20",
  },
]);
assert.ok(duplicate.issues.some((issue) => issue.includes("重复")));
assert.equal(duplicate.rows.length, 0);
const reopened = new SQL.Database(durable);
assert.equal(
  rows(reopened, "SELECT * FROM resource_import WHERE status=?", ["confirmed"])
    .length,
  1,
);
reopened.close();
db.close();
console.log(
  "PASS: supplier originals, typed role, preview/confirmation separation, source trace, idempotent import/confirmation, CAS, persistence rollback, exact matching/pricing and unknown-column blocking",
);

// The same decoder handles multiple Excel sheets while preserving their row locations.
const excelDb = new SQL.Database();
excelDb.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
initIntake(excelDb);
const excelIntake = createIntakeService(excelDb, () => {}, {}),
  excelImports = createSupplierImportStore(
    excelDb,
    () => {},
    (id) => excelIntake.detail(id),
  );
const excelInquiry = await excelIntake.create({
  source: "manual_upload",
  requestId: randomUUID(),
  operator: "QA",
  files: [
    {
      name: "inquiry.csv",
      mime: "text/csv",
      base64: Buffer.from("件号,数量,单位,件状\nAN3-5A,10,EA,FN").toString(
        "base64",
      ),
    },
  ],
});
const workbook = new ExcelJS.Workbook();
for (const name of ["供应商A", "供应商B"]) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([
    "Part Number",
    "Supplier",
    "Unit Price",
    "Currency",
    "Unit",
    "Condition",
    "MOQ",
    "Lead Days",
  ]);
  sheet.addRow(["AN3-5A", name, 22, "CNY", "EA", "FN", 1, 0]);
}
const excelPreview = await excelImports.create(excelInquiry.id, {
  requestId: randomUUID(),
  operator: "QA",
  name: "supplier.xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"),
});
assert.equal(excelPreview.rows.length, 2);
assert.equal(excelPreview.issues.length, 0);
assert.equal(excelPreview.rows[1].locator.sheet, "供应商B");
assert.equal(excelPreview.rows[1].values.leadDays, 0);
excelDb.close();
console.log(
  "PASS: Excel multi-sheet supplier quotes retain exact sheet/row provenance and zero-day delivery",
);

// Recovery marks both the import and its original file terminal after an interrupted process.
const recoveryDb = new SQL.Database(durable);
const interrupted = rows(
  recoveryDb,
  "SELECT id,file_id FROM resource_import WHERE status='needs_review' LIMIT 1",
)[0];
assert.ok(interrupted);
recoveryDb.run("UPDATE resource_import SET status='processing' WHERE id=?", [
  interrupted.id,
]);
recoveryDb.run("UPDATE file SET status='processing' WHERE id=?", [
  interrupted.file_id,
]);
createSupplierImportStore(
  recoveryDb,
  () => {},
  () => null,
);
assert.equal(
  rows(recoveryDb, "SELECT status FROM resource_import WHERE id=?", [
    interrupted.id,
  ])[0].status,
  "failed",
);
assert.equal(
  rows(recoveryDb, "SELECT status FROM file WHERE id=?", [
    interrupted.file_id,
  ])[0].status,
  "failed",
);
recoveryDb.close();
console.log(
  "PASS: server restart retains originals and terminates interrupted import/file status consistently",
);
