import { createHash } from 'node:crypto';
import { rows } from './intake.mjs';

const fields = ['supplierName','unitPrice','currency','uom','condition','moq','leadDays','validFrom','validUntil','certType','taxBasis','authorized','remark'];
const fingerprint = row => createHash('sha256').update(JSON.stringify([row.data,row.updated_at])).digest('hex');
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };

/** Correct the owned source record, preserving prior values and the operator's verification. */
export function createResourceCorrectionStore(db,persist,intake) {
  function locate(inquiryId,evidenceId,ctx) {
    const inquiry=intake.detail(inquiryId,ctx);
    if(!inquiry)fail('询价不存在',404);
    const line=inquiry.lines.find(line=>line.evidence?.some(entry=>entry.id===evidenceId));
    const evidence=line?.evidence.find(entry=>entry.id===evidenceId);
    if(!evidence||evidence.source!=='supplier_price')fail('报价依据已变化，请刷新后重新选择',409);
    const row=rows(db,'SELECT * FROM price_resource WHERE id=?',[evidence.source_key])[0];
    if(!row)fail('供应商报价已不存在',404);
    if(ctx.role!=='master'&&row.account_id!==ctx.accountId)fail('无权修改此供应商报价',403);
    return {inquiry,line,evidence,row};
  }
  return {
    read(inquiryId,evidenceId,ctx) {
      const {line,row}=locate(inquiryId,evidenceId,ctx);
      return {resource:{...JSON.parse(row.data),validFrom:String(JSON.parse(row.data).validFrom||'').slice(0,10),validUntil:String(JSON.parse(row.data).validUntil||'').slice(0,10)},version:fingerprint(row),demand:{partNumber:line.partNumber,quantity:line.quantity,uom:line.uom,condition:line.condition,requirement:line.requirement,needByDate:line.needByDate}};
    },
    save(inquiryId,evidenceId,input,ctx) {
      const {inquiry,line,row}=locate(inquiryId,evidenceId,ctx);
      if(input.version!==fingerprint(row))fail('报价已被修改，请关闭后重新打开核对',409);
      if(input.confirmed!==true||typeof input.reason!=='string'||!input.reason.trim())fail('请填写修改依据，并确认已核实供货条件');
      if(input.reason.length>2000)fail('修改依据请控制在 2000 字以内');
      const previous=JSON.parse(row.data),next={...previous};
      for(const field of fields) {
        if(!Object.hasOwn(input.values||{},field))continue;
        const value=input.values[field];
        if(['unitPrice','moq','leadDays'].includes(field)) {
          if(value===null||value===''){next[field]=null;continue;}
          if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('单价、起订量和交期必须是零或正数');
        } else if(field==='authorized') { if(typeof value!=='boolean')fail('来源确认值无效'); }
        else if(typeof value!=='string'||value.length>2000)fail('报价字段格式无效');
        next[field]=typeof value==='string'?value.trim():value;
      }
      for(const field of ['validFrom','validUntil']) {
        if(next[field]&&!/^\d{4}-\d{2}-\d{2}$/.test(next[field]))fail('请填写有效的报价日期');
        if(next[field]&&(!Number.isFinite(Date.parse(next[field]))||new Date(next[field]).toISOString().slice(0,10)!==next[field]))fail('请填写有效的报价日期');
      }
      if(next.validFrom&&next.validUntil&&next.validFrom>next.validUntil)fail('有效期至应晚于或等于生效日期');
      next.currency=String(next.currency||'').toUpperCase();
      const timestamp=new Date().toISOString();
      let logId;
      db.run('BEGIN');
      try {
        db.run('UPDATE price_resource SET data=?,updated_at=? WHERE id=?',[JSON.stringify(next),timestamp,row.id]);
        db.run('INSERT INTO review_log(task,pn,action,detail,operator,created_at,inquiry_id,account_id) VALUES(?,?,?,?,?,?,?,?)',[
          inquiryId,line.partNumber,'修正供应商报价',JSON.stringify({sourceKey:row.id,before:Object.fromEntries(fields.map(field=>[field,previous[field]])),after:Object.fromEntries(fields.map(field=>[field,next[field]])),reason:input.reason.trim()}),ctx.name,timestamp,inquiry.id,ctx.accountId,
        ]);
        logId=rows(db,'SELECT last_insert_rowid() id')[0].id;
        db.run('COMMIT');
      } catch(error) { db.run('ROLLBACK');throw error; }
      try { persist(); }
      catch(error) {
        db.run('UPDATE price_resource SET data=?,updated_at=? WHERE id=?',[row.data,row.updated_at,row.id]);
        db.run('DELETE FROM review_log WHERE id=?',[logId]);
        throw error;
      }
      return {saved:true,resource:next,version:fingerprint({data:JSON.stringify(next),updated_at:timestamp})};
    },
  };
}
