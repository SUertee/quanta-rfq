// S4：人民币大小写金额（规则生成，不经 LLM；大小写一致性由此保证）
const DIGITS = '零壹贰叁肆伍陆柒捌玖';
const UNITS = ['', '拾', '佰', '仟'];
const GROUPS = ['', '万', '亿', '万亿'];

function fourToCn(n: number): string {
  let s = '';
  let zero = false;
  for (let i = 3; i >= 0; i--) {
    const d = Math.floor(n / 10 ** i) % 10;
    if (d === 0) {
      zero = s.length > 0;
    } else {
      if (zero) s += '零';
      s += DIGITS[d] + UNITS[i];
      zero = false;
    }
  }
  return s;
}

export function toChineseUpper(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '金额无效';
  if (amount === 0) return '零元整';
  let integer = Math.floor(amount);
  const cents = Math.round((amount - integer) * 100);
  let s = '';
  let gi = 0;
  while (integer > 0) {
    const g = integer % 10000;
    if (g > 0) s = fourToCn(g) + GROUPS[gi] + s;
    else if (s) s = '零' + s;
    integer = Math.floor(integer / 10000);
    gi++;
  }
  s = s.replace(/零+/g, '零').replace(/零$/, '') + '元';
  const jiao = Math.floor(cents / 10);
  const fen = cents % 10;
  if (jiao === 0 && fen === 0) return s + '整';
  if (jiao > 0) s += DIGITS[jiao] + '角';
  else if (fen > 0) s += '零';
  if (fen > 0) s += DIGITS[fen] + '分';
  return s;
}

export const fmtMoney = (n: number | undefined, currency = 'CNY') =>
  n == null ? '' : `${currency} ${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
