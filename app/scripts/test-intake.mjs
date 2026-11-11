process.env.RFQ_BOOTSTRAP_PASSWORD = 'admin123'; // Isolated test database only.
import {extractStructured} from '../server/intake-extract.mjs';
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
  // 多账户：默认种子 admin/admin123
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const r = await fetch(base + "/api/inquiries", {
    method: "POST",
    headers: auth,
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
    { headers: auth },
  );
  assert.equal(await raw.text(), csv);
  assert.ok(
    (await (await fetch(base + "/api/price-resources", { headers: auth })).json()).prices.length >
      0,
  );
  child.kill();
  await once(child, "exit");
  child = await start();
  assert.equal(
    (await (await fetch(base + "/api/inquiries/" + data.id, { headers: auth })).json()).lines
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
assert.equal(withNote.lines[0].needByDate,'2026-12-01');
assert.match(withNote.lines[0].requirement,/FAA/);
assert.ok(withNote.lines[0].fieldSources.needByDate.sources.some(source=>source.contentId!==withNote.lines[0].contentId));
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

// Regression: a labeled line must retain requirements beyond PN/quantity/unit/condition.
const labeledFull = extractStructured([{id:'full-labels',fileId:'full',locator:{line:1},text:'件号 AN3-5A 数量 10 单位 EA 件状 FN 描述 BOLT 证书 EASA Form 1 交期 2026-12-01'}]);
assert.equal(labeledFull.lines[0].description,'BOLT');
assert.equal(labeledFull.lines[0].requirement,'EASA Form 1');
assert.equal(labeledFull.lines[0].needByDate,'2026-12-01');
console.log('PASS: labeled extraction retains description, certificate and date alongside core fields');

// Global requirements link to each standard line while keeping the original CSV row unchanged.
const dates = await noteSvc.create({requestId:'global-dates-qa-01',files:[
  {name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition,证书,报价截止日期\nPN-0001,2,EA,FN,FAA 8130,2026-11-20').toString('base64')},
  {name:'requirements.txt',base64:Buffer.from('全部物料 要求 FAA 8130 交期 2026-12-01 报价截止日期 2026-11-20').toString('base64')},
]});
assert.equal(dates.lines.length,1);
assert.equal(dates.lines[0].needByDate,'2026-12-01');
assert.equal(dates.lines[0].quoteDeadline,'2026-11-20');
assert.equal(dates.lines[0].dueDate,null);
assert.equal(dates.lines[0].rawFields.needByDate,undefined);
assert.ok(dates.lines[0].fieldSources.needByDate.sources[0].contentId!==dates.lines[0].contentId);
const conflicting = await noteSvc.create({requestId:'global-conflict-qa-01',files:[
  {name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition,到货日期\nPN-0001,2,EA,FN,2026-12-02').toString('base64')},
  {name:'requirements.txt',base64:Buffer.from('全部物料 交期 2026-12-01').toString('base64')},
]});
assert.equal(conflicting.lines[0].needByDate,'2026-12-02');
assert.ok(conflicting.lines[0].issues.some(issue=>issue.includes('交期冲突')));
const corrected = noteSvc.updateLine(conflicting.id,conflicting.lines[0].id,{version:conflicting.lines[0].version,patch:{needByDate:'2026-12-01'},operator:'QA'});
assert.ok(!corrected.lines[0].issues.some(issue=>issue.includes('交期冲突')));
assert.equal(corrected.lines[0].fieldSources.needByDate.method,'manual');
const {mergeSemanticLines,mergeExtractedRequirements}=await import('../server/intake-extract.mjs');
const unknownColumn=extractStructured([{id:'head',fileId:'sheet',locator:{row:1},text:'PN\tQuantity\tUnit\tCondition\t备注',cells:['PN','Quantity','Unit','Condition','备注']},{id:'row',fileId:'sheet',locator:{row:2},text:'PN-0001\t2\tEA\tFN\t需追溯记录',cells:['PN-0001','2','EA','FN','需追溯记录']}]);
assert.deepEqual(unknownColumn.unresolved.map(chunk=>chunk.id),['row']);
const reread=await extractSemantic(unknownColumn.unresolved,{apiKey:'test',baseURL:'https://example.invalid',model:'offline'},{knownLines:unknownColumn.lines,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'row',partNumber:'PN-0001',quantity:null,description:'invented description',requirement:'需追溯记录'}]})}}]})})});
assert.ok(reread.issues.some(issue=>issue.includes('description')));
const combined=mergeSemanticLines(unknownColumn.lines,reread.lines);
assert.equal(combined.lines.length,1);
assert.equal(combined.lines[0].quantity,2);
assert.equal(combined.lines[0].requirement,'需追溯记录');
assert.ok(!combined.lines[0].issues.includes('缺单位'));
const separate=mergeSemanticLines(unknownColumn.lines,[{...reread.lines[0],contentId:'another-file'}]);
assert.equal(separate.lines.length,2);
assert.equal(mergeExtractedRequirements(unknownColumn.lines,[{contentId:'row',scope:'all',field:'condition',value:'forged'}],unknownColumn.unresolved).applied.size,0);
console.log('PASS: cross-file certificate/date provenance, deadline/delivery separation, conflicts/manual correction, unknown-column reread, fabricated description rejection and same-source supplement without cross-file deduplication');

