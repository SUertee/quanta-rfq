import type { InquiryLine } from '../types';

export const validUnitPrice = (value: number | undefined): value is number =>
  value != null && Number.isFinite(value) && value > 0;

export const validInquiryLine = (line: InquiryLine): boolean =>
  Boolean(line.partNumber.trim() && line.uom.trim()) &&
  Number.isFinite(line.quantity) && line.quantity > 0;
