import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { appFetch } from "../engine/appUrl";
import type { IntakeBatch } from "../engine/intake";

type Review = {
  batch: IntakeBatch;
  fingerprint: string;
  issues: string[];
  fileIds: string[];
  blocked: string[];
};
export function ExtractionCompletionReview({
  inquiryId,
  operator,
  onClose,
  onSaved,
}: {
  inquiryId: string;
  operator: string;
  onClose: () => void;
  onSaved: (batch: IntakeBatch) => void;
}) {
  const [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(""),
    [checked, setChecked] = useState<string[]>([]),
    [reason, setReason] = useState("");
  const epoch = useRef(0);
  const load = async () => {
    const generation = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const response = await appFetch(
        `/api/inquiries/${inquiryId}/extraction-review`,
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "提取结果读取失败");
      if (generation !== epoch.current) return;
      setReview(data);
      setSelected(data.fileIds[0] || "");
      setChecked([]);
      setReason("");
    } catch (error) {
      if (generation === epoch.current)
        setError(error instanceof Error ? error.message : "读取失败");
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, [inquiryId]);
  const confirm = async () => {
    if (!review || busy) return;
    const generation = epoch.current;
    setBusy(true);
    setError("");
    try {
      const response = await appFetch(
        `/api/inquiries/${inquiryId}/extraction-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fingerprint: review.fingerprint,
            fileIds: checked,
            reason,
            operator,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "复核未保存");
      if (generation === epoch.current) onSaved(data);
    } catch (error) {
      if (generation === epoch.current)
        setError(error instanceof Error ? error.message : "复核未保存");
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="核对提取结果"
      className="extraction-review-dialog"
      busy={busy}
      onClose={onClose}
    >
      <div className="extraction-completion-body">
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button className="btn" disabled={busy} onClick={() => void load()}>
              载入最新内容
            </button>
          </div>
        )}
        {review && (
          <>
            <ul className="extraction-review-issues">
              {review.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <div className="extraction-review-body">
              <nav aria-label="逐份核对原文">
                {review.batch.files
                  .filter((file) => review.fileIds.includes(file.id))
                  .map((file) => (
                    <label className="extraction-file-check" key={file.id}>
                      <input
                        type="checkbox"
                        aria-label={`已核对 ${file.name}`}
                        disabled={busy}
                        checked={checked.includes(file.id)}
                        onChange={(e) => {
                          setSelected(file.id);
                          setChecked((old) =>
                            e.target.checked
                              ? [...old, file.id]
                              : old.filter((id) => id !== file.id),
                          );
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        aria-pressed={selected === file.id}
                        disabled={busy}
                        onClick={() => setSelected(file.id)}
                      >
                        {file.name}
                      </button>
                    </label>
                  ))}
              </nav>
              <section aria-label="材料完整正文">
                <pre className="extraction-completion-original">
                  {review.batch.contents
                    .filter((content) => content.file_id === selected)
                    .map((content) => content.text)
                    .join("\n\n") || "此文件正文为空，请核对邮件附件。"}
                </pre>
              </section>
            </div>
            <div className="extraction-completion-lines">
              <table>
                <thead>
                  <tr>
                    <th>件号</th>
                    <th>描述</th>
                    <th>制造商件号</th>
                    <th>数量</th>
                    <th>单位</th>
                    <th>件状</th>
                    <th>到货日期</th>
                    <th>报价截止日期</th>
                    <th>原截止日期</th>
                    <th>要求</th>
                  </tr>
                </thead>
                <tbody>
                  {review.batch.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.partNumber}</td>
                      <td>{line.description || "—"}</td>
                      <td>{line.mpn || "—"}</td>
                      <td>{line.quantity}</td>
                      <td>{line.uom}</td>
                      <td>{line.condition}</td>
                      <td>{line.needByDate || "—"}</td>
                      <td>{line.quoteDeadline || "—"}</td>
                      <td>{line.dueDate || "—"}</td>
                      <td>{line.requirement || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="extraction-completion-reason">
              复核依据
              <textarea
                rows={2}
                maxLength={2000}
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
                placeholder="说明原文要求和物料行的核对结果"
              />
            </label>
            {review.blocked.length > 0 && (
              <ul role="status" className="extraction-review-issues">
                {review.blocked.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {busy && <p role="status">处理中…</p>}
      </div>
      <footer className="supplier-import-footer">
        <button className="btn" disabled={busy} onClick={onClose}>
          返回物料核对
        </button>
        <button
          className="btn primary"
          disabled={
            busy ||
            !review ||
            !!review.blocked.length ||
            checked.length !== review.fileIds.length ||
            !reason.trim()
          }
          onClick={() => void confirm()}
        >
          确认提取完整
        </button>
      </footer>
    </Modal>
  );
}
