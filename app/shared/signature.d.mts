export type SignaturePoint = [number,number];
export interface QuoteSignature {version:1;signer:string;signedAt:string;basis:string;strokes:SignaturePoint[][];}
export const SIGNATURE_WIDTH:number;
export const SIGNATURE_HEIGHT:number;
export function validateSignature(value:unknown,basis:string):QuoteSignature;
export function signaturePaths(strokes:SignaturePoint[][]):string[];
export function signatureSvg(value:QuoteSignature):string;
