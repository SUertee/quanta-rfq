import {fileURLToPath} from 'node:url';
// B9 评测集生成：案例2（净数据 Tab 表）本身即结构化真值，直接转 ground truth。
// 案例1（脏数据）无独立标注源，保留"未录入"，评测页显示未验证。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const emails = JSON.parse(readFileSync(fileURLToPath(new URL('../public/data/emails.json', import.meta.url)), 'utf-8'));
const email = emails.find((e) => e.id === 'case2-clean');
if (!email) throw new Error('找不到 case2-clean');

const lines = email.body.split(/\r?\n/).filter((l) => l.trim());
const headerIdx = lines.findIndex((l) => l.includes('Part Number') && l.includes('\t'));
const header = lines[headerIdx].split('\t');
const col = (name) => header.indexOf(name);
const get = (cells, name) => (col(name) >= 0 ? (cells[col(name)] ?? '').trim() : '');

const gtLines = [];
for (const line of lines.slice(headerIdx + 1)) {
  const cells = line.split('\t');
  if (cells.length < 5 || !get(cells, 'Part Number')) continue;
  gtLines.push({
    partNumber: get(cells, 'Part Number'),
    description: get(cells, 'Description'),
    quantity: Number(get(cells, 'Quantity')) || 0,
    uom: get(cells, 'Unit of Measure'),
    condition: get(cells, '件状条件'),
    mpn: get(cells, '询价MPN'),
    manualPn: get(cells, '手册件号'),
    productScope: get(cells, '产品范围'),
    dueDate: get(cells, 'Due Date'),
    flags: [],
  });
}

const out = {
  caseId: 'case2',
  inputKind: 'clean',
  emailId: 'case2-clean',
  lines: gtLines,
};
const dir = fileURLToPath(new URL('../public/data/eval', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'ground-truth-case2.json'), JSON.stringify(out));
console.log(`已生成 case2 评测集：${gtLines.length} 行`);