const semanticFixture={apiKey:'test',baseURL:'https://example.invalid',model:'offline'};
const reasoningText='Internal draft {"not":"output"}</think>\n'+JSON.stringify({lines:[{contentId:'safe',partNumber:'PN-0001',quantity:2,uom:'EA',condition:'FN'}]});
const reasoningSafe=await extractSemantic([{id:'safe',fileId:'safe',locator:{line:1},text:'PN-0001 2 EA FN'}],semanticFixture,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:reasoningText}}]})})});
assert.equal(reasoningSafe.lines[0].partNumber,'PN-0001');
await assert.rejects(()=>extractSemantic([{id:'safe',text:'PN-0001 2 EA FN'}],semanticFixture,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'private model reasoning with {broken JSON'}}]})})}),error=>!error.message.includes('private model')&&error.message.includes('原文已保留'));
const sentence=extractStructured([{id:'mail',fileId:'mail',locator:{part:'body'},text:'All items require FAA 8130 certificates. Required by: 2026-12-20. Quote deadline: 2026-11-20.'}]);
assert.ok(!sentence.requirements.some(row=>row.value==='s.'));
assert.equal(sentence.requirements.find(row=>row.field==='needByDate').value,'2026-12-20');
assert.equal(sentence.requirements.find(row=>row.field==='quoteDeadline').value,'2026-11-20');
console.log('PASS: sentence label boundaries, terminal punctuation, reasoning-prefix JSON isolation and safe extraction errors');

