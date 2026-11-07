import {normalizePartNumber,normalizeUnit,validDate} from './normalization.mjs';

export const RFQ_RULE_VERSION='4';
export const businessToday=(now=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function quoteDeadlineExpired(value, asOf=businessToday(), now=Date.now()) {
  if (!validDate(value)) return false;
  if (value.length===10) return value<asOf;
  const timestamp=value.replace(' ','T');
  const zoned=/(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp)?timestamp:timestamp+'+08:00';
  const cutoff=Date.parse(zoned);
  return businessToday(now)===asOf?cutoff<now:businessToday(cutoff)<asOf;
}
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const rounded=value=>Math.round(value*100)/100;
const addDays=(date,days)=>new Date(Date.parse(date.slice(0,10)+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);

/** Full normalized PN identity is shared by browsing, persisted evidence and Agent input. */
export function matchResources(partNumber,costs=[],prices=[]) {
  const pn=normalizePartNumber(partNumber);
  if(!pn)return [];
  return [
    ...costs.filter(row=>normalizePartNumber(row.partNumber)===pn).map((row,index)=>({id:`inventory:${row.partNumber}:${index}`,source:'inventory',source_key:row.partNumber,snapshot:row})),
    ...prices.filter(row=>normalizePartNumber(row.partNumber)===pn).map(row=>({id:row.id,source:'supplier_price',source_key:row.id,snapshot:row})),
  ];
}

/** Evaluate each source independently. Unknown conditions remain visible and block automatic use. */
export function evaluateResource(line,resource,{source,sourceKey,asOf=businessToday(),condFnNe=false,certMutual=false,freightDays=0,fxRates={},unitConversions={}}={}) {
  const checks=[];
  const check=(code,state,message)=>checks.push({code,state,message});
  const compare=(code,wanted,supplied,label,compatible=false)=>{
    if(!wanted||!supplied)check(code,'unknown',`${label}缺失，需确认`);
    else check(code,wanted===supplied||compatible?'pass':'conflict',wanted===supplied||compatible?`${label}一致`:`${label}不一致`);
  };
  const pn=normalizePartNumber(line.partNumber),uom=normalizeUnit(line.uom),resourceUnit=normalizeUnit(resource.uom);
  compare('part_number',pn,normalizePartNumber(resource.partNumber),'完整件号');
  const factor=resourceUnit==='EA'&&uom!==resourceUnit?unitConversions[pn]?.[uom]:undefined;
  const converted=positive(factor);
  compare('unit',uom,resourceUnit,'单位',converted);
  const requestedCondition=String(line.condition||'').trim().toUpperCase();
  const suppliedCondition=String(resource.stockCondition||resource.condition||'').trim().toUpperCase();
  const interchangeable=condFnNe&&['FN','NE'].includes(requestedCondition)&&['FN','NE'].includes(suppliedCondition);
  compare('condition',requestedCondition,suppliedCondition,'件状',interchangeable);
  const validQuantity=positive(line.quantity);
  if(!validQuantity)check('requested_quantity','unknown','询价数量缺失或无效');
  if(uom==='EA'&&validQuantity&&!Number.isInteger(line.quantity))check('quantity_precision','unknown','按件计量的数量不是整数，需确认');
  const currency=String(resource.currency||'').trim().toUpperCase();
  const fx=currency==='CNY'?1:fxRates[currency];
  check('currency',positive(fx)?'pass':currency?'conflict':'unknown',positive(fx)?`${currency}计价${currency==='CNY'?'':'，使用配置汇率'}`:'币种缺失或需要汇率换算');
  const sourceCost=source==='inventory'?(positive(resource.lastPurchasePrice)?resource.lastPurchasePrice:resource.avgCost):resource.unitPrice;
  const cost=positive(sourceCost)&&positive(fx)?sourceCost*fx/(converted?factor:1):null;
  check('price',positive(cost)?'pass':'unknown',positive(cost)?'价格已提供':'缺少有效价格');
  const demand=converted?line.quantity/factor:line.quantity;
  if(source==='inventory'){
    const known=typeof resource.stockQty==='number'&&Number.isFinite(resource.stockQty)&&resource.stockQty>=0;
    const state=!validQuantity||!known?'unknown':resource.stockQty>=demand?'pass':'conflict';
    check('quantity',state,state==='pass'?'库存满足数量':state==='unknown'?'库存或需求数量未知':'库存不足，需确认供应能力');
  }else{
    const moq=resource.moq;
    const state=!validQuantity||!positive(moq)?'unknown':demand>=moq?'pass':'conflict';
    check('moq',state,state==='pass'?'满足起订量':state==='unknown'?'起订量或需求数量未知':'起订量不满足');
    for(const [field,code,label] of [['validFrom','valid_from','生效日期'],['validUntil','valid_until','有效期']]){
      const date=resource[field];
      if(!date||!validDate(date))check(code,'unknown',`${label}缺失或不明确`);
      else{const ok=field==='validFrom'?date.slice(0,10)<=asOf:date.slice(0,10)>=asOf;check(code,ok?'pass':'conflict',ok?`${label}满足`:field==='validFrom'?'报价尚未生效':'报价已过期');}
    }
    check('tax_basis',['inclusive','exclusive'].includes(resource.taxBasis)?'pass':'unknown',['inclusive','exclusive'].includes(resource.taxBasis)?'税基已明确':'税基待确认');
    check('authorization',resource.authorized===true?'pass':'unknown',resource.authorized===true?'来源授权已确认':'来源授权待确认');
  }
  const requirement=String(line.requirement||'').trim();
  const needFaa=/FAA|8130/i.test(requirement),needEasa=/EASA|Form\s*1/i.test(requirement)&&!/FAA\s*Form\s*1/i.test(requirement),needCoc=/\bCoC\b|合格证/i.test(requirement);
  if(needFaa||needEasa||needCoc){
    const cert=String(resource.certType||'');
    const faa=/FAA|8130/i.test(cert),easa=/EASA/i.test(cert),coc=/\bCoC\b|合格证/i.test(cert);
    const equivalent=certMutual&&/或等效|等价|equivalent/i.test(requirement)&&(faa||easa);
    const ok=(!needFaa||faa||equivalent)&&(!needEasa||easa||equivalent)&&(!needCoc||coc);
    check('certificate',!cert?'unknown':ok?'pass':'conflict',!cert?'证书信息缺失，需确认':ok?'证书类型满足要求':'证书类型不满足要求');
  }
  if(requirement&&(!(needFaa||needEasa||needCoc)||/追溯|寿命|批次|适航|序列|质保|trace|life|serial|warranty/i.test(requirement)))check('requirements','unknown','附加要求需逐项人工确认');
  const needBy=line.needByDate;
  if(needBy){
    const lead=source==='inventory'?0:resource.leadDays;
    const known=typeof lead==='number'&&Number.isFinite(lead)&&lead>=0&&Number.isFinite(freightDays)&&freightDays>=0;
    if(!validDate(needBy)||!known)check('delivery','unknown','需求日期或交期不明确，需确认');
    else{const arrival=addDays(asOf,lead+freightDays);const ok=arrival<=needBy.slice(0,10);check('delivery',ok?'pass':'conflict',ok?`预计 ${arrival} 到达，满足需求日期`:`预计 ${arrival} 到达，晚于需求日期`);}
  }
  if(line.dueDate)check('quote_date','unknown',validDate(line.dueDate)?'截止日期用途不明确，需人工确认':'日期格式不明确，需人工确认');
  if(line.quoteDeadline){
    const valid=validDate(line.quoteDeadline);
    const expired=valid&&quoteDeadlineExpired(line.quoteDeadline,asOf);
    check('quote_deadline',!valid?'unknown':expired?'conflict':'pass',!valid?'报价截止日期不明确，需确认':expired?'已超过报价截止日期':'报价截止日期有效');
  }
  const state=checks.some(item=>item.state==='conflict')?'conflict':checks.some(item=>item.state==='unknown')?'needs_review':'usable';
  return {source,sourceKey,matchMethod:'exact_part_number',state,checks,cost:positive(cost)?cost:null,asOf,ruleVersion:RFQ_RULE_VERSION,conversionFactor:converted?factor:1};
}

/** Inventory has priority. Otherwise use the lowest eligible supplier cost, with a stable ID tie-break. */
export function evaluateQuoteLine(line,resources,policy={}) {
  const candidates=resources.map(entry=>({...entry,match:evaluateResource(line,entry.snapshot,{...policy,source:entry.source,sourceKey:entry.source_key||entry.id})}));
  const inventory=candidates.filter(entry=>entry.source==='inventory');
  const eligible=candidates.filter(entry=>entry.match.state==='usable');
  const inventoryChoices=eligible.filter(entry=>entry.source==='inventory');
  const duplicateInventory=inventory.length>1;
  const suppliers=eligible.filter(entry=>entry.source!=='inventory'&&!policy.inventoryOnly).sort((a,b)=>a.match.cost-b.match.cost||String(a.id||a.source_key).localeCompare(String(b.id||b.source_key)));
  const selected=duplicateInventory||line.issues?.length?null:inventoryChoices[0]||suppliers[0]||null;
  const issues=selected?[]:line.issues?.length?[...line.issues]:policy.inventoryOnly&&!inventory.length?['本次仅使用内部成本，尚无可用库存依据']:duplicateInventory?['成本记录不唯一，需人工选择']:candidates.length?[...new Set(candidates.flatMap(entry=>entry.match.checks.filter(check=>check.state!=='pass').map(check=>check.message)))]:['未找到精确件号成本，需补充供应商报价'];
  return {candidates,selected,issues,ruleVersion:RFQ_RULE_VERSION};
}

/** One calculation implementation for client previews and server-generated drafts. */
export function calculateQuotePrice(cost,line,policy={}) {
  const costBase=positive(cost)?cost:undefined;
  const aogApplied=(policy.aogPremium??0.1)>0&&['AOG','USR','URGENT'].includes(String(line.urgency||'').toUpperCase());
  const bulkApplied=(policy.bulkQty??50)>0&&(policy.bulkDiscount??0.05)>0&&line.quantity>=(policy.bulkQty??50);
  const premium=aogApplied?1+(policy.aogPremium??0.1):1,discount=bulkApplied?1-(policy.bulkDiscount??0.05):1;
  const rate=policy.marginRate,markup=policy.markupRate??policy.margin??0.25;
  const validRate=rate==null?Number.isFinite(markup)&&markup>=0&&markup<=2:Number.isFinite(rate)&&rate>=0&&rate<1;
  const validFactors=Number.isFinite(premium)&&premium>=1&&Number.isFinite(discount)&&discount>=0&&discount<=1;
  const floorRate=policy.marginFloor??0.1;
  const rawTarget=costBase!=null&&validRate&&validFactors?(rate==null?costBase*(1+markup)*premium*discount:costBase*premium*discount/(1-rate)):undefined;
  return {costBase,target:positive(rawTarget)&&rounded(rawTarget)>0?rounded(rawTarget):undefined,
    floor:costBase!=null&&floorRate>=0&&floorRate<1?rounded(costBase*premium/(1-floorRate)):undefined,aogApplied,bulkApplied};
}

/** Customer freight is calculated once for previews and receipt validation. */
export function freightChargeFor(itemsTotal,policy={}) {
  if(itemsTotal<=0)return 0;
  if(policy.freeFreightOverCny>0&&itemsTotal>=policy.freeFreightOverCny)return 0;
  return Math.max(policy.freightChargeCny||0,policy.minFreightCny||0);
}
