import assert from 'node:assert/strict';import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/engine/appUrl.ts'],bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.env':JSON.stringify({BASE_URL:'/quanta-rfq/'})}});const {appUrl,appFetch,downloadAppFile}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
assert.equal(appUrl('/api/inquiries'),'/quanta-rfq/api/inquiries');assert.equal(appUrl('quanta.html'),'/quanta-rfq/quanta.html');const calls=[];globalThis.fetch=(input,init)=>{calls.push([input,init]);return Promise.resolve({ok:true});};await appFetch('/api/assistant/chat',{method:'POST'});await appFetch('/data/cost.json');await appFetch('https://example.com/api');assert.equal(calls[0][0],'/quanta-rfq/api/assistant/chat');assert.equal(calls[0][1].method,'POST');assert.equal(calls[1][0],'/quanta-rfq/data/cost.json');assert.equal(calls[2][0],'https://example.com/api');console.log('PASS: project-relative API, static data, navigation and unchanged external URLs');

const browserStorage=new Map([['quanta-auth',JSON.stringify({token:'fixture-token',account:{id:'fixture-account'}})]]);
globalThis.localStorage={getItem:key=>browserStorage.get(key)||null};
const anchors=[];
globalThis.document={body:{appendChild(){}},createElement(){const link={click(){anchors.push({href:this.href,download:this.download});},remove(){}};return link;}};
globalThis.fetch=async(input,init)=>{calls.push([input,init]);return new Response(new Blob(['original-bytes'],{type:'text/plain'}));};
await downloadAppFile('/api/files/fixture/raw','original.txt');
assert.equal(calls.at(-1)[0],'/quanta-rfq/api/files/fixture/raw');
assert.equal(calls.at(-1)[1].headers.get('Authorization'),'Bearer fixture-token');
assert.equal(anchors[0].download,'original.txt');
assert.ok(anchors[0].href.startsWith('blob:'));
console.log('PASS: private original downloads retain project base and Authorization without placing tokens in URLs');
