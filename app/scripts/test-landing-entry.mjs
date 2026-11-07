import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
const html=readFileSync(new URL('../public/quanta.html',import.meta.url),'utf8');
const script=html.match(/<script id="landing-entry-scroll">([\s\S]*?)<\/script>/)[1];
function open(hash='',reduced=false){
 const calls=[],events={},frames=[],replacements=[],sections=[];
 const location={hash,pathname:'/quanta-rfq/quanta.html',search:'?ref=test'};
 const history={state:{entry:'qa'},scrollRestoration:'auto',replaceState:(state,title,url)=>{replacements.push({state,url});location.hash='';}};
 const context={history,location,window:{scrollTo:opts=>calls.push(opts)},addEventListener:(name,fn)=>events[name]=fn,requestAnimationFrame:fn=>frames.push(fn),matchMedia:()=>({matches:reduced}),document:{addEventListener:(name,fn)=>events[name]=fn,getElementById:id=>['hero','statement','split'].includes(id)?{scrollIntoView:opts=>sections.push({id,...opts})}:null}};
 vm.runInNewContext(script,context);return {calls,events,frames,history,location,replacements,sections};
}
for(const hash of ['','#hero','#statement','#split']){
 const page=open(hash);assert.equal(page.history.scrollRestoration,'manual');assert.equal(page.location.hash,'');assert.equal(page.calls.length,1);assert.equal(page.calls[0].top,0);assert.equal(page.calls[0].behavior,'instant');
 if(hash){assert.equal(page.replacements[0].url,'/quanta-rfq/quanta.html?ref=test');assert.equal(page.replacements[0].state.entry,'qa');}
 page.events.pageshow({persisted:false});page.frames.shift()();assert.equal(page.calls.length,3);
 page.location.hash='#statement';page.events.pageshow({persisted:true});page.frames.shift()();assert.equal(page.calls.length,5);assert.equal(page.location.hash,'');
}
for(const reduced of [false,true]){
 const page=open('',reduced);let prevented=false;const event={button:0,target:{closest:()=>({getAttribute:()=>'#statement'})},preventDefault(){prevented=true;}};
 page.events.click(event);assert.equal(prevented,true);assert.equal(page.sections[0].id,'statement');assert.equal(page.sections[0].behavior,reduced?'instant':'smooth');assert.equal(page.location.hash,'');
 prevented=false;page.events.click({...event,ctrlKey:true});assert.equal(prevented,false,'modified clicks retain native browser behavior');
}
console.log('PASS: direct fragment URLs, reload and history restores reset to top and clear fragment; in-page navigation scrolls without adding a fragment; query/state and reduced motion preserved');
