import assert from 'node:assert/strict';
import {resolveAgentScope} from '../server/agent-scope.mjs';
const inquiry={id:'qa',lines:[{lineNo:1,partNumber:'A',quantity:2,uom:'EA',condition:'FN'},{lineNo:2,partNumber:'B',quantity:3,uom:'EA',condition:'FN'}]};
const r=resolveAgentScope({lines:[{key:'intake-qa-2',partNumber:'FAKE',quantity:999}],instruction:'only selected'},inquiry);
assert.equal(r.lines.length,1);assert.equal(r.lines[0].partNumber,'B');assert.equal(r.lines[0].quantity,3);
assert.throws(()=>resolveAgentScope({lines:[{key:'intake-other-1'}]},inquiry));
assert.throws(()=>resolveAgentScope({lines:[{key:'intake-qa-1'},{key:'intake-qa-1'}]},inquiry));
assert.throws(()=>resolveAgentScope({lines:[]},inquiry));
console.log('PASS: one-line scope is never widened; spoofed fields replaced; unknown/duplicate/empty scope rejected');
