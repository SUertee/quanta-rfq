import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { randomUUID } from "node:crypto";
import { createIntakeService, initIntake, rows } from "../server/intake.mjs";
import { createExtractionReview } from "../server/extraction-review.mjs";
import { quoteSourceFingerprint } from "../server/quote-draft.mjs";
const SQL = await initSqlJs(),
  db = new SQL.Database();
db.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
db.run("INSERT INTO inventory VALUES('AN3-5A','EA',100,14.37,'CNY','FN')");
initIntake(db);
let diskFailure = false;
const persist = () => {
  if (diskFailure) throw Error("QA disk failure");
};
const intake = createIntakeService(db, persist, {
  semantic: async () => ({
    lines: [],
    issues: ["模型返回不存在的来源，已拒绝该行"],
  }),
});
const batch = await intake.create({
  requestId: randomUUID(),
  files: [
    {
      name: "original.csv",
      base64: Buffer.from(
        "PN,Quantity,Unit,Condition\nAN3-5A,10,EA,FN",
      ).toString("base64"),
    },
  ],
});
const review = createExtractionReview(db, persist, (id) => intake.detail(id));
const before = review.read(batch.id);
assert.equal(before.blocked.length, 0);
const body = {
  fingerprint: before.fingerprint,
  fileIds: before.fileIds,
  reason: "逐份对照原文，件号数量单位件状已落实到物料行",
  operator: "QA",
};
assert.throws(
  () => review.confirm(batch.id, { ...body, fingerprint: "stale" }),
  (error) => error.status === 409,
);
assert.throws(
  () => review.confirm(batch.id, { ...body, reason: "" }),
  (error) => error.status === 400,
);
assert.throws(
  () => review.confirm(batch.id, { ...body, fileIds: [] }),
  (error) => error.status === 400,
);
assert.throws(
  () =>
    review.confirm(batch.id, {
      ...body,
      fileIds: [...body.fileIds, ...body.fileIds],
    }),
  (error) => error.status === 400,
);
const snapshot = () => ({
  inquiry: rows(db, "SELECT * FROM inquiry WHERE id=?", [batch.id]),
  logs: rows(db, "SELECT * FROM review_log"),
});
const snapshotBefore = snapshot();
diskFailure = true;
assert.throws(() => review.confirm(batch.id, body), /disk failure/);
assert.deepEqual(snapshot(), snapshotBefore);
diskFailure = false;
const confirmed = review.confirm(batch.id, body);
assert.equal(confirmed.status, "evidence_ready");
assert.equal(confirmed.issues.length, 0);
assert.notEqual(
  quoteSourceFingerprint(confirmed),
  quoteSourceFingerprint(batch),
);
assert.equal(confirmed.lines[0].version, batch.lines[0].version);
assert.equal(confirmed.files[0].id, batch.files[0].id);
assert.equal(confirmed.contents[0].text, batch.contents[0].text);
const log = rows(db, "SELECT * FROM review_log")[0],
  detail = JSON.parse(log.detail);
