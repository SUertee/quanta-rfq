import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../public/quanta.html',import.meta.url),'utf8');
const script=html.match(/<script id="landing-entry-scroll">([\s\S]*?)<\/script>/)[1];
function open(hash=''){
 const calls=[],events={},frames=[],history={scrollRestoration:'auto'};
 const context={history,location:{hash},window:{scrollTo:opts=>calls.push(opts)},addEventListener:(name,fn)=>events[name]=fn,requestAnimationFrame:fn=>frames.push(fn)};
 vm.runInNewContext(script,context);return {calls,events,frames,history};
}
const page=open();assert.equal(page.history.scrollRestoration,'manual');assert.equal(page.calls.length,1);assert.equal(page.calls[0].top,0);assert.equal(page.calls[0].behavior,'instant');
page.events.pageshow({persisted:false});page.frames.shift()();assert.equal(page.calls.length,3);
page.events.pageshow({persisted:true});page.frames.shift()();assert.equal(page.calls.length,5);
for(const hash of ['#hero','#statement','#split']){const linked=open(hash);linked.events.pageshow({persisted:false});linked.frames.shift()();assert.equal(linked.calls.length,0,'explicit section links must not be sent back to the hero');}
console.log('PASS: landing entry/reload/history reset to top, instant scroll and explicit section links preserved');