const noOp=noteSvc.updateLine(conflicting.id,conflicting.lines[0].id,{version:corrected.lines[0].version,patch:{description:'new description',needByDate:corrected.lines[0].needByDate},operator:'QA'});
assert.ok(noOp.lines[0].fieldSources.needByDate.previousSources.some(source=>source.contentId!==noOp.lines[0].contentId));
const conflictAgain=await noteSvc.create({requestId:'review-conflict-retained-01',files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition,到货日期\nPN-0001,2,EA,FN,2026-12-02').toString('base64')},{name:'global.txt',base64:Buffer.from('全部物料 交期 2026-12-01').toString('base64')}]});
const unrelatedEdit=noteSvc.updateLine(conflictAgain.id,conflictAgain.lines[0].id,{version:1,patch:{description:'edited',needByDate:'2026-12-02',quantity:2,uom:'EA'},operator:'QA'});
assert.ok(unrelatedEdit.lines[0].issues.some(issue=>issue.includes('交期冲突')));
assert.notEqual(unrelatedEdit.lines[0].fieldSources.needByDate.method,'manual');
assert.ok(unrelatedEdit.lines[0].fieldSources.needByDate.rejectedSources.length);
const scoped=extractStructured([{id:'specific',fileId:'specific',locator:{line:1},text:'备注 各项物料请分别报价 件号 AN3-5A 交期 2026-12-01 数量 10 单位 EA 件状 FN'}]);
assert.equal(scoped.requirements.length,0);
const bodyScoped=extractStructured([{id:'body-specific',fileId:'mail',locator:{part:'body'},text:'您好，件号 AN3-5A 交期 2026-12-01 数量 10 单位 EA 件状 FN'}]);
assert.equal(bodyScoped.requirements.length,0);
const unconsumed=await noteSvc.create({requestId:'review-unconsumed-01',files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'global.txt',base64:Buffer.from('全部物料 另加 BOLT 1/4-28 共 10 EA 交期 2026-12-01').toString('base64')}]});
assert.ok(unconsumed.issues.some(issue=>issue.includes('未落实到物料行')));
const bothRequirements=await noteSvc.create({requestId:'review-both-requirements-01',files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'global.txt',base64:Buffer.from('全部物料 证书 FAA 8130；要求 提供追溯记录').toString('base64')}]});
assert.match(bothRequirements.lines[0].requirement,/FAA 8130/);
assert.match(bothRequirements.lines[0].requirement,/提供追溯记录/);
const addedGlobal=noteSvc.addLine(bothRequirements.id,{partNumber:'PN-0001',quantity:1,uom:'EA'});
assert.match(addedGlobal.lines.at(-1).requirement,/FAA 8130/);
assert.match(addedGlobal.lines.at(-1).requirement,/提供追溯记录/);
const duplicateDates=extractStructured([{id:'dh',fileId:'dup',locator:{row:1},text:'',cells:['PN','Quantity','Unit','Condition','交期','到货日期']},{id:'dr',fileId:'dup',locator:{row:2},text:'PN-0001\t2\tEA\tFN\t2026-12-01\t2026-12-02',cells:['PN-0001','2','EA','FN','2026-12-01','2026-12-02']}]);
assert.equal(duplicateDates.lines[0].needByDate,'2026-12-01');
assert.ok(duplicateDates.lines[0].issues.some(issue=>issue.includes('多列交期')));
assert.equal(duplicateDates.unresolved.length,1);
const pnPrefix=await extractSemantic([{id:'pn-prefix',fileId:'prefix',locator:{line:1},text:'AN3-5A 需附 EASA Form 1'}],semanticFixture,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'pn-prefix',partNumber:'AN3',quantity:null}],requirements:[{contentId:'pn-prefix',scope:'part',partNumber:'AN3',field:'requirement',value:'EASA Form 1'}]})}}]})})});
assert.equal(pnPrefix.lines.length,0);
assert.equal(pnPrefix.requirements.length,0);
const unitLabel=extractStructured([{id:'unit-price',fileId:'mail',locator:{part:'body'},text:'All items: please quote unit price and lead time. Required by: 2026-12-20.'}]);
assert.ok(!unitLabel.requirements.some(requirement=>requirement.field==='uom'));
console.log('PASS: independent-review regressions retain unresolved conflicts/provenance, constrain global scope, detect unconsumed text, inherit common requirements, reject duplicate columns and whole-PN prefix substitution');
const partialSemanticSvc=createIntakeService(db,persist,{semantic:async chunks=>extractSemantic(chunks,semanticFixture,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:chunks[0].id,partNumber:'PN-0001',quantity:2}]})}}]})})})});
const partialCoverage=await partialSemanticSvc.create({requestId:'review-partial-cell-01',files:[{name:'partial.csv',base64:Buffer.from('PN,Quantity,Unit,Condition,备注\nPN-0001,2,EA,FN,需追溯记录').toString('base64')}]});
assert.ok(partialCoverage.issues.some(issue=>issue.includes('未落实到物料行')));
// A record produced before the stricter scope check must not remain silently usable.
const scopeMigrationDb=new SQL.Database(db.export());
const scopeBefore=rows(scopeMigrationDb,'SELECT fields,version FROM inquiry_line WHERE id=?',[dates.lines[0].id])[0];
const sourceId=dates.contents.find(content=>content.file_id===dates.files.find(file=>file.name==='requirements.txt').id).id;
scopeMigrationDb.run('UPDATE file_content SET text=? WHERE id=?',['件号 PN-0001 交期 2026-12-20',sourceId]);
scopeMigrationDb.run("DELETE FROM schema_migration WHERE id='requirement-scope-v2'");
initIntake(scopeMigrationDb);
const migratedScope=createIntakeService(scopeMigrationDb,()=>{}).detail(dates.id).lines[0];
assert.ok(migratedScope.issues.some(issue=>issue.includes('适用范围需确认')));
assert.equal(migratedScope.version,scopeBefore.version+1);
initIntake(scopeMigrationDb);
assert.equal(createIntakeService(scopeMigrationDb,()=>{}).detail(dates.id).lines[0].version,migratedScope.version);
console.log('PASS: partial semantic rows do not clear unknown cells; unsafe legacy requirement scope is revisioned and blocked on migration');
const scopeAfterSemantic=createIntakeService(db,persist,{semantic:async chunks=>extractSemantic(chunks,semanticFixture,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:chunks[0].id,partNumber:'AN3-5A',quantity:10,uom:'EA',condition:'FN',needByDate:'2026-12-01'}]})}}]})})})});
const lateScope=await scopeAfterSemantic.create({requestId:'review-late-scope-01',files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'mail.eml',base64:Buffer.from('From: qa@example.test\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n请报价 AN3-5A 数量 10 单位 EA 件状 FN 交期 2026-12-01').toString('base64')}]});
assert.ok(!lateScope.lines.find(line=>line.partNumber==='PN-0001').needByDate);
assert.equal(lateScope.requirements.length,0);
assert.ok(lateScope.issues.some(issue=>issue.includes('共同要求适用范围')));
const partService=createIntakeService(db,persist,{semantic:async chunks=>({lines:[],issues:[],requirements:[{contentId:chunks[0].id,scope:'part',partNumber:'PN-0001',field:'requirement',value:'PN-0001 需附 EASA Form 1'}]})});
const partInquiry=await partService.create({requestId:'review-part-renamed-01',files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'part.txt',base64:Buffer.from('PN-0001 需附 EASA Form 1').toString('base64')}]});
const renamed=partService.updateLine(partInquiry.id,partInquiry.lines[0].id,{version:1,patch:{partNumber:'AN3-5A'}});
assert.ok(renamed.lines[0].issues.some(issue=>issue.includes('适用范围需确认')));
// Legacy all-requirements survive a manual edit that moves their provenance to history.
db.run('UPDATE inquiry SET requirements=? WHERE id=?',['[]',bothRequirements.id]);
const beforeLegacyEdit=noteSvc.detail(bothRequirements.id).lines[0];
noteSvc.updateLine(bothRequirements.id,beforeLegacyEdit.id,{version:beforeLegacyEdit.version,patch:{requirement:'人工补充要求'}});
const legacyAdded=noteSvc.addLine(bothRequirements.id,{partNumber:'PN-0001',quantity:1,uom:'EA'});
assert.match(legacyAdded.lines.at(-1).requirement,/FAA 8130/);
console.log('PASS: semantic discovery revalidates all-scope requirements, part renames are blocked for review, and legacy manual provenance still supplies common requirements to new rows');
const onlyLegacy=await noteSvc.create({requestId:'review-single-legacy-01',files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'global.txt',base64:Buffer.from('全部物料 证书 FAA 8130').toString('base64')}]});
db.run('UPDATE inquiry SET requirements=? WHERE id=?',['[]',onlyLegacy.id]);
noteSvc.updateLine(onlyLegacy.id,onlyLegacy.lines[0].id,{version:1,patch:{requirement:'人工补充要求'}});
assert.match(noteSvc.addLine(onlyLegacy.id,{partNumber:'PN-0001',quantity:1,uom:'EA'}).lines.at(-1).requirement,/FAA 8130/);
const missingPartDb=new SQL.Database(db.export());
const missingPartRow=rows(missingPartDb,'SELECT fields FROM inquiry_line WHERE id=?',[partInquiry.lines[0].id])[0];
const missingPartFields=JSON.parse(missingPartRow.fields);
for(const source of missingPartFields.fieldSources.requirement.sources)delete source.partNumber;
missingPartFields.issues=[];
missingPartDb.run('UPDATE inquiry_line SET fields=?,issues=? WHERE id=?',[JSON.stringify(missingPartFields),'[]',partInquiry.lines[0].id]);
missingPartDb.run("DELETE FROM schema_migration WHERE id='requirement-scope-v2'");
initIntake(missingPartDb);
assert.ok(createIntakeService(missingPartDb,()=>{}).detail(partInquiry.id).lines[0].issues.some(issue=>issue.includes('适用范围需确认')));
console.log('PASS: single-row legacy requirements survive manual provenance changes; legacy part provenance without target identity is blocked');

