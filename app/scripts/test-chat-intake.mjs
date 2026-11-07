import assert from 'node:assert/strict';
import {writeFileSync, unlinkSync} from 'node:fs';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import initSqlJs from 'sql.js';
import {createIntakeService, initIntake, rows} from '../server/intake.mjs';

const window = new Window({url:'http://127.0.0.1:5176/'});
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Event', 'localStorage', 'ResizeObserver', 'File', 'FileReader', 'Blob']) {
  Object.defineProperty(globalThis, name, {configurable:true, value:name === 'window' ? window : window[name]});
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
URL.createObjectURL = () => 'blob:test-preview';
URL.revokeObjectURL = () => {};
globalThis.chatIntakeFiles = new Map();
const bundle = await build({
  stdin:{contents:"export {PlatformChat} from './src/components/AssistantConversations';export {shouldCreateChatInquiry,submitChatInquiry} from './src/engine/chatIntake';export {createIntake} from './src/engine/intake';", resolveDir:process.cwd(), loader:'tsx'},
  bundle:true, packages:'external', platform:'node', format:'esm', write:false, jsx:'automatic',
  define:{'import.meta.env':JSON.stringify({BASE_URL:'/quanta-rfq/'})},
  plugins:[{name:'in-memory-original-file-store', setup(builder) {
    builder.onLoad({filter:/chatAttachments\.ts$/}, () => ({loader:'ts', contents:`
      export async function saveChatFile(id,file){globalThis.chatIntakeFiles.set(id,file);}
      export async function loadChatFile(id){return globalThis.chatIntakeFiles.get(id);}
    `}));
  }}],
});
const temp = new URL('./.chat-intake-test.mjs', import.meta.url);
writeFileSync(temp, bundle.outputFiles[0].text);
const {PlatformChat, shouldCreateChatInquiry, submitChatInquiry, createIntake} = await import(temp.href);
unlinkSync(temp);
assert.equal(shouldCreateChatInquiry('怎样从上传询价到生成报价单？', 0), false);
assert.equal(shouldCreateChatInquiry('这张图片是什么？', 1), false);
assert.equal(shouldCreateChatInquiry('如何创建询价？', 0), false);
assert.equal(shouldCreateChatInquiry('请解释怎么创建询价？', 1), false);
assert.equal(shouldCreateChatInquiry('不要创建询价，只解释附件', 1), false);
assert.equal(shouldCreateChatInquiry('不用新建询价', 1), false);
assert.equal(shouldCreateChatInquiry('只检查缺口，不生成报价', 1), true);
assert.equal(shouldCreateChatInquiry('你能帮我创建询价吗？', 0), false);
assert.equal(shouldCreateChatInquiry('解释一下这份附件', 1), false);
assert.equal(shouldCreateChatInquiry('帮我报价', 1), true);
assert.equal(shouldCreateChatInquiry('', 1), true);
assert.equal(shouldCreateChatInquiry('新建询价，件号 AN3-5A 数量 10 单位 EA 件状 FN', 0), true);
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run('CREATE TABLE inventory(partNumber TEXT PRIMARY KEY,uom TEXT,stockQty REAL,lastPurchasePrice REAL,currency TEXT,stockCondition TEXT)');
db.run("INSERT INTO inventory VALUES('AN3-5A','EA',100,14.37,'CNY','FN')");
initIntake(db);
const service = createIntakeService(db, () => {}, {});
const csv = '件号,描述,数量,单位,件状\nAN3-5A,BOLT,10,EA,FN\n';
const requests = [];
let loseResponse = true;
globalThis.fetch = async (url, options={}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({url, body});
  if (url === '/quanta-rfq/api/assistant/files') return {ok:true, json:async () => ({files:[{text:'仅聊天节选'}]})};
  if (url === '/quanta-rfq/api/inquiries' && options.method === 'POST') {
    const result = await service.create(body);
    if (loseResponse) {loseResponse = false; throw new Error('模拟响应中断');}
    return {ok:true, json:async () => result};
  }
  throw new Error('Unexpected request ' + url);
};
const React = await import('react');
const {act} = React;
const {createRoot} = await import('react-dom/client');
const host = document.createElement('div'); document.body.append(host);
let root = createRoot(host);
const created = [];
const props = {standalone:true, conversationKey:'chat:formal-intake', operator:'QA', quickMessage:null, onQuickHandled(){}, onClose(){}, onHistory(){}, onInquiryCreated(batch,key){created.push({batch,key});}};
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const mount = async () => {await act(async () => {root.render(React.createElement(PlatformChat, props)); await wait();});};
const click = async node => {assert.ok(node); await act(async () => {node.dispatchEvent(new window.MouseEvent('click', {bubbles:true})); await wait();});};
const namedButton = name => [...host.querySelectorAll('button')].find(button => button.textContent === name);
await mount();
const paste = new window.Event('paste', {bubbles:true, cancelable:true});
Object.defineProperty(paste, 'clipboardData', {value:{files:[new File([csv], '完整询价.csv', {type:'text/csv'})]}});
await act(async () => {host.querySelector('textarea').dispatchEvent(paste); await wait();});
assert.ok(host.querySelector('.chat-attachment'));
assert.equal(host.querySelector('.chat-send').disabled, false);
await click(host.querySelector('.chat-send'));
assert.match(host.textContent, /模拟响应中断/);
assert.equal(rows(db, 'SELECT id FROM inquiry').length, 1, 'formal record exists even if the HTTP response is lost');
const failed = JSON.parse(localStorage.getItem('quanta-workspace-v1:rfq-chat-v1'))['chat:formal-intake'];
assert.ok(failed.creation.requestId);
assert.equal(failed.turns.filter(turn => turn.role === 'user').length, 1);
await act(async () => root.unmount());
root = createRoot(host); await mount();
assert.ok(namedButton('重试接收'), 'pending request survives reconstruction');
await click(namedButton('重试接收'));
assert.equal(rows(db, 'SELECT id FROM inquiry').length, 1, 'stable retry ID prevents duplicate inquiry');
assert.equal(created.length, 1);
assert.equal(created[0].key, 'chat:formal-intake');
assert.equal(created[0].batch.lines[0].partNumber, 'AN3-5A');
assert.equal(created[0].batch.lines[0].quantity, 10);
assert.equal(rows(db, 'SELECT source FROM inquiry')[0].source, 'chat');
const original = rows(db, 'SELECT raw,source,file_type FROM file')[0];
assert.equal(Buffer.from(original.raw).toString(), csv, 'full bytes, not the chat excerpt, enter formal intake');
assert.equal(original.source, 'chat'); assert.equal(original.file_type, 'csv');
assert.ok(rows(db, 'SELECT id FROM file_content').length > 0);
assert.equal(rows(db, 'SELECT source FROM evidence')[0].source, 'inventory');
const finished = JSON.parse(localStorage.getItem('quanta-workspace-v1:rfq-chat-v1'))['chat:formal-intake'];
assert.equal(finished.creation, undefined);
assert.equal(finished.turns.at(-1).inquiry.id, created[0].batch.id);
assert.match(host.textContent, /1 个原文件已保存 · 1 行物料/);
const formal = requests.filter(request => request.url.endsWith('/api/inquiries'));
assert.equal(formal.length, 2); assert.equal(formal[0].body.requestId, formal[1].body.requestId);
await assert.rejects(submitChatInquiry({requestId:'missing-original', instruction:'', operator:'QA', attachments:[{id:'missing', name:'丢失.pdf'}]}, new AbortController().signal), /原文件.*不可用/);
await act(async () => root.unmount());
let polled = 0;
globalThis.fetch = async (url, options={}) => {
  if (options.method === 'POST') return {ok:true, json:async () => ({id:'processing-retry', status:'processing'})};
  assert.equal(url, '/quanta-rfq/api/inquiries/processing-retry'); polled++;
  return {ok:true, json:async () => ({id:'processing-retry', status:'evidence_ready'})};
};
assert.equal((await createIntake([], '件号 AN3-5A 数量 10 单位 EA 件状 FN', 'QA', 'processing-retry')).status, 'evidence_ready');
assert.equal(polled, 1);
db.close(); await window.happyDOM.close();
console.log('PASS: React native paste, original-byte formal intake, chat source/type, standard material/evidence, lost-response retry after remount, stable request deduplication, saved receipt, missing original rejection and in-progress response polling');
