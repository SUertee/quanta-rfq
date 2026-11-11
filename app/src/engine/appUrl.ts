import {expireAuth,getAuth} from '../auth';

/** Keep application-owned requests under the configured project base path. */
export function projectUrl(path:string,base:string){return `${base.replace(/\/$/,'')}/${path.replace(/^\//,'')}`;}
export function appUrl(path:string){return projectUrl(path,import.meta.env?.BASE_URL||'/');}

/**
 * 统一请求入口：/api/* 自动注入 Authorization（登录接口除外），
 * 响应 401 视为会话失效——清场并广播，由 App 回登录页。
 */
export function appFetch(input:RequestInfo|URL,init?:RequestInit){
 const target=typeof input==='string'&&input.startsWith('/')&&!input.startsWith('//')?appUrl(input):input;
 const apiRequest=typeof input==='string'&&input.startsWith('/api/');
 const loginRequest=typeof input==='string'&&input.startsWith('/api/auth/login');
 const token=apiRequest?getAuth()?.token:undefined;
 const request=token?{...init,headers:(()=>{const headers=new Headers(init?.headers);headers.set('Authorization',`Bearer ${token}`);return headers;})()}:init;
 return globalThis.fetch(target,request).then(response=>{
  if(apiRequest&&!loginRequest&&response.status===401)expireAuth();
  return response;
 });
}

/** Download protected originals through the same authenticated request path. */
export async function downloadAppFile(path:string,name:string){
 const response=await appFetch(path);
 if(!response.ok)throw new Error('文件下载失败，请重新登录或重试');
 const url=URL.createObjectURL(await response.blob());
 const link=document.createElement('a');link.href=url;link.download=name;
 document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
