// 迷你 PDF 文本提取：解 FlateDecode 流，抓 Tj/TJ 文本操作。仅覆盖有文本层的 PDF；
// 扫描件/复杂版式返回 ok:false，前端提示改用"复制文本粘贴"。
import zlib from 'node:zlib';

const decodePdfString = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const n = s[++i];
      if (n === 'n') out.push('\n');
      else if (n === 'r') out.push('\r');
      else if (n === 't') out.push('\t');
      else if (n === 'b' || n === 'f') out.push('');
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
        out.push(String.fromCharCode(parseInt(oct, 8)));
      } else out.push(n ?? '');
    } else out.push(ch);
  }
  return out.join('');
};

export function parsePdf(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const body = Buffer.from(m[1], 'latin1');
    let data = null;
    try { data = zlib.inflateSync(body); } catch { try { data = zlib.inflateRawSync(body); } catch { /* 未压缩 */ } }
    const text = (data ?? body).toString('latin1');
    for (const tm of text.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) chunks.push(decodePdfString(tm[1]));
    for (const tm of text.matchAll(/\[((?:\((?:\\.|[^\\()])*\)|[^\]])*)\]\s*TJ/g)) {
      for (const sm of tm[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) chunks.push(decodePdfString(sm[1]));
      chunks.push(' ');
    }
  }
  const out = chunks.join(' ').replace(/\s{2,}/g, ' ').trim();
  return {
    ok: out.length > 20,
    text: out.slice(0, 200000),
    note: out.length > 20 ? '已提取文本层，请核对字段后使用' : '未提取到文本层（扫描件或复杂版式），请复制 PDF 文本后粘贴导入',
  };
}