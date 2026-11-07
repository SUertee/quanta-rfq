export const RFQ_RULE_VERSION:string;
export function businessToday():string;
export interface RuleLine {issues?:string[];dueDate?:string|null;partNumber?:string|null;quantity?:number|null;uom?:string|null;condition?:string|null;requirement?:string|null;needByDate?:string|null;urgency?:string|null;}
export interface RuleResource {partNumber?:string;uom?:string;stockCondition?:string;condition?:string;currency?:string;lastPurchasePrice?:number;avgCost?:number;unitPrice?:number;stockQty?:number;moq?:number;validFrom?:string;validUntil?:string;taxBasis?:string;authorized?:boolean;certType?:string;leadDays?:number;}
export interface RulePolicy {inventoryOnly?:boolean;source?:string;sourceKey?:string;asOf?:string;condFnNe?:boolean;certMutual?:boolean;freightDays?:number;fxRates?:Record<string,number>;unitConversions?:Record<string,Record<string,number>>;margin?:number;markupRate?:number;marginRate?:number;marginFloor?:number;aogPremium?:number;bulkDiscount?:number;bulkQty?:number;}
export interface ResourceCheck {code:string;state:'pass'|'unknown'|'conflict';message:string;}
export interface ResourceMatch {source?:string;sourceKey?:string;matchMethod:string;state:'usable'|'needs_review'|'conflict';checks:ResourceCheck[];cost:number|null;asOf:string;ruleVersion:string;conversionFactor:number;}
export interface RuleEvidence {id?:string;source:string;source_key?:string;snapshot:RuleResource;}
export interface EvaluatedEvidence extends RuleEvidence {match:ResourceMatch;}
export function evaluateResource(line:RuleLine,resource:RuleResource,policy?:RulePolicy):ResourceMatch;
export function evaluateQuoteLine(line:RuleLine,resources:RuleEvidence[],policy?:RulePolicy):{candidates:EvaluatedEvidence[];selected:EvaluatedEvidence|null;issues:string[];ruleVersion:string};
export function calculateQuotePrice(cost:number|null|undefined,line:RuleLine,policy?:RulePolicy):{costBase:number|undefined;target:number|undefined;floor:number|undefined;aogApplied:boolean;bulkApplied:boolean};

export function matchResources(partNumber:unknown,costs?:RuleResource[],prices?:(RuleResource & {id:string})[]):RuleEvidence[];
