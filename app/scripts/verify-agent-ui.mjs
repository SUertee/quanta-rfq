import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(fs.readFileSync(new URL('../src/pages/AgentPage.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const streamModule={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/engine/chatStream.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:streamModule,TextDecoder,Error});
function harness(overrides={}){
 const store={'rfq-chat-v1':overrides.initialSessions||{}},refs=[],requests=[],intakes=[];let cursor=0,tree,writes=0,uploads=0;
 const props={tasks:[{key:'task1',title:'QA',source:{kind:'email',id:'qa'},total:1}],ds:{},policy:{margin:.25},lineEdits:{},resolved:new Set(),priceBook:{},estCost:{},onNewInquiry(){uploads++},onOpenTask(){},onOpenSettings(){},onSelectTask(){},setPriceBook(){writes++},setResolved(){writes++},setEstCost(){writes++}};
 Object.assign(props,overrides);
 const modules={'../components/ChatMaterials':{ChatMaterialPurpose:()=>null,ChatSupplierFlow:()=>null,ChatSupplierResult:()=>null},'../engine/chatMaterials':{chatMaterialRoute:()=>overrides.materialRoute||(overrides.enableIntake?'inquiry':'question')},'../engine/chatIntake':{shouldCreateChatInquiry:()=>!!overrides.enableIntake,submitChatInquiry:async(request)=>{intakes.push(request);return overrides.createdBatch;}},'../components/ChatInquiryReceipt':{ChatInquiryReceipt:()=>null,chatInquiryResult:batch=>({...batch,fileCount:batch.files.length,lineCount:batch.lines.length})},'../engine/chatReferences':{conversationReferences:(drafts)=>drafts.length?drafts:overrides.inheritedReferences||[]},'../components/ChatReferences':{ReferenceList:()=>null,useChatReferences:()=>({items:[],clear(){},composer:null})},'../engine/amount':{fmtMoney:(n,c='CNY')=>n==null?'':`${c} ${n}`},'../engine/chatStream':streamModule,'../engine/useChatScroll':{useChatScroll:()=>({containerRef:{current:null},onScroll(){},follow:{current:true}})},'../engine/appUrl':{appFetch:(...args)=>context.fetch(...args)},'../components/ChatAttachmentPreview':{ChatAttachmentPreview:()=>null},'../components/ChatMarkdown':{ChatMarkdown:()=>null},'../components/ChatFiles':{ChatFiles:()=>null},'../components/ExecutionSteps':{ExecutionSteps:()=>null},'../components/MessageRail':{MessageRail:()=>null},react:{useState:v=>{const i=cursor++;refs[i]??={current:v};return[refs[i].current,a=>{refs[i].current=a}]},useEffect(){},useMemo:f=>f(),useRef:v=>refs[cursor++]??={current:v}},'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},'../engine/persistence':{useStoredState:(k,v)=>{store[k]??=v;return[store[k],a=>{store[k]=typeof a==='function'?a(store[k]):a}]}},'../task':{linesOf:ds=>({email:overrides.email,lines:ds.testLines||[{key:'line1',partNumber:'TEST',quantity:2,uom:'EA'}]})},'../engine/pricing':{priceAll:lines=>lines.map(line=>({line})),isYellow:()=>true}};
 const context={exports:{},require:n=>{assert.ok(modules[n],n);return modules[n]},performance,crypto,AbortController,fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))};vm.runInNewContext(source,context);
 function render(){cursor=0;tree=context.exports.AgentPage(props)}
 function nodes(n){if(!n||typeof n!=='object')return[];if(Array.isArray(n))return n.flatMap(nodes);return[n,...nodes(n.props?.children)]}
 function text(n){if(n==null||typeof n==='boolean')return'';if(Array.isArray(n))return n.map(text).join('');return typeof n==='object'?text(n.props?.children):String(n)}
 const button=name=>{const b=nodes(tree).find(n=>n.type==='button'&&text(n)===name);assert.ok(b,name);return b.props};
 render();return{render,button,events:()=>nodes(tree).filter(n=>n.props?.className==='rfq-response-event'),intakes,files:()=>nodes(tree).find(n=>n.props?.excerptLimit===1400)?.props,uploads:()=>uploads,dialog:()=>nodes(tree).some(n=>n.props?.role==='dialog'),input:()=>nodes(tree).find(n=>n.type==='textarea').props,requests,props,session:()=>store['rfq-chat-v1'][props.selectedLineKey?`task1:line:${props.selectedLineKey}`:'task1'],writes:()=>writes,text:()=>text(tree),respond:(i,mode='draft',status='needs_review')=>requests[i].resolve({ok:true,json:async()=>({runId:'qa',status,summary:'QA draft',model:'test',draft:{mode,lines:[{key:'line1',partNumber:'TEST',quantity:2,cost:10,suggestedPrice:12.5,currency:'CNY',issues:[]}],questions:[]},events:[]})})};
}
const h=harness();
h.button('＋ 上传询价').onClick();assert.equal(h.uploads(),1,'upload invokes actual import callback');
h.button('报价草稿').onClick();h.render();assert.equal(h.dialog(),true,'draft opens accessible drawer');h.button('关闭 ×').onClick();h.render();assert.equal(h.dialog(),false);
h.input().onChange({target:{value:'生成草稿'}});h.render();
const first=h.button('↑').onClick();h.button('↑').onClick();assert.equal(h.requests.length,1,'duplicate send guarded');assert.equal(JSON.parse(h.requests[0].options.body).policy.markupRate,.25,'Settings cost markup is sent as markupRate');assert.equal('marginRate' in JSON.parse(h.requests[0].options.body).policy,false,'legacy margin field must not change Settings markup into gross margin');h.render();h.button('停止').onClick();assert.equal(h.requests[0].options.signal.aborted,true);h.respond(0);await first;h.render();assert.equal(h.session().state,'stopped');assert.equal(h.session().turns.filter(t=>t.role==='assistant').length,0,'late result discarded');
h.input().onChange({target:{value:'检查缺口'}});h.render();const second=h.button('↑').onClick();h.respond(1);await second;h.render();assert.equal(h.session().state,'idle');assert.equal(h.writes(),0,'conversation cannot write prices or approve risks');assert.equal(h.session().turns.length,3,'user and assistant turns persist');
h.input().onChange({target:{value:'这些成本来自哪里'}});h.render();let prevented=false;
h.input().onCompositionStart();h.input().onKeyDown({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false},keyCode:13,preventDefault(){prevented=true}});assert.equal(prevented,false,'IME confirm must not send');h.input().onCompositionEnd();
h.input().onKeyDown({key:'Enter',shiftKey:true,nativeEvent:{isComposing:false},keyCode:13,preventDefault(){prevented=true}});assert.equal(prevented,false,'Shift Enter must insert newline');
const third=h.button('↑').onClick();assert.equal(JSON.parse(h.requests[2].options.body).history.length,3,'followup sends previous task context');h.props.lineEdits={line1:{quantity:5}};h.render();h.respond(2);await third;h.render();assert.equal(h.session().state,'failed');assert.equal(h.session().turns.filter(t=>t.role==='assistant').length,1,'edited input cannot adopt old result');assert.ok(h.text().includes('旧询价记录'));assert.ok(h.text().includes('还没有报价草稿'),'old basis does not remain current draft');
h.input().onChange({target:{value:'重新检查'}});h.render();const fourth=h.button('↑').onClick();assert.equal(JSON.parse(h.requests[3].options.body).history.length,0,'changed inquiry excludes old context');h.respond(3);await fourth;h.render();assert.equal(h.writes(),0);
const analysis=harness();analysis.input().onChange({target:{value:'只检查缺口'}});analysis.render();const analyzed=analysis.button('↑').onClick();analysis.respond(0,'analysis');await analyzed;analysis.render();assert.ok(analysis.text().includes('缺口清单'),'analysis has its own structured result');assert.ok(analysis.text().includes('还没有报价草稿'),'analysis never masquerades as quote');
console.log('PASS: duplicate send, cancellation/late result, read-only turns, real history, basis isolation, IME and Shift Enter.');

const accepted=[];
const scoped=harness({ds:{testLines:[{key:'line1',partNumber:'TEST',quantity:2,uom:'EA'},{key:'line2',partNumber:'OTHER',quantity:4,uom:'EA'}]},embedded:true,selectedLineKey:'line1',onApplyPrice:(line,price)=>accepted.push({line,price})});
scoped.input().onChange({target:{value:'生成本行报价'}});scoped.render();
const scopedRun=scoped.button('↑').onClick();
assert.equal(JSON.parse(scoped.requests[0].options.body).lines.length,1,'line scope sends only selected line');
scoped.respond(0);await scopedRun;scoped.render();
assert.equal(accepted.length,0,'generation never applies a price');
scoped.button('接受建议单价').onClick();assert.equal(accepted.length,1,'explicit click applies one suggestion');assert.equal(accepted[0].price,12.5);
scoped.props.priceBook={line1:12.5};scoped.render();assert.ok(scoped.text().includes('已填入单价'));scoped.props.priceBook={};
scoped.props.lineEdits={line1:{quantity:9}};scoped.render();assert.equal(scoped.button('接受建议单价').disabled,true,'changed line cannot accept stale quote');
scoped.props.selectedLineKey=null;scoped.render();assert.ok(!scoped.text().includes('QA draft'),'whole-task session is separate from line session');
console.log('PASS: embedded line scope, explicit price acceptance, stale-price rejection and whole-task isolation.');

const greeting=harness();greeting.input().onChange({target:{value:'你好你能做什么'}});greeting.render();const greetingRun=greeting.button('↑').onClick();assert.equal(greeting.requests[0].url,'/api/assistant/chat');greeting.requests[0].resolve(new Response('{"type":"delta","text":"可以帮助核对询价。"}\n{"type":"done","answer":"可以帮助核对询价。"}\n'));await greetingRun;assert.equal(greeting.session().turns.at(-1).content,'可以帮助核对询价。');assert.equal(greeting.session().turns.at(-1).result,undefined);console.log('PASS: selected-inquiry greeting streams as chat without a false failed quotation artifact');

const failedRun=harness();
failedRun.input().onChange({target:{value:'生成报价草稿'}});failedRun.render();
const failedReply=failedRun.button('↑').onClick();failedRun.respond(0,'analysis','failed');await failedReply;failedRun.render();
assert.equal(failedRun.session().state,'failed');
assert.ok(failedRun.text().includes('本次处理未完成，请重新发送'));
console.log('PASS: incomplete tool result keeps the chat in a recoverable failure state');

const noLines=harness({ds:{testLines:[]},initialSessions:{task1:{state:'idle',input:'',turns:[{role:'assistant',content:'已接收原件，尚未提取物料。'}]}}});
noLines.input().onChange({target:{value:'接下来要补什么？'}});noLines.render();
assert.equal(noLines.button('↑').disabled,false);
const explainEmpty=noLines.button('↑').onClick();
assert.equal(noLines.requests[0].url,'/api/assistant/chat');
assert.equal(JSON.parse(JSON.parse(noLines.requests[0].options.body).context).lineCount,0);
noLines.requests[0].resolve(new Response('{"type":"delta","text":"请在工作台核对原文并补全物料。"}\n{"type":"done","answer":"请在工作台核对原文并补全物料。"}\n'));await explainEmpty;
assert.equal(noLines.session().state,'idle');
console.log('PASS: received inquiry with zero extracted lines can still ask for clarification without invoking quotation tools');

const received=[];
const bound=harness({enableIntake:true,createdBatch:{id:'new-inquiry',title:'bound.csv',status:'evidence_ready',files:[{}],lines:[{partNumber:'TEST',issues:[]}],issues:[]},onInquiryCreated:(batch,key)=>received.push({batch,key})});
bound.files().onChange([{id:'bound-file',name:'bound.csv',status:'ready'}]);bound.render();
await bound.button('↑').onClick();bound.render();
assert.equal(bound.requests.length,0,'bound attachments use formal intake instead of an excerpt-only quotation run');
assert.equal(bound.intakes.length,1);assert.equal(bound.intakes[0].instruction,'');assert.equal(received[0].key,'task1');
assert.equal(bound.session().turns.at(-1).inquiry.id,'new-inquiry');
assert.equal(bound.session().creation,undefined);
console.log('PASS: already-bound assistant creates a formal inquiry from original attachments, preserves its conversation key and clears its pending receipt');

const inherited={id:'old-evidence',label:'库存',excerpt:'旧依据',inquiryId:'formal',lineId:'formal-line',evidenceId:'old-id',matchedAt:'old',version:1};
const refProps={email:{intakeBatchId:'formal',parsedRows:[{persistedLineId:'formal-line',version:1,evidence:[{id:'new-id',matched_at:'new'}]}]},inheritedReferences:[inherited]};
const staleReference=harness(refProps);staleReference.input().onChange({target:{value:'生成报价草稿'}});staleReference.render();
const staleRefRun=staleReference.button('↑').onClick();assert.equal(JSON.parse(staleReference.requests[0].options.body).references.length,0,'refreshed evidence must not be resurrected from prior turns');staleReference.respond(0);await staleRefRun;
const currentReference=harness({...refProps,inheritedReferences:[{...inherited,evidenceId:'new-id',matchedAt:'new'}]});currentReference.input().onChange({target:{value:'生成报价草稿'}});currentReference.render();
const currentRefRun=currentReference.button('↑').onClick();assert.equal(JSON.parse(currentReference.requests[0].options.body).references.length,1,'current evidence remains available to follow-up questions');currentReference.respond(0);await currentRefRun;
console.log('PASS: historical references discard replaced evidence and retain current source versions');

const supplierChat=harness({materialRoute:'supplier',email:{intakeBatchId:'formal'}});
supplierChat.files().onChange([{id:'supplier-file',name:'supplier.csv',status:'ready'}]);supplierChat.render();
await supplierChat.button('↑').onClick();supplierChat.render();
assert.equal(supplierChat.requests.length,0);assert.equal(supplierChat.intakes.length,0);
assert.equal(supplierChat.session().supplierCreation.inquiryId,'formal');
assert.equal(supplierChat.session().supplierCreation.attachments[0].id,'supplier-file');
const questionFile=harness();questionFile.files().onChange([{id:'explain-file',name:'supplier.csv',status:'ready'}]);questionFile.files().onRead('supplier excerpt');questionFile.render();
questionFile.input().onChange({target:{value:'解释这个供应商报价'}});questionFile.render();
const questionRun=questionFile.button('↑').onClick();
assert.equal(questionFile.requests[0].url,'/api/assistant/chat');assert.equal(JSON.parse(questionFile.requests[0].options.body).context,'supplier excerpt');
questionFile.requests[0].resolve(new Response('{"type":"delta","text":"报价包含物料与单位价格。"}\n{"type":"done","answer":"报价包含物料与单位价格。"}\n'));await questionRun;
assert.equal(questionFile.session().state,'idle');
console.log('PASS: bound supplier attachments stage against current inquiry without quotation tools; explain-only attachment streams with its current context');

const failedQuote=harness({embedded:true,onApplyPrice(){throw Error('failed quote accepted');}});failedQuote.input().onChange({target:{value:'生成报价草稿'}});failedQuote.render();const failedQuoteRequest=failedQuote.button('↑').onClick();failedQuote.respond(0,'draft','failed');await failedQuoteRequest;failedQuote.render();assert.equal(failedQuote.button('接受建议单价').disabled,true);assert.equal(failedQuote.events().length,1);assert.ok(JSON.stringify(failedQuote.events()[0]).includes('QA draft'));assert.ok(JSON.stringify(failedQuote.events()[0]).includes('copilot-results'));assert.equal(failedQuote.button('前往工作台核对').disabled,undefined);console.log('PASS: reply and action card share one event; failed quote cannot be accepted and workbench navigation stays available');
