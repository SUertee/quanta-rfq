import {useEffect,useState} from 'react';
import {Modal} from './Modal';
import {appFetch as fetch} from '../engine/appUrl';
import type {EmailBinding} from '../auth';

interface AdminAccount {
  id: string;
  username: string;
  role: 'master' | 'sub';
  displayName: string;
  disabled: boolean;
  emailBindings?: EmailBinding[];
  createdAt?: string;
}

/** 账户管理（仅总账户）：子账户列表、新建、重置密码、停用/启用 */
export function AccountAdminDialog({onClose}:{onClose:()=>void}) {
  const [accounts,setAccounts]=useState<AdminAccount[]|null>(null);
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);
  const [newUsername,setNewUsername]=useState('');
  const [newPassword,setNewPassword]=useState('');
  const [newDisplayName,setNewDisplayName]=useState('');
  const [resetId,setResetId]=useState<string|null>(null);
  const [resetPassword,setResetPassword]=useState('');

  const load=async()=>{
    setBusy(true);setErr('');
    try{
      const r=await fetch('/api/accounts');
      const body=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error((body as {error?:string}).error||'读取账户列表失败');
      const list=Array.isArray(body)?body:(body as {accounts?:AdminAccount[]}).accounts??[];
      setAccounts(list);
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  useEffect(()=>{void load();},[]);

  const create=async()=>{
    if(!newUsername.trim()||!newPassword||!newDisplayName.trim()){setErr('请填写用户名、初始密码和显示名');return;}
    setBusy(true);setErr('');
    try{
      const r=await fetch('/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:newUsername.trim(),password:newPassword,displayName:newDisplayName.trim()})});
      const body=await r.json().catch(()=>({})) as {error?:string};
      if(!r.ok)throw new Error(body.error||'创建子账户失败');
      setNewUsername('');setNewPassword('');setNewDisplayName('');
      await load();
    }catch(e){setErr(e instanceof Error?e.message:String(e));setBusy(false);}
  };

  const reset=async(id:string)=>{
    if(!resetPassword){setErr('请输入新密码');return;}
    setBusy(true);setErr('');
    try{
      const r=await fetch(`/api/accounts/${encodeURIComponent(id)}/reset-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:resetPassword})});
      const body=await r.json().catch(()=>({})) as {error?:string};
      if(!r.ok)throw new Error(body.error||'重置密码失败');
      setResetId(null);setResetPassword('');
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  const toggleDisabled=async(account:AdminAccount)=>{
    setBusy(true);setErr('');
    try{
      const r=await fetch(`/api/accounts/${encodeURIComponent(account.id)}/disabled`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabled:!account.disabled})});
      const body=await r.json().catch(()=>({})) as {error?:string};
      if(!r.ok)throw new Error(body.error||'操作失败');
      setAccounts(old=>(old??[]).map(item=>item.id===account.id?{...item,disabled:!account.disabled}:item));
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  return <Modal title="账户管理" busy={busy} onClose={onClose}>
    {accounts===null&&!err?<div role="status">正在载入…</div>:<>
      <div className="table-wrap account-admin-table"><table>
        <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>邮箱绑定</th><th>操作</th></tr></thead>
        <tbody>{(accounts??[]).map(a=><tr key={a.id}>
          <td>{a.username}</td>
          <td>{a.displayName}</td>
          <td>{a.role==='master'?'总账户':'子账户'}</td>
          <td>{a.disabled?'已停用':'正常'}</td>
          <td>{a.emailBindings?.length??0}</td>
          <td>{a.role!=='master'&&<span className="record-actions">
            <button type="button" className="record-open" disabled={busy} onClick={()=>{setResetId(resetId===a.id?null:a.id);setResetPassword('');}}>重置密码</button>
            <button type="button" className="record-delete" disabled={busy} onClick={()=>void toggleDisabled(a)}>{a.disabled?'启用':'停用'}</button>
          </span>}</td>
        </tr>)}</tbody>
      </table></div>
      {resetId&&<div className="dialog-fields account-reset-row">
        <label>新密码（{accounts?.find(a=>a.id===resetId)?.username}）<input type="password" autoFocus aria-label="重置密码" value={resetPassword} disabled={busy} onChange={e=>setResetPassword(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void reset(resetId);}} /></label>
        <div className="record-actions"><button type="button" className="btn primary" disabled={busy||!resetPassword} onClick={()=>void reset(resetId)}>确认重置</button><button type="button" className="btn" disabled={busy} onClick={()=>setResetId(null)}>取消</button></div>
      </div>}
      <h3 className="account-admin-subhead">新建子账户</h3>
      <div className="dialog-fields">
        <label>用户名<input aria-label="子账户用户名" value={newUsername} disabled={busy} onChange={e=>setNewUsername(e.target.value)} /></label>
        <label>初始密码<input type="password" aria-label="初始密码" value={newPassword} disabled={busy} onChange={e=>setNewPassword(e.target.value)} /></label>
        <label>显示名<input aria-label="显示名" value={newDisplayName} disabled={busy} onChange={e=>setNewDisplayName(e.target.value)} /></label>
        <div><button type="button" className="btn primary" disabled={busy||!newUsername.trim()||!newPassword||!newDisplayName.trim()} onClick={()=>void create()}>创建子账户</button></div>
      </div>
    </>}
    {err&&<div role="alert" className="hint">{err}</div>}
    <footer className="app-dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>关闭</button></footer>
  </Modal>;
}
