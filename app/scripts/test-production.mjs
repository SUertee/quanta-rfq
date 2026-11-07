import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import net from 'node:net';
const free=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const base=process.env.TEST_BASE_PATH||'/';
const web=await free(),api=await free(),dir=await mkdtemp(join(tmpdir(),'rfq-production-')),origin=`http://127.0.0.1:${web}`;
const child=spawn(process.execPath,['server/web.mjs'],{env:{...process.env,RFQ_BASE_PATH:base,RFQ_WEB_PORT:String(web),RFQ_PORT:String(api),RFQ_DB_PATH:join(dir,'test.sqlite'),RFQ_ALLOWED_ORIGINS:origin},stdio:'ignore'});
try{
 let healthy=false;for(let i=0;i<80;i++){try{healthy=(await fetch(origin+'/healthz')).ok;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,100));}assert.ok(healthy,'production server boot');
 const anonymous=await fetch(origin+base);assert.equal(anonymous.status,200);assert.equal(anonymous.headers.get('www-authenticate'),null);assert.equal((await fetch(origin+base+'api/agents')).status,200);
 const headers={};
 const aircraft=await fetch(origin+base+'images/aviation-takeoff.jpg');assert.equal(aircraft.status,200);assert.equal(aircraft.headers.get('content-type'),'image/jpeg');const aircraftBytes=new Uint8Array(await aircraft.arrayBuffer());assert.equal(aircraftBytes[0],0xff);assert.equal(aircraftBytes[1],0xd8);

 const page=await fetch(origin+base+'?workspace=1',{headers});assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('href="'+base+'images/brand/quanta-mark.svg"'),'favicon respects deployment base');
 for(const name of ['quanta-logo-light.svg','quanta-logo-dark.svg']){const logo=await fetch(origin+base+'images/brand/'+name);assert.equal(logo.status,200);assert.equal(logo.headers.get('content-type'),'image/svg+xml');assert.ok((await logo.text()).includes('<path'));}
 const asset=html.match(/src="([^"]+\.js)"/)[1];assert.ok(asset.startsWith(base+'assets/'));assert.equal((await fetch(origin+asset,{headers})).status,200);if(base!=='/'){assert.equal((await fetch(origin+'/api/agents',{headers})).status,404);const redirect=await fetch(origin+base.slice(0,-1)+'?workspace=1',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),base+'?workspace=1');}
 assert.equal((await fetch(origin+base+'api/agents',{headers})).status,200);
 assert.equal((await fetch(origin+base+'api/agents',{headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
 assert.equal((await fetch(origin+base+'.env.local',{headers})).status,404);
 assert.equal((await fetch(origin+base+'missing.js',{headers})).status,404);
 console.log('PASS: production boot, health, anonymous assets/API without login challenge, origin rejection and hidden-file isolation');
}finally{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;await rm(dir,{recursive:true,force:true});}