assert.equal(log.operator, "QA");
assert.deepEqual(detail.issues, before.issues);
assert.equal(detail.fingerprint, before.fingerprint);
assert.equal(detail.lines[0].version, batch.lines[0].version);
assert.throws(
  () => review.confirm(batch.id, body),
  (error) => error.status === 409,
);
// An old review cannot clear new line edits, unread files, or missing requirements.
db.run("UPDATE inquiry SET issues=? WHERE id=?", [
  JSON.stringify(before.issues),
  batch.id,
]);
const current = review.read(batch.id);
intake.updateLine(batch.id, batch.lines[0].id, {
  version: batch.lines[0].version,
  patch: { quantity: 20 },
});
assert.throws(
  () => review.confirm(batch.id, { ...body, fingerprint: current.fingerprint }),
  (error) => error.status === 409,
);
db.run("UPDATE file SET status='needs_ocr' WHERE inquiry_id=?", [batch.id]);
assert.ok(
  review.read(batch.id).blocked.some((issue) => issue.includes("未读取完整")),
);
assert.throws(
  () =>
    review.confirm(batch.id, {
      ...body,
      fingerprint: review.read(batch.id).fingerprint,
    }),
  (error) => error.status === 409,
);
db.run("UPDATE file SET status='parsed' WHERE inquiry_id=?", [batch.id]);
const changed = intake.detail(batch.id).lines[0];
intake.updateLine(batch.id, changed.id, {
  version: changed.version,
  patch: { condition: null },
});
assert.ok(review.read(batch.id).blocked.includes("物料字段仍有待核对项"));
const reloaded = new SQL.Database(db.export());
const reloadIntake = createIntakeService(reloaded, () => {}, {});
const reloadReview = createExtractionReview(
  reloaded,
  () => {},
  (id) => reloadIntake.detail(id),
);
assert.equal(rows(reloaded, "SELECT * FROM review_log").length, 1);
assert.ok(reloadReview.read(batch.id).blocked.length);
assert.throws(
  () => review.confirm(batch.id, null),
  (error) => error.status === 400,
);
db.run("UPDATE file SET document_type='unknown' WHERE inquiry_id=?", [
  batch.id,
]);
assert.ok(
  review
    .read(batch.id)
    .blocked.some((issue) => issue.includes("资料用途尚未确认")),
);
assert.throws(
  () => review.read("unknown"),
  (error) => error.status === 404,
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
  "HTMLDialogElement",
  "Node",
  "Event",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === "window" ? window : window[name],
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { build } = await import("esbuild"),
  { writeFileSync, unlinkSync } = await import("node:fs"),
  { fileURLToPath } = await import("node:url");
const bundle = await build({
  stdin: {
    contents:
      "export {ExtractionCompletionReview} from './src/components/ExtractionCompletionReview';",
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  jsx: "automatic",
  write: false,
  define: { "import.meta.env": JSON.stringify({ BASE_URL: "/" }) },
});
const temp = new URL("./.completion-review-test.mjs", import.meta.url);
writeFileSync(temp, bundle.outputFiles[0].text);
const { ExtractionCompletionReview } = await import(temp.href);
unlinkSync(temp);
const uiBatch = await intake.create({
  requestId: randomUUID(),
  files: [
    {
      name: "ui.csv",
      base64: Buffer.from(
        "PN,Description,Quantity,Unit,Condition\nAN3-5A,BOLT,10,EA,FN",
      ).toString("base64"),
    },
  ],
});
globalThis.fetch = async (url, options = {}) => {
  try {
    const data =
      options.method === "POST"
        ? review.confirm(uiBatch.id, JSON.parse(options.body))
        : review.read(uiBatch.id);
    return { ok: true, json: async () => data };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      json: async () => ({ error: error.message }),
    };
  }
};
const React = await import("react"),
  { act } = React,
  { createRoot } = await import("react-dom/client");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
let uiSaved;
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
await act(async () => {
  root.render(
    React.createElement(ExtractionCompletionReview, {
      inquiryId: uiBatch.id,
      operator: "QA UI",
      onClose() {},
      onSaved: (value) => {
        uiSaved = value;
      },
    }),
  );
  await wait();
});
const button = (text) =>
  [...host.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
assert.match(host.textContent, /制造商件号/);
assert.match(host.textContent, /报价截止日期/);
assert.match(host.textContent, /BOLT/);
assert.equal(button("确认提取完整").disabled, true);
await act(async () => {
  host.querySelector("input[type=checkbox]").click();
  const area = host.querySelector("textarea");
  Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set.call(area, "全部原文和标准字段已核对");
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait();
});
assert.equal(button("确认提取完整").disabled, false);
await act(async () => {
  button("确认提取完整").click();
  await wait();
});
assert.equal(uiSaved.status, "evidence_ready");
await act(async () => root.unmount());
await window.happyDOM.close();
db.close();
reloaded.close();
console.log(
  "PASS: complete-original acknowledgement, reasons, source/version CAS, review audit, preserved originals and rows, quote invalidation, persistence rollback, restart and unread/missing-field blocks",
);
