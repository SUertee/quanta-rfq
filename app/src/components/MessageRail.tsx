import {useEffect,useState,type RefObject} from 'react';

/** Message landmarks are navigation, independent of the message scroll position. */
export function MessageRail({container,turns}:{container:RefObject<HTMLDivElement>;turns:readonly {role:string;content:string}[]}) {
  const [active,setActive]=useState(0);
  const entries=turns.map((turn,index)=>({...turn,index})).filter(turn=>turn.role==='user');
  useEffect(()=>{
    const node=container.current;
    if(!node)return;
    const update=()=>{
      const top=node.getBoundingClientRect().top;
      const messages=[...node.querySelectorAll<HTMLElement>('.rfq-chat-turn.user')];
      let selected=0;
      messages.forEach((message,index)=>{if(message.getBoundingClientRect().top<=top+node.clientHeight/2)selected=index;});
      setActive(selected);
    };
    update();node.addEventListener('scroll',update,{passive:true});
    const observer=new ResizeObserver(update);observer.observe(node);
    return()=>{node.removeEventListener('scroll',update);observer.disconnect();};
  },[container,turns.length]);
  if(!entries.length)return null;
  return <nav className="message-rail" aria-label="对话定位">{entries.map((turn,index)=><button key={turn.index} className={active===index?'active':''} aria-label={`定位消息 ${index+1} ${turn.content.slice(0,30)}`} aria-current={active===index?'location':undefined} onClick={()=>{
    const node=container.current;
    const message=node?.querySelectorAll<HTMLElement>('.rfq-chat-turn.user')[index];
    if(node&&message)node.scrollTo({top:node.scrollTop+message.getBoundingClientRect().top-node.getBoundingClientRect().top-12,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }}><span className="message-rail-mark"/><span className="message-rail-preview">{turn.content.slice(0,80)||'文件询价'}</span></button>)}</nav>;
}
