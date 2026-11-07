import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {buildDraft,validateAgentInput} from '../server/agent.mjs';
async function load(entry){const b=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm'});return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`)}
const {DEFAULT_POLICY,suggestPrice,repriceBook}=await load('src/engine/pricingPolicy.ts');
const {quoteGate,orderTotalOf}=await load('src/engine/export.ts');
const cost={partNumber:'TEST',lastPurchasePrice:100,currency:'CNY',stockQty:1000,uom:'EA',stockCondition:'FN'};
for(const [urgency,quantity] of [['',1],['AOG',1],['',50],['USR',50]]){
 const line={key:'one',partNumber:'TEST',quantity,uom:'EA',condition:'FN',urgency};
 const policy={...DEFAULT_POLICY,aogPremium:.2,bulkDiscount:.08,bulkQty:50};
 const input=validateAgentInput({instruction:'生成报价草稿',lines:[line],policy:{markupRate:policy.margin,aogPremium:policy.aogPremium,bulkDiscount:policy.bulkDiscount,bulkQty:policy.bulkQty}});
 assert.equal(buildDraft(input,[cost]).lines[0].suggestedPrice,suggestPrice({line,cost,candidates:[],flags:[]},policy).target,'Agent and workbench use same urgency/bulk rules');
}
const lines=['one','manual','skipped'].map(key=>({line:{key,quantity:1,urgency:''},cost,candidates:[],flags:[]}));
const pb={otherTask:77,one:1,manual:123,skipped:888};
const {next}=repriceBook(lines,pb,new Set(['manual']),new Set(['skipped']),DEFAULT_POLICY,{});
assert.equal(next.otherTask,77);assert.equal(next.manual,123);assert.equal(next.skipped,888);assert.equal(next.one,125);
for(const invalid of [0,-1,NaN,Infinity])assert.equal(quoteGate([lines[0]],{one:invalid},new Set(),new Set()).ok,false);
assert.equal(quoteGate(lines,{one:125,manual:123},new Set(),new Set(['skipped'])).ok,true);
assert.equal(orderTotalOf(lines,{priceBook:pb,skipped:new Set(['skipped']),policy:DEFAULT_POLICY}),124,'skipped rows excluded from totals');
console.log('PASS: pricing parity for urgent/bulk cases, reprice preserves other tasks/manual/skipped, export gates reject invalid prices, skipped totals excluded.');

const {priceLine}=await load('src/engine/pricing.ts');
const moqDemand={key:'moq-test',partNumber:'TEST',basePn:'TEST',quantity:10,uom:'EA',uomNormalized:'EA',condition:'FN',issues:[],requirement:'',inquiryDate:'2026-11-07',dueDate:'',mpn:'',manualPn:''};
const moqSupplier={id:'moq-resource',partNumber:'TEST',unitPrice:100,currency:'CNY',fxToCny:1,moq:50,condition:'FN',validUntil:'2027-01-01',inStock:'是',leadDays:1};
const stockDataset=stock=>({costIdx:new Map([['TEST',stock]]),priceIdx:new Map([['TEST',[moqSupplier]]])});
const covered=priceLine(moqDemand,stockDataset(cost));
assert.ok(!covered.flags.includes('MOQ_SHORTAGE'),'matching internal stock does not inherit supplier MOQ');
assert.ok(covered.candidates[0].flags.includes('MOQ_SHORTAGE'),'supplier candidate retains its own MOQ warning');
for(const patch of [{stockQty:0},{uom:'BOX'},{stockCondition:'OH'},{partNumber:'TEST-ALT'}]) {
 assert.ok(priceLine(moqDemand,stockDataset({...cost,...patch})).flags.includes('MOQ_SHORTAGE'),'nonmatching or insufficient stock cannot suppress supplier MOQ');
}
console.log('PASS: supplier MOQ stays candidate-specific when exact internal stock covers demand');
