import {useRef,useState,type PointerEvent} from 'react';
import {Modal} from './Modal';
import {SIGNATURE_WIDTH,SIGNATURE_HEIGHT,signaturePaths,validateSignature,type QuoteSignature as Signature,type SignaturePoint} from '../../shared/signature.mjs';

export function SignaturePreview({signature}:{signature:Signature}) {
  return <svg className="signature-preview" viewBox={`0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}`} role="img" aria-label={`${signature.signer}的签名`}><g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">{signaturePaths(signature.strokes).map((path,index)=><path d={path} key={index}/>)}</g></svg>;
}

export function QuoteSignature({basis,signer,onSave,onClose}:{basis:string;signer:string;onSave:(value:Signature)=>void;onClose:()=>void}) {
  const [name,setName]=useState(signer),[strokes,setStrokes]=useState<SignaturePoint[][]>([]),[error,setError]=useState('');
  const active=useRef<{id:number;points:SignaturePoint[]}|null>(null);
  const pointOf=(event:PointerEvent<SVGSVGElement>):SignaturePoint=>{
    const bounds=event.currentTarget.getBoundingClientRect();
    return [Math.max(0,Math.min(SIGNATURE_WIDTH,(event.clientX-bounds.left)*SIGNATURE_WIDTH/bounds.width)),Math.max(0,Math.min(SIGNATURE_HEIGHT,(event.clientY-bounds.top)*SIGNATURE_HEIGHT/bounds.height))];
  };
  const begin=(event:PointerEvent<SVGSVGElement>)=>{
    if(active.current || event.button!==0)return;
    if(strokes.length>=50){setError('笔画较多，请清除后重签');return;}
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    active.current={id:event.pointerId,points:[pointOf(event)]};setError('');
  };
  const move=(event:PointerEvent<SVGSVGElement>)=>{
    const drawing=active.current;if(drawing?.id!==event.pointerId)return;
    const point=pointOf(event),previous=drawing.points[drawing.points.length-1];
    if(Math.hypot(point[0]-previous[0],point[1]-previous[1])<1)return;
    if(strokes.reduce((count,stroke)=>count+stroke.length,0)+drawing.points.length>=2500){setError('笔画较长，请清除后重签');return;}
    drawing.points.push(point);setStrokes(current=>[...current]);
  };
  const finish=(event:PointerEvent<SVGSVGElement>)=>{
    const drawing=active.current;if(drawing?.id!==event.pointerId)return;
    active.current=null;
    if(event.type!=='pointercancel'&&drawing.points.length>1)setStrokes(current=>[...current,drawing.points]);
    else setStrokes(current=>[...current]);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const clear=()=>{active.current=null;setStrokes([]);setError('');};
  const save=()=>{
    try{onSave(validateSignature({version:1,signer:name,signedAt:new Date().toISOString(),basis,strokes},basis));}
    catch(value){setError(value instanceof Error?value.message:'签名未保存');}
  };
  const visible=active.current?[...strokes,active.current.points]:strokes;
  return <Modal title="报价签名" className="signature-dialog" onClose={onClose}>
    <div className="signature-dialog-body">
      <label className="signature-name">签署人<input aria-label="签署人" maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>
      <svg className="signature-pad" viewBox={`0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="手写签名区" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={()=>{active.current=null;setStrokes(current=>[...current]);}}>
        <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">{signaturePaths(visible).map((path,index)=><path d={path} key={index}/>)}</g>
        {!visible.length&&<text x="320" y="96" textAnchor="middle" className="signature-placeholder">在此签名</text>}
      </svg>
      {error&&<div role="alert" className="check-box">{error}</div>}
    </div>
    <footer className="signature-dialog-actions"><button className="btn" onClick={clear}>清除</button><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!strokes.length||!name.trim()} onClick={save}>确认签名</button></footer>
  </Modal>;
}
