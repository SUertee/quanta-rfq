import {useState} from 'react';
import {appFetch} from '../engine/appUrl';

export type ChatCorrection = {
  inquiryId:string; evidenceId:string; version:string; label:string; partNumber:string;
  values:Record<string,unknown>; reason:string;
  differences:{field:string;before:unknown;after:unknown}[];
  saved?:boolean; applied?:boolean; cancelled?:boolean;
};
const labels:Record<string,string>={supplierName:'供应商',unitPrice:'采购单价',currency:'币种',uom:'计价单位',condition:'件状',moq:'最小起订量',leadDays:'交期天数',validFrom:'生效日期',validUntil:'有效期至',certType:'证书类型',taxBasis:'计税口径',authorized:'来源授权',remark:'备注'};
const display=(value:unknown)=>value===true?'已核实':value===false?'待核实':value==='inclusive'?'含税':value==='exclusive'?'未税':value==null||value===''?'未填写':String(value);
export function ChatCorrectionCard({proposal,onChange,onSaved,disabled=false}:{proposal:ChatCorrection;onChange:(proposal:ChatCorrection)=>void;onSaved?:()=>void;disabled?:boolean}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const save=async()=>{
    setBusy(true);setError('');
    try {
      if(!proposal.saved){
        const response=await appFetch(`/api/inquiries/${encodeURIComponent(proposal.inquiryId)}/evidence/${encodeURIComponent(proposal.evidenceId)}/correction`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:proposal.version,values:proposal.values,reason:proposal.reason,confirmed:true})});
        const body=await response.json();if(!response.ok)throw Error(body.error||'保存失败');
        onChange({...proposal,saved:true});
      }
      const response=await appFetch(`/api/inquiries/${encodeURIComponent(proposal.inquiryId)}/evidence`,{method:'POST'});
      const body=await response.json();if(!response.ok)throw Error(body.error||'重新匹配失败');
      onChange({...proposal,saved:true,applied:true});onSaved?.();
    }catch(error){setError(error instanceof Error?error.message:'处理失败，请重试');}
    finally{setBusy(false);}
  };
  return <section className="chat-correction-card" aria-label="确认报价修改">
    <header><strong>修改供应商报价</strong><span>{proposal.partNumber}</span></header>
    <p>{proposal.label}</p>
    <dl>{proposal.differences.map(change=><div key={change.field}><dt>{labels[change.field]||change.field}</dt><dd>{display(change.before)} → <strong>{display(change.after)}</strong></dd></div>)}</dl>
    <p>修改依据 {proposal.reason}</p>
    {error&&<p role="alert">{error}</p>}
    <footer>{proposal.applied?<strong role="status">已保存并重新匹配</strong>:proposal.cancelled?<span>已取消</span>:<><button className="btn" disabled={busy||disabled||proposal.saved} onClick={()=>onChange({...proposal,cancelled:true})}>取消</button><button className="btn primary" disabled={busy||disabled} onClick={()=>void save()}>{busy?'处理中…':proposal.saved?'重试匹配':'确认保存并重新匹配'}</button></>}</footer>
  </section>;
}
