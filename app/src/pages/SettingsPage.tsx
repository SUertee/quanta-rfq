import {appFetch as fetch} from '../engine/appUrl';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../components/ui';
import type { PricingPolicy } from '../engine/pricingPolicy';
import { getAiConfig, saveAiConfig, type AiConfig } from '../engine/config';
import { getCompany, saveCompany, type CompanyInfo } from '../engine/company';
import { listChatModels, llmPing } from '../engine/llm';

const SETTING_SECTIONS = [
  {id:'services',label:'模型配置'},
  {id:'pricing',label:'报价策略'},
  {id:'rules',label:'业务规则'},
  {id:'units',label:'单位换算'},
  {id:'freight',label:'运费核算'},
  {id:'company',label:'企业资料'},
] as const;
type SettingsSection = typeof SETTING_SECTIONS[number]['id'];

/** 设置：AI 服务 + 定价策略 + 业务规则 + 单位换算 + 汇率 + 货运 + 企业资料 */
export function SettingsPage({
  scope = 'platform', policy: initialPolicy, setPolicy: commitPolicy, onRefresh, onClose,
}: {
  scope?: 'platform'|'business'|'all';
  policy: PricingPolicy;
  setPolicy: (p: PricingPolicy) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [activeSection,setActiveSection] = useState<SettingsSection>(scope==='platform'?'services':'pricing');
  const sections = scope==='all'?[...SETTING_SECTIONS.filter(item=>item.id!=='services'),SETTING_SECTIONS[0]]:SETTING_SECTIONS.filter(item=>scope==='platform'?item.id==='services':item.id!=='services');
  const settingsBody = useRef<HTMLDivElement>(null);
  const selectSection = (id: SettingsSection) => { setActiveSection(id); if(settingsBody.current) settingsBody.current.scrollTop=0; };
  const dialog = useRef<HTMLDialogElement>(null);
  const closePrompt = useRef<HTMLDivElement>(null);
  const [policy, setPolicy] = useState(initialPolicy);
  const [baseline, setBaseline] = useState(() => JSON.stringify([getAiConfig(), getCompany(), initialPolicy]));
  const [confirmClose, setConfirmClose] = useState(false);
  const [ai, setAi] = useState<AiConfig>(getAiConfig);
  const [saved, setSaved] = useState('');
  const [testing, setTesting] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [company, setCompany] = useState<CompanyInfo>(getCompany);
  const [units, setUnits] = useState<{ pn: string; uom: string; factor: number }[]>([]);
  const [newUnit, setNewUnit] = useState({ pn: '', uom: 'IN', factor: '' });
  const [unitNote, setUnitNote] = useState('');
  const [previewCost,setPreviewCost]=useState('100');
  const [newFx, setNewFx] = useState({ ccy: '', rate: '' });
  const [fxBusy, setFxBusy] = useState(false);
  const [fxNote, setFxNote] = useState('');

  const addFx = () => {
    const ccy = newFx.ccy.trim().toUpperCase();
    const rate = Number(newFx.rate);
    if (!/^[A-Z]{3}$/.test(ccy)) { setFxNote('币种限 3 位字母（如 USD/JPY/HKD）'); return; }
    if (!Number.isFinite(rate) || rate <= 0) { setFxNote('汇率必须大于 0'); return; }
    setPolicy({ ...policy, fxRates: { ...(policy.fxRates ?? {}), [ccy]: rate } });
    setNewFx({ ccy: '', rate: '' });
    setFxNote(`${ccy} 已加入汇率表`);
  };
  const delFx = (ccy: string) => {
    const next = { ...(policy.fxRates ?? {}) };
    delete next[ccy];
    setPolicy({ ...policy, fxRates: next });
  };
  /** 免费实时汇率（open.er-api.com，USD 为基准换算到 CNY） */
  const fetchLiveFx = async () => {
    setFxBusy(true);
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      const j = await r.json();
      if (j.result !== 'success' || !j.rates?.CNY) throw new Error(j['error-type'] ?? '汇率源返回异常');
      const perCny = j.rates.CNY as number;
      const wanted = ['USD', 'EUR', 'GBP', 'JPY', 'HKD', 'SGD', 'AUD', 'CAD', 'CHF', 'KRW'];
      const next: Record<string, number> = { ...(policy.fxRates ?? {}) };
      for (const c of wanted) if (j.rates[c]) next[c] = Math.round((perCny / j.rates[c]) * 10000) / 10000;
      const date = (j.time_last_update_utc ?? '').slice(0, 16);
      setPolicy({ ...policy, fxRates: next, fxSource: `open.er-api.com ${date}` });
      setFxNote(`已获取 ${wanted.filter((c) => j.rates[c]).length} 个币种实时汇率（${date}）`);
    } catch (e) {
      setFxNote(`获取失败：${e instanceof Error ? e.message : e}，可手工填写`);
    }
    setFxBusy(false);
  };

  const dirty = JSON.stringify([ai, company, policy]) !== baseline;
  const close = () => dirty ? setConfirmClose(true) : onClose();
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (confirmClose) closePrompt.current?.scrollIntoView({ block: 'start' }); }, [confirmClose]);

  useEffect(() => {
    fetch('/api/units')
      .then((r) => r.json())
      .then((j) => setUnits(j.rows ?? []))
      .catch(() => setUnits([]));
  }, []);

  const addUnit = async () => {
    if (!newUnit.pn.trim() || !Number.isFinite(Number(newUnit.factor)) || Number(newUnit.factor) <= 0) {
      setUnitNote('请填写件号和大于 0 的换算系数'); return;
    }
    try {
      const r = await fetch('/api/units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pn: newUnit.pn.trim(), uom: newUnit.uom, factor: Number(newUnit.factor) }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 100));
      const j = await fetch('/api/units').then((x) => x.json());
      setUnits(j.rows ?? []);
      setNewUnit({ pn: '', uom: 'IN', factor: '' });
      setUnitNote('已保存（核价时将按该系数把 IN/FT 归一到 EA）');
      onRefresh();
    } catch (e) { setUnitNote(`保存失败：${e instanceof Error ? e.message : e}（后端未启动？）`); }
  };
  const delUnit = async (u: { pn: string; uom: string }) => {
    try {
      const r = await fetch(`/api/units/${encodeURIComponent(u.pn)}/${encodeURIComponent(u.uom)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setUnits((arr) => arr.filter((x) => !(x.pn === u.pn && x.uom === u.uom)));
      setUnitNote('换算已删除');
      onRefresh();
    } catch { setUnitNote('删除失败，原换算已保留，请检查服务后重试'); }
  };

  const saveAi = () => {
    const savePlatform = scope==='platform'||scope==='all'&&JSON.stringify(ai)!==JSON.stringify(JSON.parse(baseline)[0]);
    if (savePlatform && (!ai.llm.apiKey || !ai.llm.model || !ai.llm.baseUrl)) {
      selectSection('services'); setSaved('请填写模型 API Key、模型名称和接口地址'); return false;
    }
    if (scope!=='platform' && (Object.values(policy).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0)) || policy.marginFloor >= 1 || (policy.fxUsd != null && policy.fxUsd <= 0) || (policy.fxEur != null && policy.fxEur <= 0))) {
      selectSection('pricing'); setSaved('请检查报价策略：金额不能为负数，毛利下限需小于 100%，汇率必须大于 0'); return false;
    }
    if(savePlatform) saveAiConfig(ai);
    if(scope!=='platform') {saveCompany(company);commitPolicy(policy);}
    setBaseline(JSON.stringify([ai, company, policy]));
    setSaved('已保存');
    return true;
  };
  const testAi = async () => {
    setTesting(true);
    const ok = await llmPing(ai.llm);
    setSaved(ok ? '模型连接成功，可以真实运行智能体' : '连接失败，请检查 Key、模型名与接口地址');
    setTesting(false);
  };
  const loadModels = async () => {
    setTesting(true);
    try {
      const models = await listChatModels(ai.llm);
      setModelOptions(models.map((m) => m.id));
      setSaved(`已读取 ${models.length} 个当前 Key 可调用的聊天模型`);
      if (models.length && !models.some((m) => m.id === ai.llm.model)) {
        setAi({ ...ai, llm: { ...ai.llm, model: models[0].id } });
      }
    } catch (e) {
      setSaved(e instanceof Error ? e.message : String(e));
    } finally { setTesting(false); }
  };
  const resetAi = () => {
    setAi(getAiConfig());
    setModelOptions([]);
    setSaved('已还原为上次保存的模型配置');
  };

  const num = (v: number, onChange: (n: number) => void, step = 1, wide = false) => (
    <input className={`policy-input${wide ? ' wide' : ''}`} type="number" step={step} min="0"
      value={v} onChange={(e) => onChange(Number(e.target.value))} />
  );

  return (
    <dialog className="settings-dialog" ref={dialog} aria-labelledby="settings-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      <header className="settings-header">
        <div><h2 id="settings-title">{scope==='business'?'业务配置':'设置'}</h2></div>
        <button className="btn" onClick={close} aria-label="关闭设置">关闭设置 ×</button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical" onKeyDown={event=>{
          const index=sections.findIndex(item=>item.id===activeSection);
          const next=event.key==='ArrowDown'||event.key==='ArrowRight'?(index+1)%sections.length:event.key==='ArrowUp'||event.key==='ArrowLeft'?(index+sections.length-1)%sections.length:event.key==='Home'?0:event.key==='End'?sections.length-1:-1;
          if(next<0)return;
          event.preventDefault();selectSection(sections[next].id);
          event.currentTarget.querySelector<HTMLButtonElement>(`#settings-tab-${sections[next].id}`)?.focus();
        }}>
          {scope==='all'&&<span className="settings-group-label">业务配置</span>}{sections.map(item=><div className="settings-nav-entry" key={item.id}>{scope==='all'&&item.id==='services'&&<span className="settings-group-label">平台设置</span>}<button id={`settings-tab-${item.id}`} type="button" role="tab" aria-selected={activeSection===item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={activeSection===item.id?0:-1} onClick={()=>selectSection(item.id)}>{item.label}</button></div>)}
        </nav>
      <div className="settings-body" ref={settingsBody}>
      {confirmClose && <div ref={closePrompt} className="panel" role="alert"><strong>还有未保存的修改</strong><div className="settings-actions"><button className="btn primary" disabled={testing} onClick={() => { if (saveAi()) onClose(); }}>保存并返回</button><button className="btn" onClick={onClose}>放弃修改并返回</button><button className="btn" onClick={() => setConfirmClose(false)}>继续编辑</button></div></div>}
      <section id="settings-panel-services" role="tabpanel" aria-labelledby="settings-tab-services" hidden={activeSection!=='services'} tabIndex={0}>
      <div className="panel">
        <div className="panel-title">
          模型服务与文档解析配置
          <button className="btn" disabled={testing || !ai.llm.apiKey || !ai.llm.model} onClick={testAi}>{testing ? '请求中…' : '测试模型连接'}</button>
          <button className="btn" disabled={testing} onClick={resetAi}>撤销模型修改</button>
        </div>
        <fieldset disabled={testing} className="ai-grid settings-fields">
          <div className="ai-block">
            <div className="ai-block-title">工作台模型</div>
            <label>API Key
              <input type="password" value={ai.llm.apiKey}
                onChange={(e) => setAi({ ...ai, llm: { ...ai.llm, apiKey: e.target.value.trim() } })} />
            </label>
            <label>模型
              {modelOptions.length ? (
                <select value={ai.llm.model} onChange={(e) => setAi({ ...ai, llm: { ...ai.llm, model: e.target.value } })}>
                  {!modelOptions.includes(ai.llm.model) && <option value={ai.llm.model}>{ai.llm.model}</option>}
                  {modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              ) : (
                <input value={ai.llm.model} onChange={(e) => setAi({ ...ai, llm: { ...ai.llm, model: e.target.value.trim() } })} />
              )}
            </label>
            <button className="btn" disabled={testing || !ai.llm.apiKey} onClick={loadModels}>读取当前 Key 可用模型</button>
            <label>接口地址（高级，默认 /llm 本机代理）
              <input value={ai.llm.baseUrl}
                onChange={(e) => setAi({ ...ai, llm: { ...ai.llm, baseUrl: e.target.value.trim() } })} />
            </label>
          </div>
          <div className="ai-block">
            <div className="ai-block-title">
              联网搜索（非标品估价取证，混元）
              <label className="switch-label">
                <input type="checkbox" checked={ai.search.enabled}
                  onChange={(e) => setAi({ ...ai, search: { ...ai.search, enabled: e.target.checked } })} />
                启用
              </label>
            </div>
            <label>搜索 API Key
              <input type="password" value={ai.search.apiKey}
                onChange={(e) => setAi({ ...ai, search: { ...ai.search, apiKey: e.target.value.trim() } })} />
            </label>
            <label>接口地址（默认 /wsa 元宝搜索代理）
              <input value={ai.search.baseUrl}
                onChange={(e) => setAi({ ...ai, search: { ...ai.search, baseUrl: e.target.value.trim() } })} />
            </label>

          </div>
          <div className="ai-block">
            <div className="ai-block-title">
              文档解析 OXR（扫描件 PDF / 复杂版面）
              <label className="switch-label">
                <input type="checkbox" checked={ai.oxr.enabled}
                  onChange={(e) => setAi({ ...ai, oxr: { ...ai.oxr, enabled: e.target.checked } })} />
                启用
              </label>
            </div>
            <label>接口地址（默认 /oxr，SoMark 免费 API）
              <input value={ai.oxr.baseUrl}
                onChange={(e) => setAi({ ...ai, oxr: { ...ai.oxr, baseUrl: e.target.value.trim() } })} />
            </label>
            <label>API Key（免费版填 dummy 即可）
              <input value={ai.oxr.apiKey}
                onChange={(e) => setAi({ ...ai, oxr: { ...ai.oxr, apiKey: e.target.value.trim() } })} />
            </label>

          </div>
        </fieldset>

      </div>

      </section>
      <section id="settings-panel-pricing" role="tabpanel" aria-labelledby="settings-tab-pricing" hidden={activeSection!=='pricing'} tabIndex={0}>
      <div className="panel">
        <div className="panel-title">报价定价策略 <Badge text="默认值待确认" tone="amber" /></div>
        <div className="policy-row">
          <label>目标加价率 {num(Math.round(policy.margin * 100), (n) => setPolicy({ ...policy, margin: n / 100 }))} %（成本加成）</label>
          <label>毛利下限 {num(Math.round(policy.marginFloor * 100), (n) => setPolicy({ ...policy, marginFloor: n / 100 }))} %</label>
          <label>整单审批上限 {num(policy.orderCapCny, (n) => setPolicy({ ...policy, orderCapCny: n }), 10000, true)} 元</label>
          <label>高于市场价提醒 {num(Math.round(policy.marketPremium * 100), (n) => setPolicy({ ...policy, marketPremium: n / 100 }))} %</label>
          <label>行业/品类关键词
            <input className="policy-input wide" type="text" value={policy.industryKw}
              onChange={(e) => setPolicy({ ...policy, industryKw: e.target.value })} />
          </label>
        </div>

      </div>

      <div className="panel pricing-preview"><div className="panel-title">基础加价试算</div><div className="pricing-preview-row"><label>成本<input aria-label="试算成本" type="number" min="0" value={previewCost} onChange={e=>setPreviewCost(e.target.value)} /></label><span>×</span><label>加价系数<output>{(1+policy.margin).toFixed(2)}</output></label><span>=</span><label>建议单价<output aria-live="polite">{previewCost!==''&&Number.isFinite(Number(previewCost))?(Number(previewCost)*(1+policy.margin)).toFixed(2):'—'}</output></label></div></div>
      </section>
      <section id="settings-panel-rules" role="tabpanel" aria-labelledby="settings-tab-rules" hidden={activeSection!=='rules'} tabIndex={0}>
      <div className="panel">
        <div className="panel-title">业务规则与汇率</div>
        <div className="policy-row">
          <label className="switch-label">
            <input type="checkbox" checked={policy.condFnNe}
              onChange={(e) => setPolicy({ ...policy, condFnNe: e.target.checked })} />
            件状 FN ↔ NE 互认（其余不互认）
          </label>
          <label className="switch-label">
            <input type="checkbox" checked={policy.certMutual}
              onChange={(e) => setPolicy({ ...policy, certMutual: e.target.checked })} />
            证书互认（客户注明"或等效"时接受 FAA/EASA 互认）
          </label>
        </div>
        <div className="policy-row">
          <label>AOG/加急溢价 {num(Math.round(policy.aogPremium * 100), (n) => setPolicy({ ...policy, aogPremium: n / 100 }))} %</label>
          <label>批量折扣 {num(Math.round(policy.bulkDiscount * 100), (n) => setPolicy({ ...policy, bulkDiscount: n / 100 }))} %</label>
          <label>批量门槛 {num(policy.bulkQty, (n) => setPolicy({ ...policy, bulkQty: n }), 10)} 件（0=不启用）</label>
        </div>

        <div className="policy-row">
          <button className="btn" disabled={fxBusy} onClick={fetchLiveFx}>{fxBusy ? '获取中…' : '获取实时汇率'}</button>
          <label>汇率来源/日期
            <input className="policy-input wide" type="text" placeholder="如：央行中间价 2026-11-01"
              value={policy.fxSource ?? ''}
              onChange={(e) => setPolicy({ ...policy, fxSource: e.target.value })} />
          </label>
          {fxNote && <span className="hint" style={{ margin: 0 }}>{fxNote}</span>}
        </div>

        <div className="policy-row">
          <input className="cell-input" placeholder="币种（如 USD/JPY）" value={newFx.ccy}
            onChange={(e) => setNewFx({ ...newFx, ccy: e.target.value.toUpperCase() })} style={{ width: 130 }} />
          <input className="cell-input" type="number" step="0.0001" placeholder="折 CNY"
            value={newFx.rate} onChange={(e) => setNewFx({ ...newFx, rate: e.target.value })} style={{ width: 110 }} />
          <button className="btn" onClick={addFx}>+ 添加币种</button>
        </div>
        {Object.keys(policy.fxRates ?? {}).length > 0 && (
          <table className="sub-table">
            <thead><tr><th>币种</th><th>折 CNY</th><th>操作</th></tr></thead>
            <tbody>
              {Object.entries(policy.fxRates ?? {}).map(([ccy, rate]) => (
                <tr key={ccy}>
                  <td>{ccy}</td>
                  <td>
                    <input className="cell-input" type="number" step="0.0001" value={rate}
                      onChange={(e) => setPolicy({ ...policy, fxRates: { ...(policy.fxRates ?? {}), [ccy]: Number(e.target.value) } })} />
                  </td>
                  <td><button className="btn" onClick={() => delFx(ccy)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(policy.fxUsd||policy.fxEur)&&<div className="legacy-fx-values"><span>USD / CNY <b>{policy.fxUsd??'—'}</b></span><span>EUR / CNY <b>{policy.fxEur??'—'}</b></span></div>}
      </div>

      <div className="panel compliance">
        <div className="settings-data-tags"><Badge text="内置素材：合成演示数据" tone="gray" /><Badge text="素材汇率：参考值" tone="amber" /></div>
      </div>
      </section>
      <section id="settings-panel-units" role="tabpanel" aria-labelledby="settings-tab-units" hidden={activeSection!=='units'} tabIndex={0}>
      <div className="panel">
        <div className="panel-title">物料单位换算</div>

        <div className="policy-row">
          <input className="cell-input" placeholder="件号" value={newUnit.pn}
            onChange={(e) => setNewUnit({ ...newUnit, pn: e.target.value })} />
          <select className="cell-input" value={newUnit.uom} onChange={(e) => setNewUnit({ ...newUnit, uom: e.target.value })}>
            <option value="IN">IN</option>
            <option value="FT">FT</option>
          </select>
          <input className="cell-input" type="number" step="0.01" placeholder="每 EA 折算系数"
            value={newUnit.factor} onChange={(e) => setNewUnit({ ...newUnit, factor: e.target.value })} />
          <button className="btn" onClick={addUnit}>+ 添加换算</button>
          {unitNote && <span className="hint" style={{ margin: 0 }}>{unitNote}</span>}
        </div>
        {units.length > 0 && (
          <table className="sub-table">
            <thead><tr><th>件号</th><th>原单位</th><th>每 EA 系数</th><th>操作</th></tr></thead>
            <tbody>
              {units.map((u) => (
                <tr key={`${u.pn}-${u.uom}`}>
                  <td>{u.pn}</td><td>{u.uom}</td><td>{u.factor}</td>
                  <td><button className="btn" onClick={() => delUnit(u)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      </section>
      <section id="settings-panel-freight" role="tabpanel" aria-labelledby="settings-tab-freight" hidden={activeSection!=='freight'} tabIndex={0}>
      <div className="panel">
        <div className="panel-title">货运成本与费用分摊 <Badge text="按单设置" tone="blue" /></div>
        <div className="policy-row">
          <label>向客户收取运费 {num(policy.freightChargeCny, (n) => setPolicy({ ...policy, freightChargeCny: n }), 50, true)} 元/单</label>
          <label>最低运费 {num(policy.minFreightCny, (n) => setPolicy({ ...policy, minFreightCny: n }), 10, true)} 元/单（0=不设）</label>
          <label>满额免运费 {num(policy.freeFreightOverCny, (n) => setPolicy({ ...policy, freeFreightOverCny: n }), 10000, true)} 元（0=不启用）</label>
          <label>我方货运成本 {num(policy.freightCostCny, (n) => setPolicy({ ...policy, freightCostCny: n }), 50, true)} 元/单</label>
          <label>我方货运时间 {num(policy.freightDays, (n) => setPolicy({ ...policy, freightDays: n }), 1)} 天</label>
          <label>运费分摊方式
            <select className="cell-input" value={policy.freightAlloc}
              onChange={(e) => setPolicy({ ...policy, freightAlloc: e.target.value as PricingPolicy['freightAlloc'] })}>
              <option value="order">整单核算（默认）</option>
              <option value="byLine">按行均摊（内部测算）</option>
              <option value="byValue">按金额比例（内部测算）</option>
            </select>
          </label>
        </div>

      </div>

      </section>
      <section id="settings-panel-company" role="tabpanel" aria-labelledby="settings-tab-company" hidden={activeSection!=='company'} tabIndex={0}>
      <div className="panel">
        <div className="panel-title">
          企业资料与报价单信息

        </div>
        <div className="policy-row">
          <label>供方名称
            <input className="cell-input" value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} />
          </label>
          <label>统一社会信用代码
            <input className="cell-input" value={company.creditCode} onChange={(e) => setCompany({ ...company, creditCode: e.target.value })} />
          </label>
          <label>联系人
            <input className="cell-input" value={company.contact} onChange={(e) => setCompany({ ...company, contact: e.target.value })} />
          </label>
          <label>操作人（记录用）
            <input className="cell-input" value={company.operator} onChange={(e) => setCompany({ ...company, operator: e.target.value })} />
          </label>
        </div>
        <div className="policy-row">
          <label>地址
            <input className="cell-input" value={company.address}
              onChange={(e) => setCompany({ ...company, address: e.target.value })} />
          </label>
          <label>质保-新件(月)
            <input className="policy-input" value={company.warrantyNew} onChange={(e) => setCompany({ ...company, warrantyNew: e.target.value })} />
          </label>
          <label>质保-OH(月)
            <input className="policy-input" value={company.warrantyOh} onChange={(e) => setCompany({ ...company, warrantyOh: e.target.value })} />
          </label>
          <label>报价有效期(天)
            <input className="policy-input" value={company.validityDays} onChange={(e) => setCompany({ ...company, validityDays: e.target.value })} />
          </label>
        </div>

      </div>

      </section>
      </div>
      </div>
      <footer className="settings-footer"><div role="status" aria-live="polite">{saved || (dirty ? '有未保存的修改' : '')}</div><div className="settings-actions"><button className="btn" onClick={close}>返回原页面</button><button className="btn primary" disabled={testing} onClick={() => { if (saveAi()) onClose(); }}>保存并返回</button></div></footer>
    </dialog>
  );
}
