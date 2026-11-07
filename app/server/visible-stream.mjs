// Strip explicit reasoning blocks and tags even when a tag spans token chunks.
export function visibleStream(emit){let buffer='',thinking=false;
 const push=(text,flush=false)=>{buffer+=text;while(buffer){const index=buffer.indexOf('<');if(index<0){if(!thinking)emit(buffer);buffer='';break;}if(index>0){if(!thinking)emit(buffer.slice(0,index));buffer=buffer.slice(index);}const end=buffer.indexOf('>');if(end<0){if(flush){if(!thinking&&!/^<\/?think/i.test(buffer))emit(buffer);buffer='';}break;}const tag=buffer.slice(0,end+1);if(/^<think>$/i.test(tag))thinking=true;else if(/^<\/think>$/i.test(tag))thinking=false;else if(!thinking)emit(tag);buffer=buffer.slice(end+1);}};
 return {push:text=>push(text),finish:()=>push('',true)};
}