// Short model-facing IDs map back to durable provenance. Context-only rows cannot be cited.
let sentPayload;
const shortSources=[{id:'durable-unresolved-id',fileId:'notes',locator:{line:1},text:'AN3-5A 需附 EASA Form 1'}];
const shortResult=await extractSemantic(shortSources,semanticFixture,{knownLines:[{contentId:'durable-csv-id',partNumber:'AN3-5A',quantity:10}],fetchImpl:async(url,options)=>{
  sentPayload=JSON.parse(JSON.parse(options.body).messages[1].content);
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[],requirements:[{contentId:sentPayload.sources[0].contentId,scope:'part',partNumber:'AN3-5A',field:'requirement',value:'EASA Form 1'}]})}}]})};
}});
assert.equal(sentPayload.sources[0].contentId,'S1');assert.equal(sentPayload.knownLines[0].contentId,undefined);
assert.equal(shortResult.requirements[0].contentId,shortSources[0].id);assert.deepEqual(shortResult.issues,[]);
const unknownSource=await extractSemantic(shortSources,semanticFixture,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S999',partNumber:'AN3-5A',quantity:null}],requirements:[]})}}]})})});
assert.equal(unknownSource.lines.length,0);assert.ok(unknownSource.issues.some(issue=>issue.includes('不存在的来源')));
const collision=await extractSemantic([{...shortSources[0],id:'S1'}],semanticFixture,{fetchImpl:async(url,options)=>{
  const data=JSON.parse(JSON.parse(options.body).messages[1].content);assert.equal(data.sources[0].contentId,'SS1');
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[],requirements:[{contentId:'SS1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:'EASA Form 1'}]})}}]})};
}});assert.equal(collision.requirements[0].contentId,'S1');
console.log('PASS: short source IDs preserve durable provenance, context-only rows omit returnable IDs, unknown references rejected and alias collisions avoided');
const supplementKnown=[{contentId:'original-list',partNumber:'AN3-5A',quantity:10,uom:'EA',condition:'FN',issues:[],fieldSources:{}}];
const requirementOnly=await extractSemantic(shortSources,semanticFixture,{knownLines:supplementKnown,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity:10,requirement:'需附 EASA Form 1'}],requirements:[{contentId:'S1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:'需附 EASA Form 1'}]})}}]})})});
assert.equal(requirementOnly.lines.length,0);assert.deepEqual(requirementOnly.issues,[]);assert.equal(requirementOnly.requirements.length,1);
const separateDemand=await extractSemantic([{...shortSources[0],text:'AN3-5A 10 EA FN 需附 EASA Form 1'}],semanticFixture,{knownLines:supplementKnown,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity:10,uom:'EA',condition:'FN'}],requirements:[{contentId:'S1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:'需附 EASA Form 1'}]})}}]})})});
assert.equal(separateDemand.lines.length,1);assert.equal(mergeSemanticLines(supplementKnown,separateDemand.lines).lines.length,2);
console.log('PASS: fully accounted part requirements attach without duplicate demand; quantity-bearing source remains a separate line');
const multipleSources=[{id:'first-source',text:'TEST-A 2 EA FN',locator:{line:1}},{id:'second-source',text:'TEST-B 7 EA NE',locator:{line:2}}];
const secondSource=await extractSemantic(multipleSources,semanticFixture,{knownLines:[{contentId:'first-source',partNumber:'TEST-A',quantity:2}],fetchImpl:async(url,options)=>{
  const payload=JSON.parse(JSON.parse(options.body).messages[1].content);
  assert.equal(payload.knownLines[0].contentId,payload.sources[0].contentId);
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S2',partNumber:'TEST-B',quantity:7,uom:'EA',condition:'NE'}]})}}]})};
}});
assert.equal(secondSource.lines[0].contentId,'second-source');assert.equal(secondSource.lines[0].fieldSources.quantity.contentId,'second-source');assert.equal(secondSource.lines[0].quantity,7);assert.deepEqual(secondSource.issues,[]);
const onlyRequirementsService=createIntakeService(db,persist,{semantic:async chunks=>({lines:[],issues:[],requirements:[{contentId:chunks[0].id,scope:'part',partNumber:'PN-0001',field:'requirement',value:'需附 EASA Form 1'}]})});
const onlyRequirementsBatch=await onlyRequirementsService.create({requestId:crypto.randomUUID(),files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'notes.txt',base64:Buffer.from('PN-0001 需附 EASA Form 1').toString('base64')}]});
assert.equal(onlyRequirementsBatch.lines.length,1);assert.ok(!onlyRequirementsBatch.issues.some(issue=>issue.includes('未落实')));assert.ok(onlyRequirementsBatch.lines[0].requirement.includes('EASA Form 1'));
assert.equal(requirementOnly.requirements[0].classification,'part_supplement');
for(const text of ['AN3-5A 另需 5 支，需附 EASA Form 1','AN3-5A 10 Each 需附 EASA Form 1','AN3-5A 再要两件，需附 EASA Form 1']){
 const quantity=text.includes('两')?2:text.includes('5 支')?5:10;
 const result=await extractSemantic([{...shortSources[0],text}],semanticFixture,{knownLines:supplementKnown,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity}],requirements:[{contentId:'S1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:text.replace('AN3-5A ','')}]})}}]})})});
 assert.equal(result.lines.length,1,text);
}
const ambiguousSupplement=await extractSemantic(shortSources,semanticFixture,{knownLines:[...supplementKnown,{...supplementKnown[0],contentId:'another-list',condition:'OH'}],fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity:null,requirement:'需附 EASA Form 1'}],requirements:[{contentId:'S1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:'需附 EASA Form 1'}]})}}]})})});
assert.equal(ambiguousSupplement.lines.length,1);
for(const text of ['AN3-5A 另加 5，需8130-3','AN3-5A Qty. 5 需附 EASA Form 1','AN3-5A 数量为5 需附 EASA Form 1','AN3-5A ５支 需附 EASA Form 1']){
 const result=await extractSemantic([{...shortSources[0],text}],semanticFixture,{knownLines:supplementKnown,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity:null}],requirements:[{contentId:'S1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:text.replace('AN3-5A ','')}]})}}]})})});
 assert.equal(result.lines.length,1,text);
}
const warrantyText='AN3-5A 保修12个月';
const warranty=await extractSemantic([{...shortSources[0],text:warrantyText}],semanticFixture,{knownLines:supplementKnown,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity:null}],requirements:[{contentId:'S1',scope:'part',partNumber:'AN3-5A',field:'requirement',value:'保修12个月'}]})}}]})})});
assert.equal(warranty.lines.length,0);assert.equal(warranty.requirements[0].targetContentId,'original-list');
const mixedRequirements=[{contentId:'mixed-note',scope:'part',partNumber:'PN-0001',field:'requirement',value:'EASA Form 1'},{contentId:'mixed-note',scope:'part',partNumber:'ABSENT',field:'requirement',value:'CoC'}];
const appliedMixed=mergeExtractedRequirements([{contentId:'parts',partNumber:'PN-0001',quantity:2,uom:'EA',condition:'FN',issues:[],fieldSources:{}}],mixedRequirements,[{id:'mixed-note',text:'PN-0001 EASA Form 1; ABSENT CoC',locator:{line:1}}]);
assert.equal(appliedMixed.appliedRequirements.has(mixedRequirements[0]),true);assert.equal(appliedMixed.appliedRequirements.has(mixedRequirements[1]),false);
const pinned=mergeExtractedRequirements([...supplementKnown,{...supplementKnown[0],contentId:'another-list'}],warranty.requirements,[{...shortSources[0],text:warrantyText}]);
assert.ok(pinned.lines[0].requirement.includes('保修'));assert.equal(pinned.lines[1].requirement,undefined);
const simultaneous=await extractSemantic([{id:'new-demand',text:'AN3-5A 3 EA FN',locator:{line:1}},{id:'same-part-note',text:'AN3-5A 需附 EASA Form 1',locator:{line:1}}],semanticFixture,{knownLines:supplementKnown,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'S1',partNumber:'AN3-5A',quantity:3,uom:'EA',condition:'FN'},{contentId:'S2',partNumber:'AN3-5A',quantity:null}],requirements:[{contentId:'S2',scope:'part',partNumber:'AN3-5A',field:'requirement',value:'需附 EASA Form 1'}]})}}]})})});
assert.equal(simultaneous.lines.length,2);assert.equal(simultaneous.requirements[0].classification,undefined);
const onlyAmbiguous=mergeExtractedRequirements([...supplementKnown,{...supplementKnown[0],contentId:'other-list'}],[{contentId:shortSources[0].id,scope:'part',partNumber:'AN3-5A',field:'requirement',value:'需附 EASA Form 1'}],shortSources);
assert.equal(onlyAmbiguous.appliedRequirements.size,0);assert.ok(onlyAmbiguous.lines.every(line=>line.issues.some(issue=>issue.includes('适用范围'))));
const orphanReqService=createIntakeService(db,persist,{semantic:async chunks=>({lines:[],issues:[],requirements:[{contentId:chunks[0].id,scope:'part',partNumber:'MS-ABC',field:'requirement',value:'需附 CoC'}]})});
const orphanReq=await orphanReqService.create({requestId:crypto.randomUUID(),files:[{name:'parts.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nPN-0001,2,EA,FN').toString('base64')},{name:'note.txt',base64:Buffer.from('MS-ABC 需附 CoC').toString('base64')}]});
assert.ok(orphanReq.issues.some(issue=>issue.includes('未落实')));
const addedPart=onlyRequirementsService.addLine(onlyRequirementsBatch.id,{partNumber:'PN-0001',quantity:3,uom:'EA'}).lines.at(-1);
assert.equal(addedPart.requirement,undefined);assert.ok(addedPart.issues.some(issue=>issue.includes('适用范围需确认')));
const addedOther=onlyRequirementsService.addLine(onlyRequirementsBatch.id,{partNumber:'OTHER',quantity:1,uom:'EA'}).lines.at(-1);
const renamedPart=onlyRequirementsService.updateLine(onlyRequirementsBatch.id,addedOther.id,{version:addedOther.version,patch:{partNumber:'PN-0001'}}).lines.find(line=>line.id===addedOther.id);
assert.equal(renamedPart.requirement,undefined);assert.ok(renamedPart.issues.some(issue=>issue.includes('适用范围需确认')));
