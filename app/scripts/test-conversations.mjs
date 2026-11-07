import assert from 'node:assert/strict';
import {build} from 'esbuild';
const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};globalThis.window={dispatchEvent(){}};
const bundle=await build({entryPoints:['src/engine/conversations.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {newConversation,conversationMeta,updateConversation}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const a=newConversation(),b=newConversation();assert.notEqual(a,b);updateConversation(a,{taskKey:'email:qa',archived:true});assert.equal(conversationMeta()[a].taskKey,'email:qa');assert.equal(conversationMeta()[a].archived,true);assert.ok(conversationMeta()[b]);updateConversation(a,{archived:false});assert.equal(conversationMeta()[a].taskKey,'email:qa');updateConversation(a,{taskKey:null});assert.equal(conversationMeta()[a].taskKey,null);assert.equal(Object.keys(conversationMeta()).length,2);
console.log('PASS: distinct new conversations, association persistence, archive/restore without losing relation, explicit unlink and record isolation');
