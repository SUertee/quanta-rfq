import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { normalizeLine, normalizePartNumber, validDate, normalizeQuantity } from '../server/normalization.mjs';
import { evaluateResource } from '../server/resource-match.mjs';
import { initIntake, createIntakeService, rows } from '../server/intake.mjs';
import { buildDraft } from '../server/agent.mjs';
const input={partNumber:' an3-5a-alt ',quantity:'1,000',uom:'Each',condition:'fn',dueDate:'11/12/2026'};
const line=normalizeLine(input,{contentId:'fragment',method:'column_mapping'});
assert.equal(line.partNumber,'AN3-5A-ALT');assert.equal(line.quantity,1000);assert.equal(line.uom,'EA');
assert.equal(line.rawFields.partNumber,input.partNumber);assert.equal(line.fieldSources.uom.contentId,'fragment');
assert.ok(line.issues.includes('日期格式不明确，需人工确认'));
assert.notEqual(normalizePartNumber('AN3-5A-ALT'),normalizePartNumber('AN3-5A'));
assert.equal(validDate('2026-02-30'),false);assert.equal(validDate('2028-02-29'),true);
const SQL=await initSqlJs();const db=new SQL.Database();
db.run('CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)');
db.run("INSERT INTO inventory VALUES(' an3-5a ','EA',2000,14.37,'CNY','FN')");
initIntake(db);const service=createIntakeService(db,()=>{},{});
const request={requestId:'normalize-request-01',files:[{name:'parts.csv',base64:Buffer.from('件号,数量,单位,件状\nan3-5a,2,Each,fn').toString('base64')}]};
const inquiry=await service.create(request);const saved=inquiry.lines[0];
assert.equal(inquiry.files[0].document_type,'customer_inquiry');assert.equal(saved.uom,'EA');assert.equal(saved.rawFields.uom,'Each');
assert.equal(saved.evidence.length,1);assert.equal(saved.evidence[0].snapshot.match.state,'usable');
assert.equal(rows(db,'SELECT part_number FROM inquiry_line')[0].part_number,'AN3-5A');
assert.equal((await service.create(request)).id,inquiry.id);
initIntake(db);assert.equal(service.detail(inquiry.id).lines[0].version,saved.version);
const updated=service.updateLine(inquiry.id,saved.id,{version:saved.version,patch:{uom:'each',condition:'sv'},operator:'tester'}).lines[0];
assert.equal(updated.condition,'SV');assert.equal(updated.rawFields.condition,'fn');assert.equal(updated.fieldSources.condition.operator,'tester');
assert.equal(updated.evidence[0].current_match.state,'conflict');
assert.throws(()=>service.updateLine(inquiry.id,saved.id,{version:saved.version,patch:{quantity:3}}),/刷新/);
const supplier={partNumber:'AN3-5A',uom:'EA',condition:'FN',currency:'CNY',unitPrice:10,moq:1,validFrom:'2026-01-01',validUntil:'2027-01-01',taxBasis:'exclusive',authorized:true};
const demand={partNumber:'AN3-5A',quantity:2,uom:'EA',condition:'FN'};
const options={source:'supplier_price',sourceKey:'supplier-1',asOf:'2026-11-07'};
assert.equal(evaluateResource(demand,supplier,options).state,'usable');
assert.equal(evaluateResource({...demand,quantity:null},supplier,options).state,'needs_review');
for(const patch of [{validUntil:'2020-01-01'},{validFrom:'2027-01-01'},{validUntil:'2026-99-01'},{moq:10},{uom:'BOX'},{condition:'NE'},{authorized:false},{taxBasis:null},{currency:'USD'}]) assert.notEqual(evaluateResource(demand,{...supplier,...patch},options).state,'usable');
assert.equal(evaluateResource({...demand,requirement:'FAA 8130'},supplier,options).state,'needs_review');
const unknown=await service.create({...request,requestId:'unknown-role-01',files:[{...request.files[0],document_type:'certificate'}]});
assert.equal(unknown.lines.length,0);assert.ok(unknown.issues.some(issue=>issue.includes('单独分类')));
await assert.rejects(()=>service.create({...request,requestId:'bad-role-01',files:[{...request.files[0],document_type:'bad'}]}),/资料类型/);
const price=buildDraft({instruction:'生成草稿',lines:[{...demand,key:'one'}]},[{partNumber:' an3-5a ',stockQty:3,uom:'Each',stockCondition:'FN',currency:'CNY',lastPurchasePrice:14.37}]);
assert.equal(price.lines[0].suggestedPrice,17.96);
console.log('PASS: raw and normalized fields, source locations, document roles, repeat uploads, revision conflict, exact suffix matching, indexed lookup, dates and candidate gates');

