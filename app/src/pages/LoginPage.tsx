import {useState} from 'react';
import {appFetch as fetch,appUrl} from '../engine/appUrl';
import {setAuth,type AuthState} from '../auth';

/**
 * 登录页：用户名/密码 → POST /api/auth/login。
 * mustChangePwd=true 时进入强制改密阶段，改完才回调 onLogin 进系统。
 * initialAuth 用于"刷新后会话仍要求改密"的场景（跳过登录直接改密）。
 */
export function LoginPage({onLogin,initialAuth}:{onLogin:(auth:AuthState)=>void;initialAuth?:AuthState}) {
  const [stage,setStage]=useState<'login'|'change'>(initialAuth?'change':'login');
  const [pendingAuth,setPendingAuth]=useState<AuthState|null>(initialAuth??null);
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [oldPassword,setOldPassword]=useState('');
  const [newPassword,setNewPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);

  const submitLogin=async()=>{
    if(!username.trim()||!password){setErr('请输入用户名和密码');return;}
    setBusy(true);setErr('');
    try{
      const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.trim(),password})});
      const body=await r.json().catch(()=>({})) as {error?:string;token?:string;account?:AuthState['account']};
      if(!r.ok||!body.token||!body.account)throw new Error(r.status===401?'用户名或密码不正确':(body.error||'登录失败，请稍后重试'));
      const auth:AuthState={token:body.token,account:body.account};
      setAuth(auth);
      if(auth.account.mustChangePwd){setPendingAuth(auth);setOldPassword(password);setPassword('');setStage('change');return;}
      onLogin(auth);
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  const submitChange=async()=>{
    if(!pendingAuth)return;
    if(!oldPassword){setErr('请输入原密码');return;}
    if(!newPassword){setErr('请输入新密码');return;}
    if(newPassword!==confirm){setErr('两次输入的新密码不一致');return;}
    setBusy(true);setErr('');
    try{
      const r=await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPassword,newPassword})});
      const body=await r.json().catch(()=>({})) as {error?:string};
      if(!r.ok)throw new Error(body.error||'修改密码失败，请重试');
      const next:AuthState={...pendingAuth,account:{...pendingAuth.account,mustChangePwd:false}};
      setAuth(next);
      onLogin(next);
    }catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  return <div className="login-page">
    <section className="login-card" aria-label={stage==='login'?'登录':'修改初始密码'}>
      <img className="quanta-wordmark" src={appUrl('images/brand/quanta-logo-light.svg')} alt="Quanta" width="136" height="43" />
      {stage==='login'?<>
        <h1>登录工作台</h1>
        <div className="dialog-fields">
          <label>用户名<input autoFocus autoComplete="username" aria-label="用户名" value={username} disabled={busy} onChange={e=>setUsername(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void submitLogin();}} /></label>
          <label>密码<input type="password" autoComplete="current-password" aria-label="密码" value={password} disabled={busy} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void submitLogin();}} /></label>
        </div>
        {err&&<div role="alert" className="hint">{err}</div>}
        <footer className="app-dialog-actions"><button className="btn primary" disabled={busy||!username.trim()||!password} onClick={()=>void submitLogin()}>{busy?'登录中…':'登录'}</button></footer>
      </>:<>
        <h1>首次登录请修改密码</h1>
        <p className="login-note">账户 {pendingAuth?.account.displayName||pendingAuth?.account.username} 使用的是初始密码，修改后才能进入系统。</p>
        <div className="dialog-fields">
          <label>原密码<input type="password" autoComplete="current-password" aria-label="原密码" value={oldPassword} disabled={busy} onChange={e=>setOldPassword(e.target.value)} /></label>
          <label>新密码<input type="password" autoFocus autoComplete="new-password" aria-label="新密码" value={newPassword} disabled={busy} onChange={e=>setNewPassword(e.target.value)} /></label>
          <label>确认新密码<input type="password" autoComplete="new-password" aria-label="确认新密码" value={confirm} disabled={busy} onChange={e=>setConfirm(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void submitChange();}} /></label>
        </div>
        {err&&<div role="alert" className="hint">{err}</div>}
        <footer className="app-dialog-actions"><button className="btn primary" disabled={busy||!oldPassword||!newPassword||!confirm} onClick={()=>void submitChange()}>{busy?'提交中…':'修改并进入'}</button></footer>
      </>}
    </section>
  </div>;
}
