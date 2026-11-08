import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";
import {
  createQuoteDraftStore,
  quoteSourceFingerprint,
} from "../server/quote-draft.mjs";
import { createIntakeService, initIntake, rows } from "../server/intake.mjs";
import {
  extractStructured,
  mergeSemanticLines,
} from "../server/intake-extract.mjs";
import { fieldConflictIssues } from "../shared/field-review.mjs";
const SQL = await initSqlJs(),
  db = new SQL.Database();
db.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
db.run("INSERT INTO inventory VALUES('AN3-5A','EA',100,14.37,'CNY','FN')");
initIntake(db);
let failPersist = false;
const service = createIntakeService(
  db,
  () => {
    if (failPersist) throw Error("QA disk failure");
  },
  {},
);
const files = [
  {
    name: "line.csv",
    base64: Buffer.from(
      "PN,Quantity,Unit,Condition,到货日期\nAN3-5A,10,EA,FN,2026-12-02",
    ).toString("base64"),
  },
  {
    name: "terms.txt",
    base64: Buffer.from("全部物料 件状 NE 交期 2026-12-01").toString("base64"),
  },
];
const batch = await service.create({ requestId: randomUUID(), files });
const line = batch.lines[0];
assert.ok(fieldConflictIssues(line, "condition").length);
assert.ok(fieldConflictIssues(line, "needByDate").length);
assert.equal(line.condition, "FN");
const keep = {
  version: line.version,
  patch: { condition: "FN" },
  confirmFields: ["condition"],
  confirmationReason: "已对照客户物料行，采用逐行件状要求",
  operator: "QA",
};
assert.throws(
  () =>
    service.updateLine(batch.id, line.id, { ...keep, confirmationReason: "" }),
  (error) => error.status === 400,
);
assert.throws(
  () =>
    service.updateLine(batch.id, line.id, {
      ...keep,
      confirmFields: ["quantity"],
    }),
  (error) => error.status === 400,
);
assert.throws(
  () =>
    service.updateLine(batch.id, line.id, {
      ...keep,
      confirmFields: ["condition", "condition"],
    }),
  (error) => error.status === 400,
);
const snapshot = () => ({
  line: rows(db, "SELECT * FROM inquiry_line WHERE id=?", [line.id]),
  inquiry: rows(db, "SELECT status,issues,updated_at FROM inquiry WHERE id=?", [
    batch.id,
  ]),
  evidence: rows(db, "SELECT * FROM evidence WHERE line_id=?", [line.id]),
  history: rows(db, "SELECT * FROM evidence_history WHERE line_id=?", [
    line.id,
  ]),
  revisions: rows(db, "SELECT * FROM line_revision WHERE line_id=?", [line.id]),
});
const drafts = createQuoteDraftStore(
  db,
  () => {},
  (id) => service.detail(id),
);
const fingerprint = quoteSourceFingerprint(batch);
db.run("INSERT INTO quote_draft VALUES(?,?,?,?,?,?)", [
  batch.id,
  1,
  fingerprint,
  JSON.stringify({
    policy: {},
    lines: [
      {
        key: `intake-${batch.id}-1`,
        price: 17.96,
        reviewed: true,
        manual: true,
        skipped: false,
        manualCost: null,
      },
    ],
  }),
  "QA",
  new Date().toISOString(),
]);
assert.equal(drafts.read(batch.id).stale, false);
const before = snapshot();
failPersist = true;
assert.throws(
  () => service.updateLine(batch.id, line.id, keep),
  /disk failure/,
);
assert.deepEqual(
  snapshot(),
  before,
  "failed persistence restores material, inquiry, evidence and revisions",
);
failPersist = false;
const confirmed = service.updateLine(batch.id, line.id, keep),
  next = confirmed.lines[0];
