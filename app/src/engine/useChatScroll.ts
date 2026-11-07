import {useEffect,useRef} from 'react';
/** Scroll only the chat viewport; never pull the workbench or override someone reading history. */
export function useChatScroll(content:unknown){
 const containerRef=useRef<HTMLDivElement>(null),follow=useRef(true);
 const onScroll=()=>{const node=containerRef.current;if(node)follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<48;};
 useEffect(()=>{const node=containerRef.current;if(node&&follow.current&&!node.closest('[hidden]'))node.scrollTop=node.scrollHeight;},[content]);
 useEffect(()=>{const node=containerRef.current;if(!node)return;const observer=new ResizeObserver(()=>{if(follow.current&&!node.closest('[hidden]'))node.scrollTop=node.scrollHeight;});observer.observe(node);return()=>observer.disconnect();},[]);
 return {containerRef,onScroll,follow};
}
