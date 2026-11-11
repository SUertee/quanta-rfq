import {accountStorageKey} from './persistence';
// A6 企业资料：报价单必填信息 + 条款默认值（存本机浏览器）
export interface CompanyInfo {
  name: string;
  address: string;
  creditCode: string;
  contact: string;
  /** 操作人（写处理记录用） */
  operator: string;
  /** 条款名称（行业无关，默认"质保期"；食品可改"保质期"） */
  warrantyLabel: string;
  /** 质保/保质期（月），主要件 / 其他件状 */
  warrantyNew: string;
  warrantyOh: string;
  /** 报价有效期（天） */
  validityDays: string;
  /** 附加条款模板（每行一条，追加到客户版报价单末尾；空则不出） */
  termsTemplate?: string;
}

const LS = 'rfq-company-v1';

export const DEFAULT_COMPANY: CompanyInfo = {
  name: '',
  address: '',
  creditCode: '',
  contact: '',
  operator: '报价员',
  warrantyLabel: '质保期',
  termsTemplate: '',
  warrantyNew: '12',
  warrantyOh: '6',
  validityDays: '30',
};

export function getCompany(): CompanyInfo {
  try {
    const raw = localStorage.getItem(accountStorageKey(LS));
    if (!raw) return DEFAULT_COMPANY;
    return { ...DEFAULT_COMPANY, ...(JSON.parse(raw) as Partial<CompanyInfo>) };
  } catch {
    return DEFAULT_COMPANY;
  }
}

export function saveCompany(c: CompanyInfo): void {
  localStorage.setItem(accountStorageKey(LS), JSON.stringify(c));
}