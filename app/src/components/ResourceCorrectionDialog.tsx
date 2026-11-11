import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { appFetch } from '../engine/appUrl';
import { evaluateResource, type RulePolicy } from '../../shared/rfq-rules.mjs';
import type { SupplierValues } from '../engine/supplierImport';

const fields = [
  ['supplierName','供应商','text'],['unitPrice','采购单价','number'],['currency','币种','text'],
  ['uom','计价单位','text'],['condition','件状','text'],['moq','最小起订量','number'],
  ['leadDays','交期天数','number'],['validFrom','生效日期','date'],['validUntil','有效期至','date'],['certType','证书类型','text'],
] as const;

export function ResourceCorrectionDialog({inquiryId,evidenceId,rules,onClose,onRefresh,onConfigureRules}: {
  inquiryId:string; evidenceId:string; rules?:RulePolicy; onClose:()=>void; onRefresh:()=>Promise<void>; onConfigureRules?:()=>void;
}) {
  const [data,setData]=useState<{resource:SupplierValues;version:string;demand:{partNumber:string;quantity:number;uom:string;condition?:string;requirement?:string;needByDate?:string}}|null>(null);
  const [error,setError]=useState('');
  const [reason,setReason]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState(false);
  const path=`/api/inquiries/${encodeURIComponent(inquiryId)}/evidence/${encodeURIComponent(evidenceId)}/correction`;
  useEffect(()=>{
    const controller=new AbortController();
    void appFetch(path,{signal:controller.signal}).then(async response=>{
      const body=await response.json();if(!response.ok)throw new Error(body.error||'报价读取失败');
      if(!controller.signal.aborted)setData(body);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[path]);
  const save=async()=>{
    if(!data||busy)return;
    setBusy(true);setError('');
    try {
      if(!saved){
        const response=await appFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:data.version,values:data.resource,reason,confirmed})});
        const body=await response.json();if(!response.ok)throw new Error(body.error||'保存失败');
        setSaved(true);
      }
      await onRefresh();
      onClose();
    } catch(error){setError(error instanceof Error?error.message:'保存失败，请重试');}
    finally{setBusy(false);}
  };
  const checks=data?evaluateResource(data.demand,{...data.resource,unitPrice:data.resource.unitPrice??undefined,moq:data.resource.moq??undefined,leadDays:data.resource.leadDays??undefined},{...rules,source:'supplier_price',sourceKey:evidenceId}).checks.filter(check=>check.state!=='pass'):[];
  return <Modal title="处理供货冲突" className="resource-correction-dialog" busy={busy} onClose={onClose}>
    {data?<form onSubmit={event=>{event.preventDefault();void save();}}>
      <p className="resource-demand"><strong>{data.demand.partNumber}</strong><span>本次需求 {data.demand.quantity} {data.demand.uom}</span></p>
      {checks.length>0&&<ul className="resource-correction-checks">{checks.map(check=><li key={check.code}>{check.message}</li>)}</ul>}
      {checks.some(check=>check.code==='currency')&&onConfigureRules&&<button type="button" className="btn" onClick={onConfigureRules}>配置汇率与业务规则</button>}
      <fieldset disabled={busy||saved} className="resource-correction-fields">
        <div className="dialog-fields price-fields">{fields.map(([key,label,type])=><label key={key}>{label}<input type={type} min={type==='number'?0:undefined} step={type==='number'?'any':undefined} value={String(data.resource[key]??'').slice(0,type==='date'?10:undefined)} onChange={event=>setData({...data,resource:{...data.resource,[key]:type==='number'?(event.target.value===''?null:Number(event.target.value)):event.target.value}})}/></label>)}</div>
        <div className="resource-tax"><span>计税口径</span>{[['','待确认'],['inclusive','含税'],['exclusive','未税']].map(([value,label])=><label key={value}><input type="radio" name="resource-tax" checked={(data.resource.taxBasis||'')===value} onChange={()=>setData({...data,resource:{...data.resource,taxBasis:value}})}/>{label}</label>)}</div>
        <label className="resource-confirm"><input type="checkbox" checked={data.resource.authorized===true} onChange={event=>setData({...data,resource:{...data.resource,authorized:event.target.checked}})}/>已核实报价来源与授权</label>
        <label className="resource-reason">修改依据<textarea required maxLength={2000} value={reason} placeholder="填写供应商确认、原始报价或补充材料中的依据" onChange={event=>setReason(event.target.value)}/></label>
        <label className="resource-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>以上修改已核实，保存到供应商报价库</label>
      </fieldset>
      {saved&&<p role="status">报价已保存，等待重新匹配当前询价。</p>}
      {error&&<p role="alert">{error}</p>}
      <footer className="app-dialog-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy||(!saved&&(!confirmed||!reason.trim()))}>{busy?'处理中…':saved?'重试匹配':'保存并重新匹配'}</button></footer>
    </form>:<p role={error?'alert':'status'}>{error||'正在读取供货条件…'}</p>}
  </Modal>;
}
