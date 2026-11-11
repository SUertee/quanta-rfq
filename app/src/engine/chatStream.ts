export async function readChatStream(response:Response,onDelta:(text:string)=>void,onDone?:(event:{correction?:import('../components/ChatCorrectionCard').ChatCorrection})=>void){
 if(!response.ok){const result=await response.json();throw Error(result.error||'模型连接失败');}
 if(!response.body)throw Error('浏览器不支持流式读取');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',answer='',done=false;
 const parse=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==='delta'){answer+=event.text;onDelta(answer);}else if(event.type==='error')throw Error(event.error);else if(event.type==='done'){done=true;answer=event.answer;onDelta(answer);onDone?.(event);}};
 try{while(true){const chunk=await reader.read();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});let index;while((index=buffer.indexOf('\n'))>=0){parse(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(chunk.done)break;}if(buffer.trim())parse(buffer);if(!done)throw Error('连接已中断，当前仅为部分回复，请重试');return answer;}finally{reader.releaseLock();}
}

/** Stream audited tool progress, then accept only the completed structured result. */
export async function readAgentStream<T>(response:Response,onProgress:(tool:string,state:string)=>void):Promise<T> {
 if(!response.headers?.get('content-type')?.includes('application/x-ndjson')){
  const result=await response.json();if(!response.ok)throw Error(result.error||'Agent 执行失败');return result;
 }
 if(!response.body)throw Error('浏览器不支持流式读取');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result:T|undefined;
 const parse=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==='progress')onProgress(event.tool,event.state);else if(event.type==='done')result=event.result;else if(event.type==='error')throw Error(event.error);};
 try{while(true){const chunk=await reader.read();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});let index;while((index=buffer.indexOf('\n'))>=0){parse(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(chunk.done)break;}if(buffer.trim())parse(buffer);if(!result)throw Error('执行连接已中断，未取得完整结果，请重试');return result;}finally{reader.releaseLock();}
}
