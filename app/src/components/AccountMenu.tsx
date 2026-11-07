import {useEffect,useRef,useState} from 'react';

export function AccountMenu({name,onProfile,onBusiness,onModels}:{name:string;onProfile:()=>void;onBusiness:()=>void;onModels:()=>void}) {
 const [open,setOpen]=useState(false);
 const root=useRef<HTMLDivElement>(null);
 const trigger=useRef<HTMLButtonElement>(null);
 const items=[{label:'个人信息',action:onProfile,path:'M20 21v-2a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'},{label:'业务配置',action:onBusiness,path:'M8 6V4h8v2M3 7h18v14H3ZM3 12h18M10 12v3h4v-3'},{label:'模型配置',action:onModels,path:'M6 6h12v12H6ZM9 9h6v6H9ZM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4'}];
 useEffect(()=>{
  if(!open)return;
  root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
  const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
  document.addEventListener('pointerdown',outside);
  return()=>document.removeEventListener('pointerdown',outside);
 },[open]);
 return <div className="account-menu" ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();return;}
  const buttons=[...(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]')||[])];
  const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='ArrowDown'?(index+1)%items.length:event.key==='ArrowUp'?(index+items.length-1)%items.length:event.key==='Home'?0:event.key==='End'?items.length-1:-1;
  if(next<0)return;event.preventDefault();if(!open)setOpen(true);else buttons[next]?.focus();
 }}>
  <button ref={trigger} className="avatar" aria-label="账户菜单" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{name.slice(0,1)||'我'}</button>
  {open&&<div className="account-menu-panel" role="menu" aria-label="账户设置">{items.map(item=><button key={item.label} type="button" role="menuitem" onClick={()=>{setOpen(false);trigger.current?.focus();item.action();}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.path}/></svg>{item.label}</button>)}</div>}
 </div>;
}
