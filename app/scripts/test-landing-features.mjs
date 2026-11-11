import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const html = readFileSync('public/quanta.html', 'utf8');
const window = new Window();
window.document.body.innerHTML = html;
const grid = window.document.querySelector('.logos');
const stages = [...grid.querySelectorAll('.logo-cell')];
assert.equal(stages.length, 6);
assert.deepEqual(stages.map(stage => stage.textContent.trim()), [
  '接收询价', '提取需求', '查询依据', '检查条件', '报价草稿', '确认导出',
]);
assert.equal(grid.querySelectorAll('button, a, [tabindex], [aria-pressed]').length, 0);
assert.equal(window.document.querySelectorAll('.feature-flip-back').length, 0);
assert.ok(!html.includes('landing-features.js'));
assert.ok(window.document.getElementById('stmt'));
assert.ok(window.document.getElementById('flight-plane'));
await window.happyDOM.close();
console.log('PASS: six static stage labels without interactive controls or flip previews');
