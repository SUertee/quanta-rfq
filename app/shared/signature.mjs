import {validDate} from './normalization.mjs';

export const SIGNATURE_WIDTH = 640;
export const SIGNATURE_HEIGHT = 180;

/** Accept only bounded vector points, never caller-provided SVG or HTML. */
export function validateSignature(value, basis) {
  if (!value || value.version !== 1 || typeof value.signer !== 'string' || !value.signer.trim() || value.signer.length > 80) throw new Error('请填写签署人');
  if (!/^[a-f0-9]{64}$/.test(value.basis || '') || value.basis !== basis) throw new Error('报价已变化，请重新签名');
  if (!validDate(value.signedAt) || !value.signedAt.includes('T')) throw new Error('签名时间无效');
  if (!Array.isArray(value.strokes) || !value.strokes.length || value.strokes.length > 50) throw new Error('请在签名区书写');
  let count = 0, distance = 0;
  const strokes = value.strokes.map(stroke => {
    if (!Array.isArray(stroke) || stroke.length < 2) throw new Error('请完成签名笔画');
    return stroke.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] < 0 || point[0] > SIGNATURE_WIDTH || point[1] < 0 || point[1] > SIGNATURE_HEIGHT || ++count > 2500) throw new Error('签名笔画无效或过长');
      if (index) distance += Math.hypot(point[0] - stroke[index - 1][0], point[1] - stroke[index - 1][1]);
      return point.map(number => Math.round(number * 10) / 10);
    });
  });
  if (distance < 15) throw new Error('请在签名区完整书写');
  return {version:1, signer:value.signer.trim(), signedAt:value.signedAt, basis:value.basis, strokes};
}

export function signaturePaths(strokes) {
  return strokes.map(stroke => stroke.map(([x,y],index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' '));
}

export function signatureSvg(value) {
  const signature = validateSignature(value,value.basis);
  const paths = signaturePaths(signature.strokes).map(path => `<path d="${path}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}" role="img" aria-label="授权签名"><g fill="none" stroke="#102440" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
}
