// 数据契约：与 docs/架构设计.md 第 4 节一致
export interface KanbanRow {
  rfqId: string; rfqNo: string; inquiryDate: string; airline: string;
  urgency: string; lineNo: number; partNumber: string; description: string;
  quantity: number; uom: string; requirement: string; mpn: string;
  condition: string; manualPn: string; productScope: string; dueDate: string;
}

export interface CostRow {
  partNumber: string; description: string; productScope: string; uom: string;
  stockQty: number; warehouse: string; stockCondition: string;
  stdCost: number; avgCost: number; lastPurchasePrice: number; currency: string;
  lastPurchaseDate: string; preferredSupplier: string; costUpdateDate: string;
  /** 自定义字段（字段不锁死，库存后端 extra JSON） */
  extra?: Record<string, unknown>;
}

export interface PriceRow {
  id: string; partNumber: string; supplierCode: string; supplierName: string;
  supplierType: string; country: string; condition: string; unitPrice: number;
  currency: string; fxToCny: number; moq: number; leadDays: number;
  inStock: string; certType: string; quoteDate: string; validUntil: string;
  statusLabel: string; remark: string;
  uom?:string;validFrom?:string;taxBasis?:string;authorized?:boolean;
}

export interface EmailSample {
  intakeBatchId?: string;
  intakeStatus?: string;
  intakeIssues?: string[];
  parsedRows?: import('./engine/parse').RawRow[];
  id: string; caseNo: number; file: string; subject: string;
  from: string; to: string; date: string; body: string; attachments: string[];
}

/** 官方 16 列 schema 的结构化询价行（看板字段为基准） */
export interface InquiryLine {
  key: string;
  source: string;
  rfqId: string;
  inquiryDate: string;
  customer: string;
  urgency: string;
  lineNo: number;
  partNumber: string;
  basePn: string;
  pnSuffix: string;
  description: string;
  quantity: number;
  uom: string;
  uomNormalized: string;
  uomFactor: number | null;
  requirement: string;
  mpn: string;
  condition: string;
  manualPn: string;
  productScope: string;
  dueDate: string;
  /** 报价回复截止与到货日期分别保存，含义不明的日期保留在 dueDate 待核对。 */
  quoteDeadline?: string;
  needByDate?: string;
  issues: string[];
  /** 该行经 LLM 归一并通过校验（审计标记） */
  llmFixedMark?: boolean;
  /** 该行经人工手动修改（AI 不可用或兜底，审计标记） */
  manualFixedMark?: boolean;
  resourceEvidence?:import('../shared/rfq-rules.mjs').RuleEvidence[];
}

export type FlagCode =
  | 'NO_MATCH' | 'UNIT_UNMAPPED' | 'COND_MISMATCH' | 'COND_EMPTY'
  | 'MOQ_SHORTAGE' | 'EXPIRED' | 'CERT_MISMATCH' | 'PARSE_ISSUE'
  | 'LATE_DELIVERY'
  | 'FX_DEMO' | 'PRICE_PENDING' | 'RESOURCE_REVIEW' | 'STOCK_SHORTAGE';

export interface PriceCandidate {
  row: PriceRow;
  cnyPrice: number;
  flags: FlagCode[];
}

/** 非标品成本估算：AI 市场估价或人工录入，依据链可回溯 */
export interface EstCost {
  value: number;
  source: 'ai' | 'manual';
  basis?: string;
  /** 联网取证的来源链接（元宝搜索） */
  refs?: { title: string; url: string }[];
  /** 可信度判定：有市场依据 / 有间接参考 / 纯经验估算（照妖镜分级法） */
  verdict?: '有市场依据' | '有间接参考' | '纯经验估算';
  /** 证据局限（如"外币需换算""非授权渠道""批量价"） */
  limitation?: string;
  /** 检索轨迹：搜索词与命中数（依据链可见） */
  trace?: { query: string; hits: number }[];
}

export interface PricedLine {
  ruleVersion?:string;
  basisCost?:number;
  basisSource?:string;
  basisId?:string;
  basisResource?:import('../shared/rfq-rules.mjs').RuleResource;
  ruleIssues?:string[];
  resourceChecks?:import('../shared/rfq-rules.mjs').ResourceCheck[];

  line: InquiryLine;
  matchLevel: 0 | 1 | 2 | 3;
  cost?: CostRow;
  candidates: PriceCandidate[];
  /** 因交期+货运超出需求日期被剔除的候选（保留展示，不参与报价） */
  excluded: PriceCandidate[];
  flags: FlagCode[];
}

export type ResourceEvidence = import('../shared/rfq-rules.mjs').RuleEvidence & {
  id:string;
  source_key:string;
  matched_at?:string;
  current_match?:import('../shared/rfq-rules.mjs').ResourceMatch;
  snapshot:import('../shared/rfq-rules.mjs').RuleResource & Record<string,unknown>;
};
