import assert from 'node:assert/strict';
import {validateQuoteReceipt} from '../server/quote-receipt.mjs';
const inquiry={id:'qa',issues:[],lines:[{lineNo:1,partNumber:'A',quantity:2,uom:'EA',condition:'FN',issues:[]}]};
const line={key:'intake-qa-1',pn:'A',requestedQty:2,qty:2,uom:'EA',condition:'FN',price:10,reviewed:true,skipped:false};
const input=(row=line)=>({inquiryId:'qa',orderId:'qa',kind:'客户版',total:20,content:JSON.stringify({schemaVersion:2,lines:[row]})});
assert.equal(validateQuoteReceipt(input(),inquiry).fingerprint.length,64);
assert.throws(()=>validateQuoteReceipt(input({...line,reviewed:false}),inquiry));
assert.throws(()=>validateQuoteReceipt(input({...line,price:null}),inquiry));
assert.throws(()=>validateQuoteReceipt(input({...line,requestedQty:999}),inquiry));
assert.throws(()=>validateQuoteReceipt(input(),{...inquiry,issues:['file failed']}));
assert.throws(()=>validateQuoteReceipt(input({...line,skipped:true}),inquiry));
console.log('PASS: reviewed snapshot accepted; missing review/price, stale scope, material failure and all-skipped rejected');
assert.throws(()=>validateQuoteReceipt(input({...line,quoteDeadline:'2000-01-01'}),{...inquiry,lines:[{...inquiry.lines[0],quoteDeadline:'2000-01-01'}]}),/报价截止日期/);
assert.equal(validateQuoteReceipt(input({...line,quoteDeadline:'2999-01-01',needByDate:'2999-02-01'}),{...inquiry,lines:[{...inquiry.lines[0],quoteDeadline:'2999-01-01',needByDate:'2999-02-01'}]}).fingerprint.length,64);
console.log('PASS: server export rechecks quotation deadline even when the saved price and human review are unchanged');

assert.throws(()=>validateQuoteReceipt(input({...line,quoteDeadline:'2999-01-01'}),inquiry),/询价要求已变更/);
