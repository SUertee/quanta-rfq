import {useEffect,useState} from 'react';
import {Modal} from './Modal';
import {appFetch as fetch} from '../engine/appUrl';
import type {AuthAccount,EmailBinding} from '../auth';

/** 邮箱绑定：查看/编辑当前账户的收件邮箱（邮箱地址 + 用途备注），整表 PUT 保存 */
export function EmailBindingsDialog({account,onClose}:{account:AuthAccount;onClose:()=>void}) {
  const [bindings,setBindings]=useState<EmailBinding[]|null>(null);
  const [email,setEmail]=useState('');
  const [purpose,setPurpose]=useState('');
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let cancelled=false;
    setBusy(true);
    fetch(`/api/accounts/${encodeURIComponent(account.id)}/email-bindings`).then(async r=>{
      const body=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error((body as {error?:string}).error||'读取邮箱绑定失败');
      const list=Array.isArray(body)?body:(body as {bindings?:EmailBinding[];emailBindings?:EmailBinding[]}).bindings??(body as {emailBindings?:EmailBinding[]}).emailBindings??[];
      if(!cancelled)setBindings(list);
    }).catch(e=>{if(!cancelled)setErr(e instanceof Error?e.message:String(e));}).finally(()=>{if(!cancelled)setBusy(false);});
    return()=>{cancelled=true;};
  },[account.id]);
  const add=()=>{
    const value=email.trim();
    if(!value){setErr('请输入邮箱地址');return;}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)){setErr('邮箱地址格式不正确');return;}
    if((bindings??[]).some(b=>b.email===value)){setErr('该邮箱已绑定');return;}
    setBindings(old=>[...(old??[]),{email:value,purpose:purpose.trim()}]);
    setEmail('');setPurpose('');setErr('');
  };
  const save=async()=>{
    if(!bindings)return;
    setBusy(true);setErr('');
    try{
      const r=await fetch(`/api/accounts/${encodeURIComponent(account.id)}/email-bindings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(bindings)});
      const body=await r.json().catch(()=>({})) as {error?:string};
      if(!r.ok)throw new Error(body.error||'保存失败，请重试');
      onClose();
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <Modal title="邮箱绑定" busy={busy} onClose={onClose}>
    {bindings===null&&!err?<div role="status">正在载入…</div>:<>
      {bindings&&bindings.length>0?<ul className="binding-list">{bindings.map(b=><li key={b.email}><span className="binding-email">{b.email}</span><span className="binding-purpose">{b.purpose||'—'}</span><button type="button" className="record-delete" aria-label={`删除绑定 ${b.email}`} disabled={busy} onClick={()=>setBindings(old=>(old??[]).filter(item=>item.email!==b.email))}>删除</button></li>)}</ul>:<p className="hint">暂无绑定邮箱</p>}
      <div className="dialog-fields binding-add">
        <label>邮箱地址<input type="email" aria-label="邮箱地址" placeholder="name@example.com" value={email} disabled={busy} onChange={e=>setEmail(e.target.value)} /></label>
        <label>用途备注<input aria-label="用途备注" placeholder="如：接收客户询价" value={purpose} disabled={busy} onChange={e=>setPurpose(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')add();}} /></label>
        <div><button type="button" className="btn" disabled={busy||!email.trim()} onClick={add}>添加</button></div>
      </div>
    </>}
    {err&&<div role="alert" className="hint">{err}</div>}
    <footer className="app-dialog-actions"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy||bindings===null} onClick={()=>void save()}>{busy?'保存中…':'保存'}</button></footer>
  </Modal>;
}
