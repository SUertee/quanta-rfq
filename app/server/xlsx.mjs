// 迷你 xlsx 解析器：零依赖（zip 容器 + XML 正则），覆盖常规单表 xlsx/csv。
// 支持：sharedStrings（含富文本）、inlineStr、数字/文本/布尔、空单元格（按列引用归位）、多 sheet 取第一个。
import zlib from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65580; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（zip）文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeEnt = (s) =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const textOf = (xml) =>
  decodeEnt([...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(''));

function colIdx(ref) {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(files) {
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const m = wb.match(/<sheet[^>]*r:id="([^"]+)"/);
  if (m) {
    const r = rels.match(new RegExp(`<Relationship[^>]*Id="${m[1]}"[^>]*Target="([^"]+)"`));
    if (r) return r[1].startsWith('xl/') ? r[1] : `xl/${r[1].replace(/^\//, '')}`;
  }
  return 'xl/worksheets/sheet1.xml';
}

/** xlsx Buffer → { headers, rows }（首行为表头；空字段为空串） */
export function parseXlsx(buf) {
  const files = unzip(buf);
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (ss) for (const m of ss.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textOf(m[1]));

  const sheetPath = files.has(firstSheetPath(files)) ? firstSheetPath(files) : [...files.keys()].find((k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k));
  const sheet = (sheetPath ? files.get(sheetPath) : null)?.toString('utf8') ?? '';
  const grid = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row = [];
    let seq = 0; // 无 r= 引用时按顺序归位
    for (const cm of rm[1].matchAll(/<(?:\w+:)?c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const idx = ref ? colIdx(ref) : seq;
      seq = idx + 1;
      const t = (attrs.match(/t="([^"]+)"/) || [])[1] ?? 'n';
      const body = cm[2] ?? '';
      let v = '';
      if (t === 's') v = shared[Number((body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1])] ?? '';
      else if (t === 'inlineStr') v = textOf(body);
      else v = decodeEnt((body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1] ?? '');
      row[idx] = String(v).trim();
    }
    grid.push(row);
  }
  const width = Math.max(0, ...grid.map((r) => r.length));
  const norm = grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const headers = (norm[0] ?? []).map(String);
  const rows = norm.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
  return { headers, rows };
}

/** csv Buffer → { headers, rows }（UTF-8，逗号/制表符，引号转义） */
export function parseCsv(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const lines = [];
  let cur = [''];
  let inQ = false;
  const push = () => { lines.push(cur); cur = ['']; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur[cur.length - 1] += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === '\t') cur.push('');
    else if (ch === '\n' || ch === '\r') {
      if (cur.length > 1 || cur[0] !== '') push();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else cur[cur.length - 1] += ch;
  }
  if (cur.length > 1 || cur[0] !== '') push();
  const headers = (lines[0] ?? []).map((h) => h.trim());
  const rows = lines.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, rows };
}

/** 统一入口：按扩展名解析 */
export function parseSheet(fileName, buf) {
  if (/\.csv$/i.test(fileName)) return parseCsv(buf);
  return parseXlsx(buf);
}
