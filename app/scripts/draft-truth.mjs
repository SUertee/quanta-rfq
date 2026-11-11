// 生成 case1 候选真值（仅供人工逐行复核，不是已验证真值）：
// 输出 candidate-truth-case1.json，人工修正后另存为 ground-truth-case1.json 即可被评测页读取。
// 红线：不得把候选文件当已验证成绩，文档与文件内均标注 _needsHumanReview。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const emails = JSON.parse(readFileSync('d:/project/zidongbaojia/app/public/data/emails.json', 'utf-8'));
const email = emails.find((e) => e.id === 'case1-dirty');
if (!email) throw new Error('找不到 case1-dirty');

const built = await build({ entryPoints: ['src/engine/parse.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseEmailBody } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const { rows } = parseEmailBody(email);

const lines = rows.map((r) => ({
  partNumber: r.partNumber ?? '',
  description: r.description ?? '',
  quantity: r.quantity ?? 0,
  uom: r.uom ?? '',
  condition: r.condition ?? '',
  mpn: r.mpn ?? '',
  manualPn: r.manualPn ?? '',
  productScope: r.productScope ?? '',
  dueDate: r.dueDate ?? '',
  flags: r.issues?.length ? ['PARSE_ISSUE'] : [],
}));

const out = {
  caseId: 'case1',
  inputKind: 'dirty',
  emailId: 'case1-dirty',
  _needsHumanReview: true,
  _note: '候选真值：由当前解析器+LLM归一生成，仅供人工逐行复核；确认后另存为 ground-truth-case1.json。不得直接作为评测成绩依据。',
  lines,
};
const dir = 'd:/project/zidongbaojia/app/public/data/eval';
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'candidate-truth-case1.json'), JSON.stringify(out, null, 2));
console.log(`已生成候选真值 ${lines.length} 行 → ${join(dir, 'candidate-truth-case1.json')}（_needsHumanReview=true，需人工复核后另存为 ground-truth-case1.json）`);
