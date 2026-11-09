import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
type Point={x:number;y:number};
export const clampFloatingPoint=(p:Point,w:number,h:number):Point=>({x:Math.max(12,Math.min(p.x,Math.max(12,w-64))),y:Math.max(12,Math.min(p.y,Math.max(12,h-88)))});
const key='rfq-assistant-position-v1';
export function FloatingAssistant({open,expanded,docked=false,onOpen,onCollapse,onSend,children}:{open:boolean;expanded:boolean;docked?:boolean;onOpen:()=>void;onCollapse:()=>void;onSend?:(text:string)=>void;children:ReactNode}){
 const initial=()=>{try{const p=JSON.parse(localStorage.getItem(key)||'null');if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y))return clampFloatingPoint(p,innerWidth,innerHeight);}catch{}return clampFloatingPoint({x:innerWidth-76,y:innerHeight-76},innerWidth,innerHeight);};
 const [focused,setFocused]=useState(false);
 const panelRef=useRef<HTMLDivElement>(null);
 const lastPanelStyle=useRef<CSSProperties>();
 const [closing,setClosing]=useState(false);
 const wasOpen=useRef(open);

 const [sendState,setSendState]=useState({disabled:true,busy:false});
 const nativeSend=()=>panelRef.current?.querySelector<HTMLButtonElement>('.chat-send,.send-btn,.stop-btn,.platform-chat-form>button');
 useEffect(()=>{if(!open||expanded||docked)return;const node=panelRef.current;if(!node)return;const sync=()=>{const button=nativeSend();setSendState({disabled:!button||button.disabled,busy:!!button&&(button.classList.contains('stop-btn')||button.textContent?.includes('停止')===true)});};sync();const observer=new window.MutationObserver(sync);observer.observe(node,{subtree:true,attributes:true,attributeFilter:['disabled'],childList:true,characterData:true});return()=>observer.disconnect();},[open,expanded,docked]);
 const [hover,setHover]=useState(false),[input,setInput]=useState('');
 const [point,setPoint]=useState<Point>(initial),[dragging,setDragging]=useState(false);
 const exiting=!expanded&&!open&&!dragging&&closing;
 useLayoutEffect(()=>{
  panelRef.current?.toggleAttribute('inert',!expanded&&!open);
  const shouldClose=wasOpen.current&&!open&&!expanded&&!dragging;
  wasOpen.current=open;
  setHover(false);setFocused(false);
  if(!shouldClose||window.matchMedia('(prefers-reduced-motion: reduce)').matches){setClosing(false);return;}
  setClosing(true);
  const timer=window.setTimeout(()=>setClosing(false),260);
  return()=>window.clearTimeout(timer);
 },[open,expanded,dragging]);

 const hoverBlocked=useRef(false),composing=useRef(false);
 const submit=()=>{if(!input.trim()||!onSend||composing.current)return;onSend(input.trim());setInput('');setHover(false);setFocused(false);};
 const drag=useRef<{id:number;startX:number;startY:number;origin:Point;moved:boolean}|null>(null),last=useRef(point),suppressClick=useRef(false);
 const moveTo=(p:Point)=>{const next=clampFloatingPoint(p,innerWidth,innerHeight);last.current=next;setPoint(next);};
 useEffect(()=>{const resize=()=>moveTo(last.current);addEventListener('resize',resize);return()=>removeEventListener('resize',resize);},[]);
 const down=(e:ReactPointerEvent<HTMLDivElement>)=>{
  const target=e.target as HTMLElement,orb=!!target.closest('[data-assistant-orb]');
  if(expanded||docked||e.button!==0||(!orb&&(!target.closest('.copilot-header')||target.closest('button,input,textarea,select,a'))))return;
  suppressClick.current=false;
  const origin=orb?last.current:clampFloatingPoint({x:e.clientX-26,y:e.clientY-26},innerWidth,innerHeight);
  drag.current={id:e.pointerId,startX:e.clientX,startY:e.clientY,origin,moved:false};
 };
 const move=(e:ReactPointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d||d.id!==e.pointerId)return;const dx=e.clientX-d.startX,dy=e.clientY-d.startY;if(!d.moved&&Math.hypot(dx,dy)<6)return;if(!d.moved){d.moved=true;e.currentTarget.setPointerCapture(e.pointerId);setDragging(true);setHover(false);setFocused(false);hoverBlocked.current=true;onCollapse();}e.preventDefault();moveTo({x:d.origin.x+dx,y:d.origin.y+dy});};
 const finish=(e:ReactPointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d||d.id!==e.pointerId)return;if(d.moved){suppressClick.current=true;try{localStorage.setItem(key,JSON.stringify(last.current));}catch{}}drag.current=null;setDragging(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);};
 const [dockTop,setDockTop]=useState(104);
 useEffect(()=>{
  const header=document.querySelector('.layout-reference .sidebar');
  const update=()=>setDockTop(Math.max(12,(header?header.getBoundingClientRect().bottom+window.scrollY:88)+16));
  update();addEventListener('resize',update);
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);
  if(header)observer?.observe(header);
  return()=>{removeEventListener('resize',update);observer?.disconnect();};
 },[]);
 const workspace=typeof document==='undefined'?null:document.querySelector('.layout-reference .sidebar')?.getBoundingClientRect();
 const workspaceWidth=workspace?.width||Math.min(innerWidth-40,1680);
 const mobile=innerWidth<=860;
 const dockWidth=innerWidth<=860?innerWidth-24:workspaceWidth*.4;
 const panelWidth=docked?dockWidth:Math.min(380,innerWidth-24),panelHeight=mobile?Math.round(innerHeight*.5):docked?Math.max(180,innerHeight-dockTop-16):Math.min(520,innerHeight-24);
 const panelLeft=mobile?0:docked?(innerWidth<=860?12:(workspace?.right||(innerWidth+workspaceWidth)/2)-panelWidth):Math.max(12,Math.min(point.x+76-panelWidth,innerWidth-panelWidth-12)),panelTop=mobile?innerHeight-panelHeight:docked?dockTop:Math.max(12,Math.min(point.y+76-panelHeight,innerHeight-panelHeight-12));
 const panelStyle={position:'fixed',left:panelLeft,top:panelTop,width:mobile?innerWidth:panelWidth,height:panelHeight,'--panel-start-x':`${point.x-panelLeft}px`,'--panel-start-y':`${point.y-panelTop}px`,'--panel-start-scale-x':52/panelWidth,'--panel-start-scale-y':52/panelHeight,'--anchor-local-x':`${point.x+26-panelLeft}px`,'--anchor-local-y':`${point.y+26-panelTop}px`,'--assistant-anchor-x':`${point.x}px`,'--assistant-anchor-y':`${point.y}px`} as CSSProperties;
 if(open&&!expanded)lastPanelStyle.current=panelStyle;
 const wide=!open&&!exiting&&!dragging&&(hover||focused)&&!!onSend,growsRight=point.x<Math.min(288,innerWidth/2);
 return <div className={`floating-assistant ${expanded?'expanded':''} ${docked?'docked':''} ${dragging?'dragging':''} ${open?'assistant-visible':''}`} onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
  <div ref={panelRef} className={`floating-assistant-panel ${!expanded&&open?'is-open':''} ${docked?'is-docked':''} ${exiting?'is-closing':''}`} hidden={!expanded&&!open&&!exiting} aria-hidden={!expanded&&!open?true:undefined} style={expanded?{position:'static',width:'100%',height:'100%',transition:'none',animation:'none',transform:'none'}:exiting?(lastPanelStyle.current||panelStyle):panelStyle}>{children}</div>
  {!expanded&&!docked&&<form className={`assistant-capsule ${wide?'is-wide':''} ${open?'is-open':''} ${growsRight?'grows-right':''}`} style={{left:growsRight?point.x:undefined,right:growsRight?undefined:innerWidth-point.x-52,top:point.y,width:wide?Math.min(340,growsRight?innerWidth-point.x-12:point.x+40):52}} onMouseEnter={()=>{if(!open&&!hoverBlocked.current&&!drag.current)setHover(true);}} onMouseLeave={()=>{hoverBlocked.current=false;setHover(false);}} onBlur={e=>{if(!e.relatedTarget||!e.currentTarget.contains(e.relatedTarget as Node)){setFocused(false);setHover(false);}}} onSubmit={e=>{e.preventDefault();submit();}}>
    <button type="button" className="assistant-orb" data-assistant-orb aria-disabled={open&&sendState.disabled} aria-label={open?(sendState.busy?'停止回复':'发送消息'):input.trim()?'发送给报价助手':'打开报价助手（可拖动）'} aria-expanded={open} onFocus={()=>{if(!hoverBlocked.current)setHover(true);}} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}if(open){nativeSend()?.click();}else if(input.trim()&&onSend&&(hover||focused))submit();else onOpen();}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')suppressClick.current=false;const delta=10;const directions:Record<string,Point>={ArrowLeft:{x:-delta,y:0},ArrowRight:{x:delta,y:0},ArrowUp:{x:0,y:-delta},ArrowDown:{x:0,y:delta}};const d=directions[e.key];if(d){e.preventDefault();moveTo({x:point.x+d.x,y:point.y+d.y});try{localStorage.setItem(key,JSON.stringify(last.current));}catch{}}}}><span className="assistant-orb-q">Q</span><span className="assistant-orb-arrow">{open&&sendState.busy?'■':'↑'}</span></button>
    <input tabIndex={wide?0:-1} onFocus={()=>setFocused(true)} aria-label="向报价助手提问" placeholder="询问平台或报价单…" value={input} onChange={e=>setInput(e.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{if(e.key==='Enter'){if(e.nativeEvent.isComposing||composing.current||e.keyCode===229)return;e.preventDefault();if(!e.repeat)submit();}}} />
  </form>}
 </div>;
}
