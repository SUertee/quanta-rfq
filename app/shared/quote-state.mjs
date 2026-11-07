/** Object insertion order cannot change a quote version or create a false conflict. */
export function canonicalJson(value){
  return JSON.stringify(value,(_key,current)=>current&&typeof current==='object'&&!Array.isArray(current)?Object.fromEntries(Object.keys(current).sort().map(key=>[key,current[key]])):current);
}
