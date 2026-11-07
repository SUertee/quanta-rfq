/** Resolve only requested keys against server-owned inquiry lines. Never broaden line scope. */
export function resolveAgentScope(body, inquiry) {
  if (!inquiry || !Array.isArray(body.lines) || !body.lines.length) throw new Error('invalid inquiry scope');
  const authoritative = new Map(inquiry.lines.map(line => [`intake-${inquiry.id}-${line.lineNo}`, line]));
  const seen = new Set();
  const lines = body.lines.map(requested => {
    if (seen.has(requested.key)) throw new Error('duplicate line scope');
    seen.add(requested.key);
    const line = authoritative.get(requested.key);
    if (!line) throw new Error('line does not belong to inquiry');
    return { key:requested.key, partNumber:line.partNumber||'', description:line.description||'', quantity:line.quantity, uom:line.uom||'', condition:line.condition||'', urgency:line.priority||'', requirement:line.requirement||'', dueDate:line.dueDate||'' };
  });
  return { ...body, lines };
}
