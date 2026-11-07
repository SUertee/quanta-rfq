import {appFetch as fetch,appUrl} from '../engine/appUrl';
import { useEffect, useState } from "react";
import type { IntakeBatch } from "../engine/intake";
type Pane = "files" | "issues" | "evidence";
type Evidence = {
  id: string;
  source: string;
  source_key: string;
  snapshot: Record<string, unknown>;
};
const fileStates: Record<string, string> = {
  parsed: "已读取",
  needs_ocr: "待识别",
  unsupported: "不支持的格式",
  failed: "读取失败",
  processing: "读取中",
};
function position(locator?: Record<string, unknown>) {
  if (!locator) return "";
  if (locator.sheet) return `${locator.sheet} · 第 ${locator.row} 行`;
  if (locator.page) return `第 ${locator.page} 页`;
  if (locator.line) return `第 ${locator.line} 行`;
  return "邮件正文";
}
function value(v: unknown) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}
export function IntakeRecord({
  batchId,
  revisionKey,
  view,
  onLoaded,
  onEvidenceRefresh,
}: {
  batchId: string;
  revisionKey?: string;
  view?: Pane | null;
  onLoaded?: (record: IntakeBatch) => void;
  onEvidenceRefresh?:()=>void;
}) {
  const [record, setRecord] = useState<IntakeBatch | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [localPane, setPane] = useState<Pane | null>(null),
    [selected, setSelected] = useState("");
  const pane = view === undefined ? localPane : view;
  const load = async (refresh = false) => {
    setError("");
    setBusy(true);
    try {
      const r = await fetch(
        "/api/inquiries/" +
          encodeURIComponent(batchId) +
          (refresh ? "/evidence" : ""),
        { method: refresh ? "POST" : "GET" },
      );
      if (!r.ok) throw new Error("询价记录读取失败");
      const data = await r.json();
      setRecord(data);
      onLoaded?.(data);
      if(refresh)onEvidenceRefresh?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [batchId, revisionKey]);
  const lines = record?.lines || [];
  const issueCount =
    (record?.issues.length || 0) + lines.filter((l) => l.issues?.length).length;
  const matched = lines.filter(
    (l) => (l as typeof l & { evidence?: Evidence[] }).evidence?.length,
  ).length;
  const line = lines.find((l) => l.id === selected) || lines[0];
  const content = record?.contents.find((c) => c.id === line?.contentId);
  const file = record?.files.find((f) => f.id === content?.file_id);
  const evidence =
    (line as typeof line & { evidence?: Evidence[] })?.evidence || [];
  const toggle = (next: Pane) => setPane((old) => (old === next ? null : next));
  return (
    <section
      className={`inquiry-intake ${view !== undefined ? "stage-intake" : ""}`}
      aria-label="询价处理结果"
      hidden={view === null}
    >
      {view === undefined && (
        <div className="intake-summary">
          <button
            className={pane === "files" ? "active" : ""}
            aria-expanded={pane === "files"}
            onClick={() => toggle("files")}
          >
            <span className="intake-step">1</span>
            <span>
              原始材料 <b>{record?.files.length ?? "—"}</b>
            </span>
            <small>
              {!record
                ? "读取中"
                : record.files.some((f) => f.status !== "parsed")
                  ? "有文件待处理"
                  : "已保存"}
            </small>
          </button>
          <button
            className={pane === "issues" ? "active" : ""}
            aria-expanded={pane === "issues"}
            onClick={() => toggle("issues")}
          >
            <span className="intake-step">2</span>
            <span>
              需求提取 <b>{lines.length}</b>
            </span>
            <small>
              {issueCount ? `${issueCount} 项待核对` : "查看提取结果"}
            </small>
          </button>
          <button
            className={pane === "evidence" ? "active" : ""}
            aria-expanded={pane === "evidence"}
            onClick={() => toggle("evidence")}
          >
            <span className="intake-step">3</span>
            <span>
              报价依据{" "}
              <b>
                {matched}/{lines.length}
              </b>
            </span>
            <small>查看匹配来源</small>
          </button>
        </div>
      )}
      {error && (
        <p className="intake-error" role="alert">
          {error}
        </p>
      )}
      {pane && record && (
        <div className="intake-detail">
          <div className="intake-detail-head">
            <strong>
              {pane === "files"
                ? "原始材料"
                : pane === "issues"
                  ? "提取与待核对项"
                  : "报价依据"}
            </strong>
            {view === undefined && (
              <button
                className="btn"
                aria-label="收起详情"
                onClick={() => setPane(null)}
              >
                收起
              </button>
            )}
          </div>
          {pane === "files" && (
            <div className="intake-files">
              {record.files.map((f) => (
                <a
                  className="intake-file"
                  href={appUrl("/api/files/" + encodeURIComponent(f.id) + "/raw")}
                  key={f.id}
                  download
                >
                  <span className="intake-file-icon">
                    {f.name.split(".").pop()?.toUpperCase()}
                  </span>
                  <span>
                    <b>{f.name}</b>
                    <small>
                      {f.parent_id ? "邮件附件 · " : ""}
                      {fileStates[f.status] || f.status}
                      {f.error ? " · " + f.error : ""}
                    </small>
                  </span>
                  <span aria-hidden="true">↓</span>
                </a>
              ))}
            </div>
          )}
          {pane === "issues" && (
            <div className="intake-issues">
              {record.issues.map((issue, i) => (
                <div className="intake-issue" key={"issue" + i}>
                  <span>待核对</span>
                  {issue}
                </div>
              ))}
              {lines
                .filter((l) => l.issues?.length)
                .map((l) => (
                  <button
                    className="intake-issue"
                    key={l.id}
                    onClick={() => {
                      setSelected(l.id);
                      setPane("evidence");
                    }}
                  >
                    <b>{l.partNumber || "件号待补充"}</b>
                    <span>{l.issues?.join(" · ")}</span>
                    <span>查看原文 ↗</span>
                  </button>
                ))}
              {!issueCount && <p>未发现提取缺口。</p>}
            </div>
          )}
          {pane === "evidence" && (
            <>
              <div className="intake-evidence-toolbar">
                <span>
                  {matched} 行有匹配依据 · {lines.length - matched} 行待补充
                </span>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void load(true)}
                >
                  {busy ? "查询中…" : "刷新依据"}
                </button>
              </div>
              <div className="intake-evidence-layout">
                <nav aria-label="选择物料依据">
                  {lines.map((l) => (
                    <button
                      className={line?.id === l.id ? "active" : ""}
                      key={l.id}
                      onClick={() => setSelected(l.id)}
                    >
                      <b>{l.partNumber || "件号待补"}</b>
                      <small>
                        {l.quantity ?? "—"} {l.uom || ""}
                      </small>
                    </button>
                  ))}
                </nav>
                <div className="intake-evidence-body">
                  {line ? (
                    <>
                      <section className="intake-source" aria-label="原文依据">
                        <div className="intake-source-label">
                          原文 · {file?.name} · {position(content?.locator)}
                        </div>
                        <pre>{content?.text || "无原文"}</pre>
                      </section>
                      {evidence.length ? (
                        evidence.map((e) => (
                          <article className="evidence-card" key={e.id}>
                            <header>
                              <strong>
                                {e.source === "inventory"
                                  ? "内部库存与成本"
                                  : value(e.snapshot.supplierName) ||
                                    "供应商报价"}
                              </strong>
                              <span>
                                {e.snapshot.dataSource === "official_demo"
                                  ? "演示数据"
                                  : e.source === "inventory"
                                    ? "库存记录"
                                    : "供应商报价"}
                              </span>
                            </header>
                            <dl>
                              {(e.source === "inventory"
                                ? [
                                    ["库存数量", e.snapshot.stockQty],
                                    ["单位", e.snapshot.uom],
                                    ["件状", e.snapshot.stockCondition],
                                    [
                                      "最近采购价",
                                      `${value(e.snapshot.lastPurchasePrice)} ${value(e.snapshot.currency)}`,
                                    ],
                                    [
                                      "平均成本",
                                      `${value(e.snapshot.avgCost)} ${value(e.snapshot.currency)}`,
                                    ],
                                    ["仓库", e.snapshot.warehouse],
                                    ["更新日期", e.snapshot.costUpdateDate],
                                  ]
                                : [
                                    [
                                      "供应商单价",
                                      `${value(e.snapshot.unitPrice)} ${value(e.snapshot.currency)}`,
                                    ],
                                    ["起订量", e.snapshot.moq],
                                    ["件状", e.snapshot.condition],
                                    [
                                      "交期",
                                      e.snapshot.leadDays === null
                                        ? "—"
                                        : `${value(e.snapshot.leadDays)} 天`,
                                    ],
                                    ["有效期", e.snapshot.validUntil],
                                    ["证书", e.snapshot.certType],
                                  ]
                              ).map(([label, v]) => (
                                <div key={String(label)}>
                                  <dt>{value(label)}</dt>
                                  <dd>{value(v)}</dd>
                                </div>
                              ))}
                            </dl>
                          </article>
                        ))
                      ) : (
                        <div className="intake-no-evidence">
                          未找到精确件号依据
                        </div>
                      )}
                    </>
                  ) : (
                    <p>暂无可匹配的物料。</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
