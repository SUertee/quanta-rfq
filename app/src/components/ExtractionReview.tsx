import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { appFetch } from "../engine/appUrl";
import type { IntakeBatch } from "../engine/intake";
import {
  fieldConflictIssues,
  FIELD_REVIEW_LABELS,
} from "../../shared/field-review.mjs";

export function ExtractionReview({
  batch,
  operator,
  onClose,
  onSaved,
}: {
  batch: IntakeBatch;
  operator: string;
  onClose: () => void;
  onSaved: (batch: IntakeBatch) => void;
}) {
  const conflicts = batch.lines.flatMap((line) =>
    Object.keys(FIELD_REVIEW_LABELS)
      .filter((field) => fieldConflictIssues(line, field).length)
      .map((field) => ({ line, field })),
  );
  const [selected, setSelected] = useState(0),
    [input, setInput] = useState<string | null>(null),
    [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false);
  const item = conflicts[selected] || conflicts[0];
  useEffect(() => {
    setInput(null);
    setReason("");
    setError("");
    setStale(false);
  }, [batch.id, item?.line.id, item?.field, item?.line.version]);
  if (!item) return null;
  const { line, field } = item;
  const current = (line as Record<string, unknown>)[field];
  const origin = line.fieldSources?.[field];
  const sources = [
    ...(origin?.sources || []),
    ...(origin?.rejectedSources || []),
  ];
  const choices = [
    {
      value: current,
      contentId:
        origin?.contentId ??
        (origin?.method === "manual" ? null : line.contentId),
      label: "当前值",
      locator: origin?.locator,
    },
    ...sources.map((source) => ({
      value: source.value,
      contentId: source.contentId,
      label: "材料值",
      locator: source.locator,
    })),
  ].filter(
    (choice, index, all) =>
      choice.value != null &&
      all.findIndex(
        (other) =>
          String(other.value) === String(choice.value) &&
          other.contentId === choice.contentId,
      ) === index,
  );
  const chosen = input ?? String(current ?? "");
  const save = async () => {
    if (busy || !reason.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await appFetch(
        `/api/inquiries/${batch.id}/lines/${line.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: line.version,
            patch: {
              [field]:
                field === "quantity"
                  ? chosen.trim()
                    ? Number(chosen)
                    : null
                  : chosen,
            },
            confirmFields: [field],
            confirmationReason: reason,
            operator,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        setStale(response.status === 409);
        throw Error(data.error || "确认未保存");
      }
      onSaved(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "确认未保存");
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    try {
      const response = await appFetch(`/api/inquiries/${batch.id}`);
      if (!response.ok) throw Error("最新物料读取失败");
      setInput(null);setReason("");setStale(false);setError("");
      onSaved(await response.json());
    } catch (error) {
      setError(error instanceof Error ? error.message : "最新物料读取失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="核对提取冲突"
      busy={busy}
      onClose={onClose}
      className="extraction-review-dialog"
    >
      <div className="extraction-review-body">
        <nav aria-label="提取冲突字段">
          {conflicts.map((entry, index) => (
            <button
              type="button"
              className="btn"
              key={`${entry.line.id}:${entry.field}`}
              aria-pressed={index === selected}
              disabled={busy}
              onClick={() => {
                setSelected(index);
                setInput(null);
                setReason("");
                setError("");
                setStale(false);
              }}
            >
              {entry.line.partNumber || "缺件号"} ·{" "}
              {FIELD_REVIEW_LABELS[entry.field]}
            </button>
          ))}
        </nav>
        <section className="extraction-review-field" aria-label="字段取值核对">
          <h3>{FIELD_REVIEW_LABELS[field]}</h3>
          <ul className="extraction-review-issues">
            {fieldConflictIssues(line, field).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <div
            className="extraction-review-choices"
            role="group"
            aria-label="选择字段取值"
          >
            {choices.map((choice, index) => {
              const content = batch.contents.find(
                (content) => content.id === choice.contentId,
              );
              const locator = choice.locator || content?.locator;
          const file = batch.files.find(
                (file) => file.id === content?.file_id,
              );
              return (
                <section key={index}>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    aria-pressed={chosen === String(choice.value)}
                    onClick={() => setInput(String(choice.value))}
                  >
                    {choice.label} · {String(choice.value)}
                  </button>
                  <p>
                    {file?.name || "人工值"}
                    {locator?.page
                      ? ` · 第${locator.page}页`
                      : locator?.row
                        ? ` · 第${locator.row}行`
                        : locator?.line
                          ? ` · 第${locator.line}行`
                          : ""}
                  </p>
                  {locator?.column ? ` · 第${locator.column}列` : ""}{content && <pre>{content.text}</pre>}
                </section>
              );
            })}
          </div>
          <label>
            确认值
            <input
              aria-label="确认值"
              type={field === "quantity" ? "number" : "text"}
              value={chosen}
              disabled={busy || stale}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <label>
            确认依据
            <textarea
              aria-label="确认依据"
              rows={2}
              maxLength={1000}
              value={reason}
              disabled={busy || stale}
              placeholder="说明采用该值的依据"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
        </section>
      </div>
      <footer className="supplier-import-footer">
        <button className="btn" disabled={busy} onClick={onClose}>
          取消
        </button>
        {stale ? (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void reload()}
          >
            载入最新物料
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={
              busy ||
              !reason.trim() ||
              (field === "quantity" &&
                chosen.trim() !== "" &&
                (!Number.isFinite(Number(chosen)) || Number(chosen) <= 0))
            }
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "确认取值"}
          </button>
        )}
      </footer>
    </Modal>
  );
}
