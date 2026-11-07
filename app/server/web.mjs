import http from 'node:http';
import https from 'node:https';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {getRuntimeConfig} from './runtime-config.mjs';
const host=process.env.RFQ_WEB_HOST||'127.0.0.1',port=Number(process.env.RFQ_WEB_PORT||3000);
const base=process.env.RFQ_BASE_PATH||'/';
const root=fileURLToPath(new URL('../dist/',import.meta.url)),runtime=getRuntimeConfig();
await import('./index.mjs');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
function proxy(req,res,target,authorization){
 const headers={...req.headers,host:target.host};delete headers.authorization;delete headers.cookie;
 if(authorization)headers.authorization='Bearer '+authorization;
 const upstream=(target.protocol==='https:'?https:http).request(target,{method:req.method,headers},response=>{const out={...response.headers,'cache-control':'no-store','x-accel-buffering':'no'};delete out['set-cookie'];res.writeHead(response.statusCode||502,out);response.pipe(res);});
 upstream.setTimeout(240000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});if(!res.writableEnded)res.end(JSON.stringify({error:'上游服务暂时不可用'}));});res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});req.pipe(upstream);
}
http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');
 let url;try{url=new URL(req.url,'http://localhost');if(url.pathname.split('/').some(part=>decodeURIComponent(part).startsWith('.'))){res.writeHead(404);res.end();return;}}catch{res.writeHead(400);res.end();return;}
 if(base!=='/'&&url.pathname!=='/healthz'){
  if(url.pathname===base.replace(/\/$/,'')){res.writeHead(308,{Location:base+url.search});res.end();return;}
  if(!url.pathname.startsWith(base)){res.writeHead(404);res.end();return;}
  url.pathname='/'+url.pathname.slice(base.length);
 }
 if(url.pathname==='/healthz'){
  try{const r=await fetch(`http://127.0.0.1:${process.env.RFQ_PORT||3004}/api/agents`,{signal:AbortSignal.timeout(2000)});res.writeHead(r.ok?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:r.ok}));}catch{res.writeHead(503);res.end('{"ok":false}');}return;
 }
 const origin=req.headers.origin;
 const origins=new Set((process.env.RFQ_ALLOWED_ORIGINS||'').split(',').filter(Boolean));
 if(origin&&!origins.has(origin)){res.writeHead(403);res.end('Origin not allowed');return;}
 if(url.pathname.startsWith('/api/')){proxy(req,res,new URL(url.pathname+url.search,`http://127.0.0.1:${process.env.RFQ_PORT||3004}`));return;}
 if(url.pathname.startsWith('/llm/')){if(!runtime.model){res.writeHead(503);res.end('Model is not configured');return;}const target=new URL(runtime.model.baseURL.replace(/\/$/,'')+url.pathname.slice(4)+url.search);proxy(req,res,target,runtime.model.apiKey);return;}
 if(url.pathname.startsWith('/oxr/')){res.writeHead(503);res.end('Use the server-side document intake API for OCR');return;}
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
 try{let path=resolve(root,'.'+decodeURIComponent(url.pathname));if(path!==root.replace(/\/$/,'')&&!path.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(403);res.end();return;}
 try{if((await stat(path)).isDirectory())path=resolve(path,'index.html');}catch{if(extname(path)){res.writeHead(404);res.end();return;}path=resolve(root,'index.html');}
 const data=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':url.pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-store'});res.end(req.method==='HEAD'?undefined:data);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,host,()=>console.log(`Quanta production web listening on ${host}:${port}`));
