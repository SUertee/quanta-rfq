import {useState} from 'react';
import {Modal} from './Modal';
import {appFetch as fetch} from '../engine/appUrl';

/** 账户菜单「修改密码」：POST /api/auth/change-password */
export function ChangePasswordDialog({onClose}:{onClose:()=>void}) {
  const [oldPassword,setOldPassword]=useState('');
  const [newPassword,setNewPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);
  const submit=async()=>{
    if(!oldPassword||!newPassword){setErr('请输入原密码和新密码');return;}
    if(newPassword!==confirm){setErr('两次输入的新密码不一致');return;}
    setBusy(true);setErr('');
    try{
      const r=await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPassword,newPassword})});
      const body=await r.json().catch(()=>({})) as {error?:string};
      if(!r.ok)throw new Error(body.error||'修改密码失败，请重试');
      onClose();
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <Modal title="修改密码" busy={busy} onClose={onClose}>
    <div className="dialog-fields">
      <label>原密码<input type="password" autoFocus autoComplete="current-password" aria-label="原密码" value={oldPassword} disabled={busy} onChange={e=>setOldPassword(e.target.value)} /></label>
      <label>新密码<input type="password" autoComplete="new-password" aria-label="新密码" value={newPassword} disabled={busy} onChange={e=>setNewPassword(e.target.value)} /></label>
      <label>确认新密码<input type="password" autoComplete="new-password" aria-label="确认新密码" value={confirm} disabled={busy} onChange={e=>setConfirm(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void submit();}} /></label>
    </div>
    {err&&<div role="alert" className="hint">{err}</div>}
    <footer className="app-dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy||!oldPassword||!newPassword||!confirm} onClick={()=>void submit()}>{busy?'提交中…':'确认修改'}</button></footer>
  </Modal>;
}
