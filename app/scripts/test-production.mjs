import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
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
 const worker=(await readdir('dist/assets')).find(name=>name.startsWith('pdf.worker')&&name.endsWith('.mjs'));assert.ok(worker);const workerResponse=await fetch(origin+base+'assets/'+worker);assert.equal(workerResponse.status,200);assert.equal(workerResponse.headers.get('content-type'),'text/javascript; charset=utf-8');
 const asset=html.match(/src="([^"]+\.js)"/)[1];assert.ok(asset.startsWith(base+'assets/'));assert.equal((await fetch(origin+asset,{headers})).status,200);if(base!=='/'){assert.equal((await fetch(origin+'/api/agents',{headers})).status,404);const redirect=await fetch(origin+base.slice(0,-1)+'?workspace=1',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),base+'?workspace=1');}
 assert.equal((await fetch(origin+base+'api/agents',{headers})).status,200);
 assert.equal((await fetch(origin+base+'api/agents',{headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
 assert.equal((await fetch(origin+base+'.env.local',{headers})).status,404);
 assert.equal((await fetch(origin+base+'missing.js',{headers})).status,404);
 const upload=await fetch(origin+base+'api/inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'production-preview-01',files:[{name:'preview.txt',mime:'text/html',base64:Buffer.from('件号: TEST 数量: 1 单位: EA 件状: FN <script>alert(1)</script>').toString('base64')}]})});
 assert.equal(upload.status,200);const material=await upload.json();assert.equal(material.files.length,1);
 const reviewUrl=origin+base+'api/inquiries/'+material.id+'/extraction-review';
 const extractionReview=await fetch(reviewUrl);assert.equal(extractionReview.status,200);assert.equal(typeof (await extractionReview.json()).fingerprint,'string');
 assert.equal((await fetch(reviewUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:'null'})).status,400);
 assert.equal((await fetch(reviewUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fingerprint:'old'})})).status,409);
 assert.equal((await fetch(origin+base+'api/inquiries/missing/extraction-review')).status,404);
 await fetch(origin+base+'api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:material.id,action:'QA extraction review',detail:'Reviewed original'})});
 const records=await (await fetch(origin+base+'api/review?task=legacy-task-name&inquiry_id='+encodeURIComponent(material.id))).json();
 assert.ok(records.rows.some(row=>row.task===material.id&&row.action==='QA extraction review'));
 const streamedInput={requestId:'production-progress-01',files:[{name:'stages.csv',base64:Buffer.from('PN,Quantity,Unit,Condition\nAN3-5A,10,EA,FN').toString('base64')}]};
 const streamed=await fetch(origin+base+'api/inquiries',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify(streamedInput)});
 assert.equal(streamed.status,200);assert.match(streamed.headers.get('content-type'),/application\/x-ndjson/);
 const events=(await streamed.text()).trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(events.filter(event=>event.type==='progress').map(event=>event.stage),[1,2,3]);
 assert.equal(events.at(-1).type,'done');
 const retried=await (await fetch(origin+base+'api/inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(streamedInput)})).json();
 assert.equal(retried.id,events.at(-1).result.id);
 const preview=await fetch(origin+base+'api/files/'+material.files[0].id+'/preview');
 assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'text/plain; charset=utf-8');
 assert.ok(preview.headers.get('content-disposition').startsWith('inline;'));
 assert.equal(preview.headers.get('x-content-type-options'),'nosniff');
 assert.ok(preview.headers.get('content-security-policy').includes('sandbox'));
 assert.ok((await preview.text()).includes('<script>'));
 const download=await fetch(origin+base+'api/files/'+material.files[0].id+'/raw');
 assert.ok(download.headers.get('content-disposition').startsWith('attachment;'));
 console.log('PASS: inline preview preserves source bytes, MIME allowlist prevents HTML execution, original download remains available');
 console.log('PASS: production boot, health, anonymous assets/API without login challenge, origin rejection and hidden-file isolation');
}finally{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;await rm(dir,{recursive:true,force:true});}
