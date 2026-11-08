import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";
import { extractSupplierSemantic } from "../server/supplier-extract.mjs";
import { createSupplierImportStore } from "../server/supplier-import.mjs";
import { createIntakeService, initIntake, rows } from "../server/intake.mjs";
import { readOcr } from "../server/ocr-reader.mjs";
const labels = {
  supplierName: "Supplier",
  partNumber: "Part Number",
  unitPrice: "Unit Price",
  currency: "Currency",
  uom: "Unit",
  condition: "Condition",
  moq: "MOQ",
  leadDays: "Lead Days",
  validFrom: "Valid From",
  validUntil: "Valid Until",
  certType: "Certificate",
  taxBasis: "Tax Basis",
};
const values = {
  supplierName: "QA Text Aero",
  partNumber: "AN3-5A",
  unitPrice: "20.50",
  currency: "CNY",
  uom: "EA",
  condition: "FN",
  moq: "1",
  leadDays: "2",
  validFrom: "2026-11-01",
  validUntil: "2099-12-31",
  certType: "EASA Form 1",
  taxBasis: "tax exclusive",
};
const sourceText = Object.entries(values)
  .map(
    ([key, value]) =>
      `${labels[key]}: ${value}${key === "leadDays" ? " days" : ""}`,
  )
  .join("\n");
const chunk = { id: "source", locator: { page: 1 }, text: sourceText };
function reply(source = chunk) {
  return {
    quotes: [
      {
        contentId: source.id,
        rowExcerpt: `Part Number: AN3-5A\nUnit Price: 20.50`,
        fields: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            {
              contentId: source.id,
              value,
              excerpt: `${labels[key]}: ${value}${key === "leadDays" ? " days" : ""}`,
            },
          ]),
        ),
      },
    ],
    unresolved: [],
  };
}
const config = {
  apiKey: "test",
  baseURL: "https://model.example.test/v1",
  model: "test",
};
const fetchResult = (value) => async () => ({
  ok: true,
  json: async () => ({
    choices: [
      {
        message: { content: "<think>private</think>" + JSON.stringify(value) },
      },
    ],
  }),
});
let result = await extractSupplierSemantic([chunk], config, {
  fetchImpl: fetchResult(reply()),
});
assert.deepEqual(result.issues, []);
assert.equal(result.rows[0].values.unitPrice, 20.5);
assert.equal(result.rows[0].values.authorized, false);
assert.equal(
  result.rows[0].fieldSources.unitPrice.excerpt,
  "Unit Price: 20.50",
);
const fake = reply();
fake.quotes[0].fields.unitPrice.value = "0.01";
assert.ok(
  (
    await extractSupplierSemantic([chunk], config, {
      fetchImpl: fetchResult(fake),
    })
  ).issues.length,
);
const absent = reply();
absent.quotes[0].fields.currency.contentId = "not-this-file";
assert.ok(
  (
    await extractSupplierSemantic([chunk], config, {
      fetchImpl: fetchResult(absent),
    })
  ).issues.length,
);
const wrongPart = reply();
wrongPart.quotes[0].fields.partNumber.value = "AN3";
assert.equal(
  (
    await extractSupplierSemantic([chunk], config, {
      fetchImpl: fetchResult(wrongPart),
    })
  ).rows.length,
  0,
);
const unknown = {
  ...chunk,
  text: sourceText + "\nEXW warehouse; deposit required",
};
assert.ok(
  (
    await extractSupplierSemantic([unknown], config, {
      fetchImpl: fetchResult(reply(unknown)),
    })
  ).issues.some((issue) => issue.includes("未映射")),
  "model omission cannot hide commercial terms",
);
const pageExcerpt = reply();
pageExcerpt.quotes[0].rowExcerpt = unknown.text;
pageExcerpt.quotes[0].fields.unitPrice.excerpt = unknown.text;
assert.ok(
  (
    await extractSupplierSemantic([unknown], config, {
      fetchImpl: fetchResult(pageExcerpt),
    })
  ).issues.some((issue) => issue.includes("未映射")),
  "page-sized excerpts cannot count as complete coverage",
);
const duplicate = reply();
duplicate.quotes.push(structuredClone(duplicate.quotes[0]));
assert.ok(
  (
    await extractSupplierSemantic([chunk], config, {
      fetchImpl: fetchResult(duplicate),
    })
  ).issues.some((issue) => issue.includes("重复")),
);
assert.ok(
  (await extractSupplierSemantic([chunk], null)).issues.some((issue) =>
    issue.includes("未配置"),
  ),
);
await assert.rejects(
  () =>
    extractSupplierSemantic([chunk], config, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "private invalid JSON" } }],
        }),
      }),
    }),
  /格式无效/,
);
console.log(
  "PASS: supplier field proofs, exact full PN, invented/cross-source rejection, omitted-term coverage, large-excerpt defense, duplicate-row guard and safe model errors",
);
const SQL = await initSqlJs(),
  db = new SQL.Database();
