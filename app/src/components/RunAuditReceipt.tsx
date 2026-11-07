import { useEffect, useRef, useState } from 'react';

type AuditEvent = { tool?: string; state?: string; detail?: string; createdAt?: string; durationMs?: number; arguments?: unknown; result?: unknown };
type RunAudit = { runId: string; status?: string; model?: string; startedAt?: string; createdAt?: string; finishedAt?: string; error?: string | { code?: string }; events?: AuditEvent[]; inputFingerprint?: string | null; costSnapshotFingerprint?: string | null; resultFingerprint?: string | null };
const stateLabel = (state?: string) => ({ running: '执行中', started: '已开始', blocked: '已拦截', completed: '已完成', succeeded: '已完成', needs_review: '待核对', failed: '执行失败', aborted: '已停止', cancelled: '已停止', interrupted: '执行中断', done: '已完成' } as Record<string, string>)[state || ''] || state || '未记录';

/** Loads the persisted receipt only on demand; local conversation events are not the audit source. */
export function RunAuditReceipt({ runId }: { runId: string }) {
  const [audit, setAudit] = useState<RunAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const load = async () => {
    if (controller.current || !runId) return;
    const request = new AbortController(); controller.current = request;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}`, { signal: request.signal });
      if (!response.ok) throw new Error(response.status === 404 ? '未找到服务端审计记录；本轮对话回执仍可查看。' : `审计读取失败（${response.status}），可重试。`);
      const data = await response.json() as RunAudit;
      if (data.runId !== runId || !Array.isArray(data.events)) throw new Error('审计记录格式不完整，未采用此结果。');
      if (active.current && !request.signal.aborted) setAudit(data);
    } catch (cause) { if (active.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : '审计暂不可用，可重试。'); }
    finally { if (active.current) setLoading(false); controller.current = null; }
  };
  return <div className="run-audit-receipt" style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6 }}>
    <div className="audit-actions"><button className="btn" disabled={loading} onClick={load}>{loading ? '读取审计…' : audit ? '刷新运行审计' : '查看运行审计'}</button>{audit&&<button className="btn" onClick={()=>setAudit(null)}>收起审计</button>}</div>
    {error && <p role="alert">{error}</p>}
    {audit && <div aria-label="服务端运行审计" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
      <p><strong>服务端记录</strong> · {stateLabel(audit.status)}</p>
      <dl><dt>运行</dt><dd>{audit.runId}</dd>{audit.model && <><dt>模型</dt><dd>{audit.model}</dd></>}{(audit.startedAt || audit.createdAt) && <><dt>开始</dt><dd>{audit.startedAt || audit.createdAt}</dd></>}{audit.finishedAt && <><dt>结束</dt><dd>{audit.finishedAt}</dd></>}{([['输入指纹',audit.inputFingerprint],['成本快照指纹',audit.costSnapshotFingerprint],['结果指纹',audit.resultFingerprint]] as const).filter(([,hash])=>Boolean(hash)).map(([label,hash])=><div key={label}><dt>{label}</dt><dd><code title={hash!}>{hash!.slice(0,12)}…</code></dd></div>)}</dl>
      <section className="audit-events"><h3>工具调用 · {audit.events?.length || 0}</h3>{audit.events?.length ? audit.events.map((event, index) => <p key={index}>{({read_inquiry:'读取询价',lookup_costs:'查询成本',build_quote_draft:'生成草稿'} as Record<string,string>)[event.tool||''] || '运行事件'} · {stateLabel(event.state)}{event.durationMs != null ? ` · ${event.durationMs}ms` : ''}{event.detail&&<span className="audit-event-detail">{event.detail}</span>}</p>) : <p>本次运行未记录工具事件。</p>}</section>
      {audit.error && <p>运行异常：{typeof audit.error === 'string' ? audit.error : audit.error.code || '未记录错误码'}</p>}
    </div>}
  </div>;
}
