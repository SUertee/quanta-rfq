let pendingOrigin:DOMRect|undefined;
export function captureDialogOrigin(element:Element|null){pendingOrigin=element?.getBoundingClientRect();}
const origins=new WeakMap<HTMLDialogElement,DOMRect>();
/** Open a native dialog from the control that initiated it. */
export function showAnchoredDialog(dialog:HTMLDialogElement|null) {
 if(!dialog)return;
 if(pendingOrigin){origins.set(dialog,pendingOrigin);pendingOrigin=undefined;}
 const active=document.activeElement;
 if(!origins.has(dialog)&&active&&active!==document.body&&!dialog.contains(active))origins.set(dialog,active.getBoundingClientRect());
 const trigger=origins.get(dialog);
 dialog.style.animation='none';
 dialog.showModal();
 const bounds=dialog.getBoundingClientRect();
 dialog.style.setProperty('--dialog-start-x',`${trigger?trigger.left+trigger.width/2-bounds.left-bounds.width/2:0}px`);
 dialog.style.setProperty('--dialog-start-y',`${trigger?trigger.top+trigger.height/2-bounds.top-bounds.height/2:0}px`);
 dialog.style.removeProperty('animation');
}
