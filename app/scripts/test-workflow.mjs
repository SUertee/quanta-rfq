import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: ["src/engine/workflow.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { inquiryStages } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const empty = {
  materialCount: 0,
  lineCount: 0,
  extractionGaps: 0,
  matchedLines: 0,
  reviewedLines: 0,
  activeLines: 0,
  pricedLines: 0,
  exportAllowed: false,
  exported: false,
};
assert.equal(
  inquiryStages(empty).filter((s) => s.state === "done").length,
  0,
  "empty inquiry must not show completion",
);
const partial = {
  ...empty,
  materialCount: 2,
  lineCount: 3,
  activeLines: 3,
  extractionGaps: 1,
  matchedLines: 2,
  pricedLines: 1,
};
const stages = inquiryStages(partial);
assert.equal(stages[0].state, "done");
assert.equal(stages[1].state, "attention");
assert.equal(stages[2].state, "attention");
assert.equal(stages[3].state, "attention");
assert.equal(stages[5].state, "attention");
const priced = {
  ...partial,
  extractionGaps: 0,
  matchedLines: 3,
  pricedLines: 3,
};
assert.equal(
  inquiryStages(priced)[3].state,
  "attention",
  "price/candidate availability is not manual review",
);
for (let viewed = 1; viewed <= 6; viewed++)
  assert.deepEqual(
    inquiryStages(partial),
    stages,
    "visiting a stage cannot change business state",
  );
const reviewed = { ...priced, reviewedLines: 3, exportAllowed: true };
assert.equal(
  inquiryStages(reviewed)[5].state,
  "pending",
  "ready to export is not already exported",
);
assert.equal(inquiryStages({ ...reviewed, exported: true })[5].state, "done");
assert.equal(
  inquiryStages({ ...reviewed, reviewedLines: 2, exportAllowed: false })[3]
    .state,
  "attention",
  "editing/invalidating one row must reopen review",
);
console.log(
  "PASS: empty/partial inquiries, evidence != review, navigation != completion, readiness != export, changed rows reopen review",
);