assert.notEqual(quoteSourceFingerprint(confirmed), fingerprint);
const staleDraft = drafts.read(batch.id);
assert.equal(staleDraft.stale, true);
assert.equal(staleDraft.state.lines[0].price, null);
assert.equal(staleDraft.state.lines[0].reviewed, false);
assert.equal(next.condition, "FN");
assert.equal(next.rawFields.condition, "FN");
assert.equal(next.version, line.version + 1);
assert.equal(fieldConflictIssues(next, "condition").length, 0);
assert.ok(
  fieldConflictIssues(next, "needByDate").length,
  "confirming condition must leave date conflict intact",
);
assert.equal(
  next.fieldSources.condition.confirmation.reason,
  keep.confirmationReason,
);
assert.equal(next.fieldSources.condition.confirmation.version, line.version);
assert.ok(
  next.fieldSources.condition.previousSources.some(
    (source) => source.value === "NE",
  ),
);
assert.ok(
  next.fieldSources.condition.previousSources.some(
    (source) => source.value === "FN",
  ),
);
assert.throws(
  () => service.updateLine(batch.id, line.id, keep),
  (error) => error.status === 409,
);
const date = service.updateLine(batch.id, line.id, {
  version: next.version,
  patch: { needByDate: "2026-12-01" },
  confirmFields: ["needByDate"],
  confirmationReason: "采用客户统一到货日期",
  operator: "QA",
}).lines[0];
assert.equal(date.needByDate, "2026-12-01");
assert.equal(date.rawFields.needByDate, "2026-12-02");
assert.equal(fieldConflictIssues(date, "needByDate").length, 0);
assert.equal(
  rows(db, "SELECT fields FROM line_revision WHERE line_id=?", [line.id])
    .length,
  2,
);
const reopened = createIntakeService(
  new SQL.Database(db.export()),
  () => {},
  {},
).detail(batch.id).lines[0];
assert.equal(
  reopened.fieldSources.condition.confirmation.reason,
  keep.confirmationReason,
);
const columns = extractStructured([
  {
    id: "h",
    fileId: "a",
    locator: { row: 1 },
    cells: ["PN", "Quantity", "Unit", "Condition", "件状"],
    text: "PN Quantity Unit Condition 件状",
  },
  {
    id: "r",
    fileId: "a",
    locator: { row: 2 },
    cells: ["AN3-5A", "10", "EA", "FN", "NE"],
    text: "AN3-5A 10 EA FN NE",
  },
]);
assert.equal(
  columns.lines[0].fieldSources.condition.rejectedSources[0].value,
  "NE",
);
assert.equal(
  columns.lines[0].fieldSources.condition.rejectedSources[0].locator.column,
  5,
);
const semantic = mergeSemanticLines(columns.lines, [
  {
    ...columns.lines[0],
    condition: "OH",
    fieldSources: {
      condition: { contentId: "r", locator: { row: 2 }, method: "llm" },
    },
    issues: [],
  },
]);
assert.ok(
  semantic.lines[0].fieldSources.condition.rejectedSources.some(
    (source) => source.value === "OH",
  ),
);
const { Window } = await import("happy-dom");
const window = new Window({ url: "http://127.0.0.1/" });
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Node",
  "Event",
  "HTMLDialogElement",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === "window" ? window : window[name],
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { build } = await import("esbuild");
const { writeFileSync, unlinkSync } = await import("node:fs");
const bundle = await build({
  stdin: {
    contents:
      "export {ExtractionReview} from './src/components/ExtractionReview';",
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  write: false,
  jsx: "automatic",
  define: { "import.meta.env": JSON.stringify({ BASE_URL: "/" }) },
});
const temp = new URL("./.field-review-test.mjs", import.meta.url);
writeFileSync(temp, bundle.outputFiles[0].text);
const { ExtractionReview } = await import(temp.href);
unlinkSync(temp);
const React = await import("react"),
  { act } = React,
  { createRoot } = await import("react-dom/client");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const uiBatch = await service.create({ requestId: randomUUID(), files });
let saved = null,
  forceConflict = false;
globalThis.fetch = async (url, options = {}) => {
  try {
    if (options.method === "PATCH") {
      if (forceConflict)
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "物料版本已变化" }),
        };
      const body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () =>
          service.updateLine(uiBatch.id, uiBatch.lines[0].id, body),
      };
    }
    return { ok: true, json: async () => service.detail(uiBatch.id) };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      json: async () => ({ error: error.message }),
    };
  }
};
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
const render = async () => {
  await act(async () => {
    root.render(
      React.createElement(ExtractionReview, {
        batch: uiBatch,
        operator: "QA UI",
        onClose() {},
        onSaved(value) {
          saved = value;
        },
      }),
    );
    await wait();
  });
};
const button = (text) =>
  [...host.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
const click = async (node) => {
  assert.ok(node);
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait();
  });
};
await render();
assert.equal(button("确认取值").disabled, true);
await act(async () => {
  const area = host.querySelector("textarea");
  Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set.call(area, "已核对客户原文，采用当前件状");
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait();
});
assert.equal(button("确认取值").disabled, false);
forceConflict = true;
await click(button("确认取值"));
assert.match(host.textContent, /物料版本已变化/);
assert.ok(button("载入最新物料"));
await click(button("载入最新物料"));
assert.equal(saved.id, uiBatch.id);
await act(async () => {
  root.unmount();
});
const sameValue=mergeSemanticLines(columns.lines,[{...columns.lines[0],fieldSources:{condition:{contentId:'r',locator:{row:2},method:'llm'}},issues:[]}]);
assert.equal(sameValue.lines[0].fieldSources.condition.method,'column_mapping');
assert.ok(sameValue.lines[0].fieldSources.condition.sources.some(source=>source.method==='llm'));
const identifierBatch=await service.create({requestId:randomUUID(),files:[{name:'rfq-id.csv',base64:Buffer.from('PN,Quantity,Unit,Condition,询价单号,RFQ No.\nAN3-5A,10,EA,FN,RFQ-A,RFQ-B').toString('base64')}]});
const identifier=identifierBatch.lines[0];assert.ok(fieldConflictIssues(identifier,'rfqId').length);
const identifierConfirmed=service.updateLine(identifierBatch.id,identifier.id,{version:identifier.version,patch:{rfqId:'RFQ-A'},confirmFields:['rfqId'],confirmationReason:'采用客户表格中的询价单号'});
assert.equal(fieldConflictIssues(identifierConfirmed.lines[0],'rfqId').length,0);
db.close();
console.log(
  "PASS: same-value explicit confirmation, reason/field validation, scoped conflict removal, original/candidate provenance, CAS, revision/restart recovery and persistence rollback",
);
