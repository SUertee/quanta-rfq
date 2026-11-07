// A6 企业资料：报价单必填信息 + 条款默认值（存本机浏览器）
export interface CompanyInfo {
  name: string;
  address: string;
  creditCode: string;
  contact: string;
  /** 操作人（写处理记录用） */
  operator: string;
  /** 质保期（月），新件 / OH 件 */
  warrantyNew: string;
  warrantyOh: string;
  /** 报价有效期（天） */
  validityDays: string;
}

const LS = 'rfq-company-v1';

export const DEFAULT_COMPANY: CompanyInfo = {
  name: '',
  address: '',
  creditCode: '',
  contact: '',
  operator: '报价员',
  warrantyNew: '12',
  warrantyOh: '6',
  validityDays: '30',
};

export function getCompany(): CompanyInfo {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULT_COMPANY;
    return { ...DEFAULT_COMPANY, ...(JSON.parse(raw) as Partial<CompanyInfo>) };
  } catch {
    return DEFAULT_COMPANY;
  }
}

export function saveCompany(c: CompanyInfo): void {
  localStorage.setItem(LS, JSON.stringify(c));
}