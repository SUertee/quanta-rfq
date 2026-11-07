import {useEffect,useId,useRef,type ReactNode} from 'react';

export function Modal({title,onClose,busy=false,className='',children}:{title:string;onClose:()=>void;busy?:boolean;className?:string;children:ReactNode}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const headingId=useId();
 useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
 return <dialog ref={dialog} className={`modal app-dialog ${className}`} aria-labelledby={headingId} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onClick={event=>{if(event.target!==event.currentTarget||busy)return;const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)onClose();}}>
  <header className="app-dialog-head"><h2 id={headingId}>{title}</h2><button type="button" className="dialog-close" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}>×</button></header>
  {children}
 </dialog>;
}
