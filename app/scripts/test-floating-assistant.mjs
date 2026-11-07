import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(fs.readFileSync('src/components/FloatingAssistant.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const slots=[],effects=[],storage=new Map();let cursor=0,collapsed=0,opened=0;
const props={open:true,expanded:false,children:{originalConversation:true},onOpen(){opened++;props.open=true},onCollapse(){collapsed++;props.open=false}};
const context={exports:{},innerWidth:800,innerHeight:700,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},addEventListener(){},removeEventListener(){},require:n=>n==='react'?{useState:v=>{const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],x=>slots[i]=x]},useRef:v=>{const i=cursor++;return slots[i]??=( {current:v})},useEffect:f=>effects.push(f)}:{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}};
vm.runInNewContext(source,context);
const render=()=>{cursor=0;return context.exports.FloatingAssistant(props)};
let tree=render();const capture={setPointerCapture(){},hasPointerCapture(){return true},releasePointerCapture(){}};
const event=(x,y,orb=false)=>({clientX:x,clientY:y,pointerId:1,button:0,preventDefault(){},currentTarget:capture,target:{closest:s=>s==='[data-assistant-orb]'?(orb?{}:null):s==='.copilot-header'?{}:null}});
tree.props.onPointerDown(event(300,150));tree.props.onPointerMove(event(303,152));assert.equal(collapsed,0,'small movement must remain a click');
tree.props.onPointerMove(event(400,250));assert.equal(collapsed,1,'header drag collapses exactly once');tree=render();let capsule=tree.props.children[1],orb=capsule.props.children[0];assert.equal(capsule.props.style.left,374);assert.equal(capsule.props.style.top,224);
tree.props.onPointerMove(event(10000,-1000));tree=render();capsule=tree.props.children[1];orb=capsule.props.children[0];assert.equal(capsule.props.style.left,736);assert.equal(capsule.props.style.top,12,'drag cannot lose orb outside viewport');
tree.props.onPointerUp(event(10000,-1000));tree=render();orb=tree.props.children[1].props.children[0];orb.props.onClick();assert.equal(opened,0,'release after drag must not reopen');
tree.props.onPointerDown(event(740,30,true));tree.props.onPointerUp(event(740,30,true));tree.props.children[1].props.children[0].props.onClick();assert.equal(opened,1,'next deliberate click restores conversation');
tree=render();assert.equal(tree.props.children[0].props.children,props.children,'conversation remains mounted');assert.ok(storage.size,'dragged position remembered');
props.expanded=true;tree=render();tree.props.onPointerDown(event(100,100));tree.props.onPointerMove(event(200,200));assert.equal(collapsed,1,'expanded conversation is not dragged');
console.log('PASS: drag threshold, collapse once, viewport clamp, release click suppression, reopen, mounted conversation and saved position');

props.expanded=false;props.open=false;let sent='';props.onSend=text=>{sent=text};tree=render();tree.props.children[1].props.onMouseLeave();tree.props.children[1].props.onMouseEnter();tree=render();let form=tree.props.children[1];assert.equal(form.type,'form','hover exposes quick composer');form.props.children[1].props.onChange({target:{value:'如何生成报价单？'}});tree=render();form=tree.props.children[1];form.props.onSubmit({preventDefault(){}});assert.equal(sent,'如何生成报价单？','quick input submits once to conversation');
console.log('PASS: hover composer and quick-send handoff');

assert.equal(tree.props.children[1].props.style.width,340,'one shell widens to input');
tree.props.onPointerDown(event(740,30,true));tree.props.onPointerMove(event(755,45,true));tree=render();assert.equal(tree.props.children[1].props.style.width,52,'drag immediately collapses same shell');tree.props.onPointerUp(event(755,45,true));tree=render();tree.props.children[1].props.onMouseEnter();tree=render();assert.equal(tree.props.children[1].props.style.width,52,'release cannot expand until pointer leaves');tree.props.children[1].props.onMouseLeave();tree.props.children[1].props.onMouseEnter();tree=render();assert.equal(tree.props.children[1].props.style.width,340,'fresh hover expands again');
console.log('PASS: one-shell morph, drag collapse, release lock and re-hover');
