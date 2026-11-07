import {z} from 'zod';
import {decodeFile} from './intake-parser.mjs';
import {getRuntimeConfig} from './runtime-config.mjs';
const schema=z.object({files:z.array(z.object({name:z.string().min(1).max(255),mime:z.string().max(120),base64:z.string().max(12_000_000)})).min(1).max(6)});
export async function readChatFiles(body){
 const {files}=schema.parse(body);let total=0;
 return {files:await Promise.all(files.map(async file=>{try{const bytes=Buffer.from(file.base64,'base64');total+=bytes.length;if(bytes.length>8*1024*1024||total>24*1024*1024)throw Error('附件大小超限');
 let text='';const isImage=/\.(png|jpe?g|webp)$/i.test(file.name);
 if(!isImage){const parsed=await decodeFile(file.name,bytes);if(parsed.unsupported)throw Error('暂不支持此文件格式');text=parsed.chunks.map(c=>c.text).join('\n');}
 if(isImage||(!text.trim()&&/\.pdf$/i.test(file.name))){const config=getRuntimeConfig().ocr;if(!config)throw Error('未配置OCR，图片或扫描件尚未读取');const form=new FormData();form.append('file',new Blob([bytes],{type:file.mime||'application/octet-stream'}),file.name);form.append('api_key',config.apiKey||'');form.append('output_formats','json');const response=await fetch(config.baseURL.replace(/\/$/,'')+'/parse/sync',{method:'POST',body:form,signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error('OCR读取失败，请重试或粘贴文字');const result=await response.json();const pages=result.data?.result?.outputs?.json?.pages;if(!Array.isArray(pages))throw Error('OCR未返回可读内容');text=pages.map(p=>(p.blocks||[]).map(b=>b.content||'').join('\n')).join('\n');}
 if(!text.trim())throw Error('未读取到文字内容');return {name:file.name,text:text.slice(0,12000),truncated:text.length>12000};
 }catch(e){return {name:file.name,error:e.message};}}))};
}
