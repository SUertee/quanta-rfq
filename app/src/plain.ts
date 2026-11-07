// 业务语言映射：技术概念 → 供应链人话
import type { FlagCode } from './types';

export const FLAG_PLAIN: Record<FlagCode, string> = {
  RESOURCE_REVIEW: '报价依据仍有条件待确认',
  STOCK_SHORTAGE: '库存不足，需确认供应能力',
  NO_MATCH: '查不到这个件号的价格依据',
  UNIT_UNMAPPED: '单位需要人工确认换算',
  COND_MISMATCH: '货源件状与客户要求不一致',
  COND_EMPTY: '件状信息缺失',
  MOQ_SHORTAGE: '数量低于供应商最小起订量',
  EXPIRED: '价格已过有效期',
  CERT_MISMATCH: '证书不满足客户要求',
  PARSE_ISSUE: '这一行没读准，请对照原邮件核对',
  LATE_DELIVERY: '所有货源送达都晚于客户要货日期，请与客户协商交期',
  FX_DEMO: '外币已按参考汇率折算',
  PRICE_PENDING: '等待您定价',
};

/** 行状态：可报 / 需核对 */
export const LINE_STATUS = {
  ok: { label: '可报价', tone: 'green' as const },
  check: { label: '需核对', tone: 'amber' as const },
};

export const SOURCE_PLAIN: Record<string, string> = {
  email: '询价邮件',
  kanban: '历史询价',
};