// Simulate pre-migration fields and ensure effective changes invalidate versioned work.
const before = rows(db, 'SELECT fields,version FROM inquiry_line WHERE id=?', [saved.id])[0];
const oldFields = { ...JSON.parse(before.fields), partNumber: 'an3-5a', uom: 'Each' };
db.run('UPDATE inquiry_line SET fields=? WHERE id=?', [JSON.stringify(oldFields), saved.id]);
db.run("DELETE FROM schema_migration WHERE id='normalization-v2'");
initIntake(db);
assert.equal(service.detail(inquiry.id).lines[0].version, before.version + 1);
assert.ok(rows(db, "SELECT id FROM line_revision WHERE line_id=? AND operator='normalization_migration'", [saved.id]).length);
initIntake(db);
assert.equal(service.detail(inquiry.id).lines[0].version, before.version + 1);
assert.equal(Buffer.from(service.rawFile(inquiry.files[0].id).raw).toString(), Buffer.from(request.files[0].base64,'base64').toString());
console.log('PASS: migration preserves originals, records revisions, invalidates changed lines and is idempotent');

for (const raw of ['1,5','1e3','0x10','1.000']) assert.equal(normalizeQuantity(raw),null);
assert.equal(normalizeQuantity('1,000'),1000);assert.equal(normalizeQuantity('10.5'),10.5);
assert.ok(normalizeLine({partNumber:'A',quantity:1.5,uom:'EA',condition:'FN'}).issues.length);
assert.equal(evaluateResource({...demand,quantity:null},supplier,options).checks.find(c=>c.code==='moq').message,'起订量或需求数量未知');
assert.equal(service.detail(inquiry.id).status,'needs_input');
service.refresh(inquiry.id);
assert.ok(!service.detail(inquiry.id).issues.includes('标准字段已更新，请刷新依据'));

for (const [quantity, expected] of [['1,000',1000],['1,5',null],['1e3',null],['1 000',null]]) {
  const text = `件号: AN3-5A 数量: ${quantity} 单位: EA 件状: FN`;
  const parsed = await service.create({requestId:`labeled-quantity-${quantity}`,files:[{name:'quantity.txt',base64:Buffer.from(text).toString('base64')}]});
  assert.equal(parsed.lines[0].quantity,expected);
  assert.equal(parsed.lines[0].rawFields.quantity,quantity);
  if (expected===null) assert.ok(parsed.lines[0].issues.includes('缺少有效数量'));
}
console.log('PASS: labeled text preserves complete quantity tokens, standard thousands parse, ambiguous and scientific quantities stay unresolved');

const {extractSemantic}=await import('../server/intake-extract.mjs');
const semanticResult=await extractSemantic([{id:'number-fragment',text:'件号 A 数量 1 000 EA 件状 FN'}],{apiKey:'test',baseURL:'https://example.invalid',model:'offline'},{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({lines:[{contentId:'number-fragment',partNumber:'A',quantity:1,uom:'EA',condition:'FN'}]})}}]})})});
assert.equal(semanticResult.lines[0].quantity,null);
console.log('PASS: semantic validation cannot use a partial space-separated quantity as numeric evidence');
