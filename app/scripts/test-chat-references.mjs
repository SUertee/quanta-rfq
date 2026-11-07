import assert from 'node:assert/strict';
import {resolveChatReferences,referenceContext} from '../server/chat-references.mjs';
const privateMarker=['qa','excluded','metadata'].join('-');
const inquiry={id:'q1',title:'航空询价',files:[{id:'file1',name:'RFQ.txt'}],contents:[{id:'c1',file_id:'file1',locator:{line:2},text:'件号 AN3-5A 数量 10 单位 EA 件状 FN'}],lines:[{id:'l1',contentId:'c1',version:2,partNumber:'AN3-5A',quantity:10,uom:'EA',condition:'FN',evidence:[{id:'e1',source:'inventory',source_key:'AN3-5A',matched_at:'2026-11-08',snapshot:{partNumber:'AN3-5A',lastPurchasePrice:14.37,stockQty:100,currency:'CNY',extra:{apiKey:privateMarker}}}]}]};
const detail=id=>id==='q1'?inquiry:null;
const reference={id:'ref',label:'物料',excerpt:'伪造成本 0.01',inquiryId:'q1',lineId:'l1',contentId:'c1',version:2};
const resolved=resolveChatReferences([reference],detail,{inquiryId:'q1'});
assert.ok(resolved[0].text.includes('AN3-5A'));
assert.ok(!resolved[0].text.includes('0.01'),'client excerpt cannot override server facts');
assert.equal(resolved[0].inquiryTitle,'航空询价');
const evidence=resolveChatReferences([{...reference,evidenceId:'e1',matchedAt:'2026-11-08'}],detail);
assert.ok(evidence[0].text.includes('14.37'));
assert.ok(!evidence[0].text.includes(privateMarker));
for(const patch of [{inquiryId:'other'},{lineId:'other'},{contentId:'other'},{version:1},{evidenceId:'other'},{evidenceId:'e1',matchedAt:'old'}]){
 assert.throws(()=>resolveChatReferences([{...reference,...patch}],detail),error=>error.status===409);
}
assert.throws(()=>resolveChatReferences([reference],detail,{inquiryId:'another'}),error=>error.status===409);
assert.throws(()=>resolveChatReferences([{id:'plain',label:'引用',excerpt:'x',lineId:'l1'}],detail),error=>error.status===409);
assert.throws(()=>resolveChatReferences(Array(7).fill(reference),detail),error=>error.status===400);
assert.throws(()=>resolveChatReferences([{...reference,excerpt:'x'.repeat(2001)}],detail),error=>error.status===400);
assert.equal(resolveChatReferences([{id:'plain',label:'选中文字',excerpt:'普通询价文本'}],detail)[0].text,'普通询价文本');
assert.ok(referenceContext('文件内容',resolved).includes('引用材料'));
assert.ok(referenceContext('x'.repeat(24000),resolved).length<=24000);
assert.equal(referenceContext('原内容',[]),'原内容');
assert.throws(()=>referenceContext('',[{label:'过长',text:'x'.repeat(18000)}]),error=>error.status===400);
console.log('PASS: references resolve server facts, reject stale/cross-inquiry/forged identifiers, omit private fields and enforce count/context limits');
