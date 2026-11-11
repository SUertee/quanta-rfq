import type {CompanyInfo} from './company';

/** Fields belonging to one quotation, including its customer-facing terms. */
export interface QuoteDocument {
  customerName:string;
  quoteDate:string;
  deliveryTerms:string;
  company:CompanyInfo;
}
