import { useEffect, useState } from 'react';
import type { Dataset } from '../data';
import {
  EVAL_FIELDS, loadGroundTruth, runCaseEvaluation,
  type EvalReport, type GroundTruthFile,
} from '../engine/evaluate';
import { Badge, StatCard } from '../components/ui';

const CASES = [
  { caseId: 'case1', label: '案例1 · 脏数据（字段连写）' },
  { caseId: 'case2', label: '案例2 · 净数据（Tab 规范表）' },
];

const pct = (v?: number) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** B9 评测面板：接口已留好。评测集（人工标注 ground truth）录入后即可出实测指标。 */
export function EvalPage({ ds }: { ds: Dataset }) {
  const [status, setStatus] = useState<Record<string, 'loading' | 'ready' | 'missing'>>({});
  const [gts, setGts] = useState<Record<string, GroundTruthFile>>({});
  const [reports, setReports] = useState<Record<string, EvalReport | null>>({});
  const [busy, setBusy] = useState(false);
  const [importError,setImportError]=useState('');
  const importTruth=async(file:File,caseId:string)=>{try{setImportError('');const data=JSON.parse(await file.text());if(data.caseId!==caseId||!['dirty','clean','synthetic'].includes(data.inputKind)||typeof data.emailId!=='string'||!ds.emails.some(e=>e.id===data.emailId)||!Array.isArray(data.lines)||!data.lines.length||data.lines.length>1000||data.lines.some((row:Record<string,unknown>)=>EVAL_FIELDS.some(k=>k==='quantity'?typeof row[k]!=='number'||!(Number(row[k])>0):typeof row[k]!=='string')))throw new Error('标注格式无效：请核对案例、字段及有效数量');setGts(old=>({...old,[caseId]:data}));setStatus(old=>({...old,[caseId]:'ready'}));setReports(old=>({...old,[caseId]:null}));}catch(e){setImportError(String(e))}};
  const downloadTemplate=(caseId:string)=>{const blob=new Blob([JSON.stringify({caseId,inputKind:caseId==='case1'?'dirty':'clean',emailId:caseId==='case1'?'case1-dirty':'case2-clean',lines:[]},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=caseId+'-标注模板.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};

  useEffect(() => {
    (async () => {
      for (const c of CASES) {
        const gt = await loadGroundTruth(c.caseId);
        setStatus((s) => ({ ...s, [c.caseId]: gt ? 'ready' : 'missing' }));
        if (gt) setGts((g) => ({ ...g, [c.caseId]: gt }));
      }
    })();
  }, []);

  const run = async (caseId: string) => {
    setBusy(true);
    try{const report=await runCaseEvaluation(ds,gts[caseId]);setReports(r=>({...r,[caseId]:report}));}catch(e){setImportError(String(e));}finally{setBusy(false);}
  };

  return (
    <div>
      <div className="page-heading"><h1>能力评测</h1></div>{importError&&<div role="alert" className="check-box">{importError}</div>}
      {CASES.map((c) => {
        const st = status[c.caseId];
        const rep = reports[c.caseId];
        return (
          <div className="panel" key={c.caseId}>
            <div className="panel-title">
              {c.label}
              <label className="btn">导入标注<input aria-label={`${c.label}导入标注`} type="file" accept=".json" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];if(f)void importTruth(f,c.caseId);e.target.value=''}} /></label>
              <button className="btn" onClick={()=>downloadTemplate(c.caseId)}>下载模板</button>
              {st === 'missing' && <Badge text="评测集未录入" tone="amber" />}
              {st === 'ready' && <Badge text={`已录入 ${gts[c.caseId].lines.length} 行`} tone="green" />}
              {st === 'ready' && (
                <button className="btn primary" disabled={busy} onClick={() => run(c.caseId)}>
                  {busy ? '评测中…' : '运行评测'}
                </button>
              )}
            </div>

            {rep && (
              <>
                <div className="stat-row">
                  <StatCard label="字段抽取准确率" value={pct(rep.fieldAccOverall)} />
                  <StatCard label="件号匹配率" value={pct(rep.matchRate)} />
                  <StatCard label="条件筛查召回" value={pct(rep.flagRecall)} />
                  <StatCard label="端到端人工修改率" value={pct(rep.humanEditRate)} />
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>字段</th><th>正确</th><th>总数</th><th>准确率</th></tr></thead>
                    <tbody>
                      {rep.fieldAcc.map((f) => (
                        <tr key={f.field}>
                          <td>{f.field}</td><td>{f.correct}</td><td>{f.total}</td><td>{pct(f.acc)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!rep && st === 'missing' && (
              <Badge text="未验证" tone="gray" />
            )}
          </div>
        );
      })}
    </div>
  );
}
