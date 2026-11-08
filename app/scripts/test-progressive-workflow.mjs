import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { build } from "esbuild";
import { writeFileSync, unlinkSync } from "node:fs";
import initSqlJs from "sql.js";
import { createIntakeService, initIntake } from "../server/intake.mjs";
const SQL = await initSqlJs(),
  db = new SQL.Database();
db.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
db.run("INSERT INTO inventory VALUES('AN3-5A','EA',100,14.37,'CNY','FN')");
initIntake(db);
let release;
const barrier = new Promise((resolve) => {
  release = resolve;
});
const intake = createIntakeService(db, () => {}, {
  semantic: async () => {
    await barrier;
    return { lines: [], issues: [] };
  },
});
const input = {
  requestId: crypto.randomUUID(),
  files: [
    {
      name: "stages.csv",
      base64: Buffer.from(
        "PN,Description,Quantity,Unit,Condition\nAN3-5A,BOLT,10,EA,FN",
      ).toString("base64"),
    },
  ],
};
const phases = [];
const pending = intake.create(input, (stage, batch) =>
  phases.push({ stage, batch }),
);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(
  phases.map((event) => event.stage),
  [1, 2],
);
assert.equal(phases[1].batch.files[0].status, "parsed");
assert.equal(phases[1].batch.lines.length, 0);
release();
const final = await pending;
assert.deepEqual(
  phases.map((event) => event.stage),
  [1, 2, 3],
);
assert.equal(phases[2].batch.lines.length, 1);
assert.equal(final.status, "evidence_ready");
assert.equal((await intake.create(input)).id, final.id);

const window = new Window({ url: "http://127.0.0.1:5176/" });
for (const name of [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLDialogElement",
  "Node",
  "Event",
  "CustomEvent",
  "PointerEvent",
  "DragEvent",
  "File",
  "FileReader",
  "ResizeObserver",
  "localStorage",
  "location",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === "window" ? window : window[name],
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
const bundle = await build({
  stdin: {
    contents:
      "export {HomePage} from './src/pages/HomePage';export {useModuleReferenceDrag} from './src/engine/useModuleReferenceDrag';export {useWorkflowPresentation} from './src/engine/useWorkflowPresentation';export {createIntake} from './src/engine/intake';",
    resolveDir: process.cwd(),
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
const temp = new URL("./.progressive-test.mjs", import.meta.url);
writeFileSync(temp, bundle.outputFiles[0].text);
const {
  HomePage,
  useModuleReferenceDrag,
  useWorkflowPresentation,
  createIntake,
} = await import(temp.href);
unlinkSync(temp);
const React = await import("react"),
  { act } = React,
  { createRoot } = await import("react-dom/client");
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
let receivedFiles,
  created = 0;
globalThis.fetch = async (url, options) => {
  receivedFiles = JSON.parse(options.body).files;
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of phases)
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "progress", ...event }) + "\n",
            ),
          );
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: "done", result: final }) + "\n",
          ),
        );
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
};
await act(async () =>
  root.render(
    React.createElement(HomePage, {
      tasks: [],
      onPick() {},
      onNewTask() {
        created++;
      },
      onDelete() {},
      onRestore() {},
      deletedCount: 0,
      industryKw: "航空",
      taskTime: {},
    }),
  ),
);
const button = (text) =>
  [...host.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
await act(async () => button("新建询价").click());
const drop = new window.Event("drop", { bubbles: true, cancelable: true });
Object.defineProperty(drop, "dataTransfer", {
  value: {
    files: [
      new window.File(["PN,Quantity\nAN3-5A,10"], "dropped.csv", {
        type: "text/csv",
      }),
    ],
    types: ["Files"],
  },
});
await act(async () =>
  host.querySelector(".inquiry-file-picker").dispatchEvent(drop),
);
assert.ok(drop.defaultPrevented);
assert.match(host.textContent, /dropped.csv/);
await act(async () => {
  button("创建并分析").click();
  await wait(100);
});
assert.equal(created, 1);
assert.equal(receivedFiles[0].name, "dropped.csv");
const progress = [];
await createIntake([], "件号 AN3-5A 数量10", "QA", crypto.randomUUID(), {
  onProgress: (stage) => progress.push(stage),
});
assert.deepEqual(progress, [1, 2, 3]);
await act(async () => root.unmount());

let cited;
const capture = (event) => {
  cited = event.detail;
};
window.addEventListener("quanta-reference", capture);
function ModuleHarness({ run }) {
  const ref = React.useRef(null);
  const presentation = useWorkflowPresentation("qa", run, ref);
  useModuleReferenceDrag(ref, (stage) => ({
    id: "module-" + stage,
    label: "物料明细",
    excerpt: "AN3-5A 10 EA",
  }));
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("div", {
      "data-shown": presentation.shown,
      "data-busy": presentation.busyStage,
    }),
    React.createElement(
      "main",
      { ref },
      React.createElement(
        "section",
        { "data-inquiry-stage": "2" },
        React.createElement("h2", null, "提取需求"),
        React.createElement("input"),
      ),
    ),
    React.createElement(
      "div",
      { className: "rfq-chat-composer" },
      React.createElement("textarea"),
    ),
  );
}
root = createRoot(host);
await act(async () =>
  root.render(
    React.createElement(ModuleHarness, {
      run: { stage: 2, revealed: 3, state: "running" },
    }),
  ),
);
assert.equal(host.querySelector("[data-shown]").dataset.shown, "1");
assert.equal(host.querySelector("[data-busy]").dataset.busy, "2");
for (let i = 0; i < 3; i++) await act(async () => wait(155));
assert.equal(host.querySelector("[data-shown]").dataset.shown, "3");
const target = host.querySelector(".rfq-chat-composer");
document.elementFromPoint = () => target;
const pointer = (type, x, y) =>
  new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 7,
    clientX: x,
    clientY: y,
  });
await act(async () => {
  host.querySelector("h2").dispatchEvent(pointer("pointerdown", 20, 20));
  await wait(480);
});
assert.ok(document.querySelector(".module-reference-ghost"));
await act(async () => {
  window.dispatchEvent(pointer("pointermove", 400, 500));
  window.dispatchEvent(pointer("pointerup", 400, 500));
});
assert.equal(cited.label, "物料明细");
assert.equal(document.querySelector(".module-reference-ghost"), null);
cited = null;
await act(async () => {
  host.querySelector("h2").dispatchEvent(pointer("pointerdown", 20, 20));
  window.dispatchEvent(pointer("pointermove", 40, 50));
  await wait(480);
});
assert.equal(document.querySelector(".module-reference-ghost"), null);
assert.equal(cited, null);
await act(async () => {
  host.querySelector("input").dispatchEvent(pointer("pointerdown", 20, 20));
  await wait(480);
});
assert.equal(document.querySelector(".module-reference-ghost"), null);
await act(async () => root.unmount());
window.removeEventListener("quanta-reference", capture);
await window.happyDOM.close();
db.close();
console.log(
  "PASS: real intake phases, original-first persistence, idempotent retry, import file drop, streamed client callbacks, ordered reveal, event-backed spinner, long-press module citation, scroll/interactive cancellation and cleanup",
);
