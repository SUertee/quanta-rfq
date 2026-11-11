import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

const window = new Window({ url: 'http://127.0.0.1:5176/', width: 1280, height: 900 });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Node', 'Event', 'MouseEvent', 'localStorage', 'location']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const temporary = new URL('./.price-resources-test.mjs', import.meta.url);
const bundle = await build({ stdin: { contents: "export {PriceResourcesPage} from './src/pages/PriceResourcesPage';", resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, outdir: '/tmp/quanta-price-test', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ BASE_URL: '/' }) } });
writeFileSync(temporary, bundle.outputFiles.find(file => file.path.endsWith('.js')).text);
const { PriceResourcesPage } = await import(temporary.href);
unlinkSync(temporary);
let rows = Array.from({ length: 23 }, (_, i) => ({ id: `price-${i}`, partNumber: `AN-${i}`, supplierName: 'Aero Supplier', unitPrice: 12.5, currency: 'CNY', validUntil: i === 0 ? '2020-01-01' : '2099-12-31', account_id: 'owner-2', extra: { legacy: 'preserved' } }));
let failSave = false;
let failDelete = false;
let lastSave;
globalThis.fetch = async (path, options = {}) => {
  if (options.method === 'POST') {
    lastSave = JSON.parse(options.body);
    if (failSave) return { ok: false };
    rows = rows.map(row => row.id === lastSave.row.id ? lastSave.row : row);
    return { ok: true };
  }
  if (options.method === 'DELETE') {
    if (failDelete) return { ok: false };
    rows = rows.filter(row => !path.endsWith(row.id));
    return { ok: true };
  }
  return { ok: true, json: async () => ({ prices: rows }) };
};
const host = document.createElement('div');
document.body.append(host);
const style = document.createElement('style');
style.textContent = ['src/styles.css', 'src/workspace-controls.css', 'src/pages/price-resources.css'].map(path => readFileSync(path, 'utf8')).join('\n').replaceAll('@media(', '@media (');
document.head.append(style);
document.body.className = 'layout-reference';
const root = createRoot(host);
const click = async node => act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const submit = async () => act(async () => { host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
await act(async () => { root.render(React.createElement(PriceResourcesPage, { ds: { fieldSchema: undefined }, onRefresh() {} })); });
assert.equal(host.querySelectorAll('tbody tr').length, 20);
assert.match(host.querySelector('.table-pagination').textContent, /23/);
await click(host.querySelector('[aria-label="下一页"]'));
assert.equal(host.querySelectorAll('tbody tr').length, 3);
await click(host.querySelectorAll('.filter-tabs button')[1]);
assert.equal(host.querySelectorAll('tbody tr').length, 1);
await click(host.querySelector('.price-row-actions button'));
assert.equal(host.querySelector('dialog').open, true);
assert.equal(host.querySelectorAll('.price-fields input').length, 12);
failSave = true;
await submit();
assert.equal(host.querySelector('dialog').open, true, 'failed saves retain the form');
assert.match(host.querySelector('[role="alert"]').textContent, /保存失败/);
assert.equal(lastSave.accountId, 'owner-2', 'master edits preserve resource ownership');
assert.equal(lastSave.row.extra.legacy, 'preserved');
failSave = false;
await submit();
assert.equal(host.querySelector('dialog'), null);
await click(host.querySelectorAll('.price-row-actions button')[1]);
failDelete = true;
await click(host.querySelector('.app-dialog-actions .primary'));
assert.ok(host.querySelector('dialog'), 'failed deletes retain confirmation');
assert.match(host.querySelector('[role="alert"]').textContent, /删除失败/);
failDelete = false;
await click(host.querySelector('.app-dialog-actions .primary'));
assert.equal(host.querySelector('dialog'), null);
await click(host.querySelector('.record-tools .primary'));
await submit();
assert.match(host.querySelector('[role="alert"]').textContent, /件号/);
for (const width of [320, 390, 768, 1280]) {
  window.happyDOM.setViewport({ width, height: 900 });
  style.textContent += '\n';
  assert.equal(window.getComputedStyle(host.querySelector('.price-fields')).gridTemplateColumns, width <= 550 ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))');
  assert.equal(window.getComputedStyle(host.querySelector('.price-records .table-wrap')).overflowX, 'auto');
}
await act(async () => root.unmount());
await window.happyDOM.close();
console.log('Supplier quote pagination, filtering, editor, failure recovery, ownership, and responsive layout passed.');
