/** Keep application-owned requests under the configured project base path. */
export function projectUrl(path:string,base:string){return `${base.replace(/\/$/,'')}/${path.replace(/^\//,'')}`;}
export function appUrl(path:string){return projectUrl(path,import.meta.env?.BASE_URL||'/');}
export function appFetch(input:RequestInfo|URL,init?:RequestInit){
 const target=typeof input==='string'&&input.startsWith('/')&&!input.startsWith('//')?appUrl(input):input;
 return globalThis.fetch(target,init);
}
