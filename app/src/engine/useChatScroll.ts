import {useEffect,useRef} from 'react';
/** Scroll only the chat viewport; never pull the workbench or override someone reading history. */
export function useChatScroll(content:unknown){
 const containerRef=useRef<HTMLDivElement>(null),follow=useRef(true);
 const onScroll=()=>{const node=containerRef.current;if(node)follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<48;};
 useEffect(()=>{const node=containerRef.current;if(node&&follow.current&&!node.closest('[hidden]'))node.scrollTop=node.scrollHeight;},[content]);
 return {containerRef,onScroll,follow};
}
