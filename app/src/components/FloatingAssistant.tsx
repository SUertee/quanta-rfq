import {useEffect,useRef,useState,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
type Point={x:number;y:number};
export const clampFloatingPoint=(p:Point,w:number,h:number):Point=>({x:Math.max(12,Math.min(p.x,Math.max(12,w-64))),y:Math.max(12,Math.min(p.y,Math.max(12,h-64)))});
const key='rfq-assistant-position-v1';
export function FloatingAssistant({open,expanded,onOpen,onCollapse,onSend,children}:{open:boolean;expanded:boolean;onOpen:()=>void;onCollapse:()=>void;onSend?:(text:string)=>void;children:ReactNode}){
 const initial=()=>{try{const p=JSON.parse(localStorage.getItem(key)||'null');if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y))return clampFloatingPoint(p,innerWidth,innerHeight);}catch{}return clampFloatingPoint({x:innerWidth-76,y:innerHeight-76},innerWidth,innerHeight);};
 const [focused,setFocused]=useState(false);
 const [hover,setHover]=useState(false),[input,setInput]=useState('');
 const [point,setPoint]=useState<Point>(initial),[dragging,setDragging]=useState(false);
 const hoverBlocked=useRef(false);
 const drag=useRef<{id:number;startX:number;startY:number;origin:Point;moved:boolean}|null>(null),last=useRef(point),suppressClick=useRef(false);
 const moveTo=(p:Point)=>{const next=clampFloatingPoint(p,innerWidth,innerHeight);last.current=next;setPoint(next);};
 useEffect(()=>{const resize=()=>moveTo(last.current);addEventListener('resize',resize);return()=>removeEventListener('resize',resize);},[]);
 const down=(e:ReactPointerEvent<HTMLDivElement>)=>{
  const target=e.target as HTMLElement,orb=!!target.closest('[data-assistant-orb]');
  if(expanded||e.button!==0||(!orb&&(!target.closest('.copilot-header')||target.closest('button,input,textarea,select,a'))))return;
  suppressClick.current=false;
  const origin=orb?last.current:clampFloatingPoint({x:e.clientX-26,y:e.clientY-26},innerWidth,innerHeight);
  drag.current={id:e.pointerId,startX:e.clientX,startY:e.clientY,origin,moved:false};
 };
 const move=(e:ReactPointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d||d.id!==e.pointerId)return;const dx=e.clientX-d.startX,dy=e.clientY-d.startY;if(!d.moved&&Math.hypot(dx,dy)<6)return;if(!d.moved){d.moved=true;e.currentTarget.setPointerCapture(e.pointerId);setDragging(true);setHover(false);setFocused(false);hoverBlocked.current=true;onCollapse();}e.preventDefault();moveTo({x:d.origin.x+dx,y:d.origin.y+dy});};
 const finish=(e:ReactPointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d||d.id!==e.pointerId)return;if(d.moved){suppressClick.current=true;try{localStorage.setItem(key,JSON.stringify(last.current));}catch{}}drag.current=null;setDragging(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);};
 const panelWidth=Math.min(380,innerWidth-24),panelHeight=Math.min(520,innerHeight-100);
 return <div className={`floating-assistant ${expanded?'expanded':''} ${dragging?'dragging':''}`} onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
  <div className="floating-assistant-panel" hidden={!expanded&&!open} style={expanded?undefined:{position:'fixed',left:Math.max(12,Math.min(point.x+52-panelWidth,innerWidth-panelWidth-12)),top:Math.max(12,Math.min(point.y+52-panelHeight,innerHeight-panelHeight-12)),width:panelWidth,height:panelHeight}}>{children}</div>
  {!expanded&&(!open||dragging)&&<form className={`assistant-capsule ${!dragging&&(hover||focused)&&onSend?'is-wide':''}`} style={{left:!dragging&&(hover||focused)&&onSend?Math.max(12,point.x+52-Math.min(340,innerWidth-24)):point.x,top:point.y,width:!dragging&&(hover||focused)&&onSend?Math.min(340,innerWidth-24):52}} onMouseEnter={()=>{if(!hoverBlocked.current&&!drag.current)setHover(true);}} onMouseLeave={()=>{hoverBlocked.current=false;setHover(false);}} onBlur={e=>{if(!e.relatedTarget||!e.currentTarget.contains(e.relatedTarget as Node)){setFocused(false);setHover(false);}}} onSubmit={e=>{e.preventDefault();if(input.trim()&&onSend){onSend(input.trim());setInput('');setHover(false);setFocused(false);}}}>
    <button type="button" className="assistant-orb" data-assistant-orb aria-label={input.trim()?'发送给报价助手':'打开报价助手（可拖动）'} onFocus={()=>{if(!hoverBlocked.current)setHover(true);}} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}if(input.trim()&&onSend&&(hover||focused)){onSend(input.trim());setInput('');setHover(false);setFocused(false);}else onOpen();}} onKeyDown={e=>{const delta=10;const directions:Record<string,Point>={ArrowLeft:{x:-delta,y:0},ArrowRight:{x:delta,y:0},ArrowUp:{x:0,y:-delta},ArrowDown:{x:0,y:delta}};const d=directions[e.key];if(d){e.preventDefault();moveTo({x:point.x+d.x,y:point.y+d.y});try{localStorage.setItem(key,JSON.stringify(last.current));}catch{}}}}><span className="assistant-orb-q">Q</span><span className="assistant-orb-arrow">↑</span></button>
    <input tabIndex={!dragging&&(hover||focused)?0:-1} onFocus={()=>setFocused(true)} aria-label="向报价助手提问" placeholder="询问平台或报价单…" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.nativeEvent.isComposing&&e.key==='Enter')e.preventDefault();}} />
  </form>}
 </div>;
}