db.run(
  "CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)",
);
initIntake(db);
const intake = createIntakeService(db, () => {}, {});
const inquiry = await intake.create({
  source: "manual_upload",
  operator: "QA",
  requestId: randomUUID(),
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
let modelReady = false,
  calls = 0,
  hold = null;
const semantic = async (chunks) => {
  calls++;
  if (hold) await hold;
  return extractSupplierSemantic(chunks, modelReady ? config : null, {
    fetchImpl: fetchResult(reply(chunks[0])),
  });
};
const imports = createSupplierImportStore(
  db,
  () => {},
  (id) => intake.detail(id),
  { semantic },
);
let preview = await imports.create(inquiry.id, {
  requestId: randomUUID(),
  operator: "QA",
  name: "supplier.txt",
  mime: "text/plain",
  base64: Buffer.from(sourceText).toString("base64"),
});
assert.ok(preview.issues.some((issue) => issue.includes("未配置")));
assert.equal(preview.sources[0].text, sourceText);
const fileId = preview.fileId;
modelReady = true;
const retry = {
  version: preview.version,
  requestId: randomUUID(),
  operator: "QA",
};
let release;
hold = new Promise((resolve) => (release = resolve));
const running = imports.retry(inquiry.id, preview.id, retry);
const same = await imports.retry(inquiry.id, preview.id, retry);
assert.equal(same.status, "processing");
assert.equal(calls, 2, "repeated retry cannot launch duplicate extraction");
await assert.rejects(
  () =>
    imports.retry(inquiry.id, preview.id, {
      ...retry,
      requestId: randomUUID(),
    }),
  (error) => error.status === 409,
);
release();
hold = null;
preview = await running;
assert.equal(preview.rows.length, 1);
assert.deepEqual(preview.issues, []);
assert.equal(preview.fileId, fileId);
assert.equal(
  (await imports.retry(inquiry.id, preview.id, retry)).version,
  preview.version,
);
assert.equal(
  rows(db, "SELECT * FROM file WHERE document_type='supplier_quote'").length,
  1,
);
assert.equal(rows(db, "SELECT * FROM price_resource").length, 0);
const beforeFile = rows(db, "SELECT status,error FROM file WHERE id=?", [
  fileId,
])[0];
const failingRetryStore = createSupplierImportStore(
  db,
  () => {
    throw new Error("QA disk failure");
  },
  (id) => intake.detail(id),
  { semantic },
);
await assert.rejects(
  () =>
    failingRetryStore.retry(inquiry.id, preview.id, {
      version: preview.version,
      requestId: randomUUID(),
      operator: "QA",
    }),
  /QA disk failure/,
);
assert.deepEqual(
  rows(db, "SELECT status,error FROM file WHERE id=?", [fileId])[0],
  beforeFile,
);
assert.equal(imports.read(inquiry.id, preview.id).version, preview.version);
assert.equal(preview.rows[0].fieldSources.unitPrice.locator.line, 3);
console.log(
  "PASS: retry persistence failure restores file/import state, text field proof retains exact source line",
);
const confirmed = imports.confirm(inquiry.id, preview.id, {
  version: preview.version,
  operator: "QA",
  rows: preview.rows.map((row) => ({
    id: row.id,
    ...row.values,
    authorized: true,
  })),
});
assert.equal(confirmed.status, "confirmed");
await assert.rejects(
  () =>
    imports.retry(inquiry.id, preview.id, {
      version: confirmed.version,
      requestId: randomUUID(),
      operator: "QA",
    }),
  (error) => error.status === 409,
);
const price = JSON.parse(rows(db, "SELECT data FROM price_resource")[0].data);
assert.equal(
  price.sourceDocument.fieldSources.unitPrice.excerpt,
  "Unit Price: 20.50",
);
console.log(
  "PASS: text source retained before model, original-file retry, concurrent retry dedup, CAS, immutable confirmed import and field provenance persisted",
);
const ocrCalls = [];
const recognized = await readOcr(
  Buffer.from("test"),
  "scan.png",
  "image/png",
  { baseURL: "https://ocr.example.test", apiKey: "test" },
  {
    fetchImpl: async (url, options) => {
      ocrCalls.push([url, options]);
      return {
        ok: true,
        json: async () => ({
          data: {
            result: {
              outputs: {
                json: {
                  pages: [
                    {
                      blocks: [
                        {
                          content:
                            "<table><tr><td>PN</td><td>PRICE</td></tr></table>",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        }),
      };
    },
  },
);
assert.equal(ocrCalls[0][0], "https://ocr.example.test/parse/sync");
assert.ok(recognized[0].text.includes("PN\tPRICE"));
assert.equal(await readOcr(Buffer.from("x"), "x.png", "image/png", null), null);
const scanStore = createSupplierImportStore(
  db,
  () => {},
  (id) => intake.detail(id),
  {
    semantic: async (chunks) =>
      extractSupplierSemantic(chunks, config, {
        fetchImpl: fetchResult(reply(chunks[0])),
      }),
    ocr: async () => [
      { locator: { page: 1, engine: "ocr" }, text: sourceText, format: "text" },
    ],
  },
);
const scan = await scanStore.create(inquiry.id, {
  requestId: randomUUID(),
  operator: "QA",
  name: "scan.png",
  mime: "image/png",
  base64: Buffer.from("mock-image").toString("base64"),
});
assert.equal(scan.rows.length, 1);
assert.deepEqual(scan.issues, []);
assert.equal(scan.sources[0].locator.engine, "ocr");
assert.equal(
  intake.detail(inquiry.id).files.find((file) => file.id === scan.fileId)
    .status,
  "parsed",
);
db.close();
console.log(
  "PASS: shared OCR adapter protocol and mocked image-to-source-to-supplier extraction (no real OCR provider claimed)",
);
