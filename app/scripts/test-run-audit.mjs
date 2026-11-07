import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/components/RunAuditReceipt.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const refs = [], calls = []; let cursor = 0, tree;
  const state = initial => { const index = cursor++; refs[index] ??= {current: initial}; return [refs[index].current, value => { refs[index].current = value; }]; };
  const modules = {'../engine/appUrl':{appFetch:(...args)=>context.fetch(...args)}, react: { useState: state, useRef: value => refs[cursor++] ??= {current: value}, useEffect() {} }, 'react/jsx-runtime': {jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props})} };
  const context = { exports: {}, require: name => modules[name], AbortController, encodeURIComponent, fetch: (url, options) => new Promise(resolve => calls.push({url, options, resolve})) };
  vm.runInNewContext(compiled, context);
  const render = () => { cursor = 0; tree = context.exports.RunAuditReceipt({runId: 'run/qa'}); };
  const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
  const text = n => n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(text).join('') : typeof n === 'object' ? text(n.props?.children) : String(n);
  render(); return {calls, render, load: () => nodes(tree).find(n=>n.type==='button').props.onClick(), text:()=>text(tree)};
}
const h = harness(); assert.equal(h.calls.length, 0, 'audit does not load until requested');
const loading = h.load(); h.load(); assert.equal(h.calls.length, 1, 'duplicate load guarded'); assert.equal(h.calls[0].url, '/api/agent/runs/run%2Fqa');
h.calls[0].resolve({ok: true, json: async()=>({runId:'run/qa',status:'needs_review',model:'test-model',inputFingerprint:'a'.repeat(64),costSnapshotFingerprint:'b'.repeat(64),resultFingerprint:'c'.repeat(64),events:[{tool:'lookup_costs',state:'done',detail:'1 row matched'}]})}); await loading; h.render(); assert.ok(h.text().includes('服务端记录')); assert.ok(h.text().includes('查询成本')); assert.ok(h.text().includes('1 row matched'));assert.ok(h.text().includes('输入指纹'));assert.ok(h.text().includes('aaaaaaaaaaaa…'));assert.ok(h.text().includes('成本快照指纹'));assert.ok(h.text().includes('结果指纹'));
const missing = harness(); const one=missing.load(); missing.calls[0].resolve({ok:false,status:404}); await one; missing.render(); assert.ok(missing.text().includes('未找到服务端审计记录'));
const retry=missing.load(); missing.calls[1].resolve({ok:true,json:async()=>({runId:'wrong',events:[]})});await retry;missing.render();assert.ok(missing.text().includes('未采用此结果'),'wrong run cannot appear as audit');
console.log('PASS: lazy server audit, duplicate guard, safe URL, persisted receipt display, 404 retry, run identity check.');
