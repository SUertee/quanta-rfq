/** Resolve only requested keys against server-owned inquiry lines. Never broaden line scope. */
export function resolveAgentScope(body, inquiry, savedQuote) {
  if (!inquiry || !Array.isArray(body.lines) || !body.lines.length) throw new Error('invalid inquiry scope');
  const authoritative = new Map(inquiry.lines.map(line => [`intake-${inquiry.id}-${line.lineNo}`, line]));
  const seen = new Set();
  const lines = body.lines.map(requested => {
    if (seen.has(requested.key)) throw new Error('duplicate line scope');
    seen.add(requested.key);
    const line = authoritative.get(requested.key);
    if (!line) throw new Error('line does not belong to inquiry');
    return { selectedBasisId:savedQuote?.state?.lines.find(entry=>entry.key===requested.key)?.selectedBasisId||undefined,key:requested.key, partNumber:line.partNumber||'', description:line.description||'', quantity:line.quantity, uom:line.uom||'', condition:line.condition||'', urgency:line.priority||'', requirement:line.requirement||'', dueDate:line.dueDate||'',needByDate:line.needByDate||'',quoteDeadline:line.quoteDeadline||'',customFields:line.customFields||{},issues:line.issues||[] };
  });
  const policy=savedQuote?.state?.policy;
  return { ...body, lines,...(policy?{policy:{condFnNe:policy.condFnNe,certMutual:policy.certMutual,freightDays:policy.freightDays,fxRates:{...(policy.fxUsd?{USD:policy.fxUsd}:{}),...(policy.fxEur?{EUR:policy.fxEur}:{}),...policy.fxRates},markupRate:policy.margin,aogPremium:policy.aogPremium,bulkDiscount:policy.bulkDiscount,bulkQty:policy.bulkQty}}:{}) };
}
