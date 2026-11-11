import {useState} from 'react';
import {Modal} from './Modal';
import type {QuoteDocument} from '../engine/quoteDocument';

export function QuoteDocumentEditor({value,onSave,onClose}:{value:QuoteDocument;onSave:(value:QuoteDocument)=>void;onClose:()=>void}) {
  const [draft,setDraft]=useState(value);
  const companyFields=[['name','报价方'],['address','地址'],['contact','联系人'],['creditCode','统一社会信用代码'],['warrantyLabel','质保条款名称'],['warrantyNew','质保期（月）'],['warrantyOh','其他件状质保期（月）'],['validityDays','报价有效期（天）']] as const;
  return <Modal title="填写报价单" onClose={onClose} className="quote-document-dialog">
    <form onSubmit={event=>{event.preventDefault();onSave(draft);}}>
      <div className="quote-document-fields edit-grid">
        <label>客户名称<input maxLength={200} value={draft.customerName} onChange={event=>setDraft(current=>({...current,customerName:event.target.value}))}/></label>
        <label>报价日期<input required type="date" value={draft.quoteDate} onChange={event=>setDraft(current=>({...current,quoteDate:event.target.value}))}/></label>
        {companyFields.map(([key,label])=><label key={key}>{label}<input maxLength={1000} value={draft.company[key]} onChange={event=>setDraft(current=>({...current,company:{...current.company,[key]:event.target.value}}))}/></label>)}
        <label className="span2">交货条款<input maxLength={1000} value={draft.deliveryTerms} onChange={event=>setDraft(current=>({...current,deliveryTerms:event.target.value}))}/></label>
        <label className="span2">附加条款<textarea maxLength={8000} rows={3} value={draft.company.termsTemplate||''} onChange={event=>setDraft(current=>({...current,company:{...current.company,termsTemplate:event.target.value}}))}/></label>
      </div>
      <div className="quote-document-actions"><button className="btn" type="button" onClick={onClose}>取消</button><button className="btn primary" type="submit">保存报价单</button></div>
    </form>
  </Modal>;
}
