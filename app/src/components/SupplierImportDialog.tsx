import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import {
  supplierRequest,
  uploadSupplier,
  type SupplierImport,
  type SupplierValues,
} from "../engine/supplierImport";
const fields: {
  key: Exclude<keyof SupplierValues, "authorized" | "taxBasis">;
  label: string;
  numeric?: boolean;
}[] = [
  { key: "partNumber", label: "件号" },
  { key: "supplierName", label: "供应商" },
  { key: "unitPrice", label: "单价", numeric: true },
  { key: "currency", label: "币种" },
  { key: "uom", label: "单位" },
  { key: "condition", label: "件状" },
  { key: "moq", label: "最小起订量", numeric: true },
  { key: "leadDays", label: "交期天数", numeric: true },
  { key: "validFrom", label: "生效日期" },
  { key: "validUntil", label: "有效期至" },
  { key: "certType", label: "证书类型" },
  { key: "remark", label: "备注" },
];
const states: Record<string, string> = {
  processing: "读取中",
  needs_review: "待核对",
  confirmed: "已入库",
  failed: "读取失败",
};
export function SupplierImportDialog({
  inquiryId,
  operator,
  onClose,
  onImported,
}: {
  inquiryId: string;
  operator: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [imports, setImports] = useState<SupplierImport[]>([]),
    [current, setCurrent] = useState<SupplierImport | null>(null);
  const [activeRow, setActiveRow] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null),
    pending = useRef<{ file: File; requestId: string } | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void supplierRequest(`/api/inquiries/${inquiryId}/supplier-imports`)
      .then((data) => {
        if (live.current) setImports(data.imports);
      })
      .catch((error) => {
        if (live.current) setError(error.message);
      });
    return () => {
      live.current = false;
    };
  }, [inquiryId]);
  const receive = (result: SupplierImport) => {
    setCurrent(result);
    setActiveRow(result.rows[0]?.id || "");
    setImports((old) => [
      result,
      ...old.filter((item) => item.id !== result.id),
    ]);
  };
  useEffect(() => {
    if (current?.status !== "processing") return;
    const timer = setTimeout(() => {
      void supplierRequest(
        `/api/inquiries/${inquiryId}/supplier-imports/${current.id}`,
      )
        .then((result) => {
          if (live.current) receive(result);
        })
        .catch((error) => {
          if (live.current) setError(error.message);
        });
    }, 1000);
    return () => clearTimeout(timer);
  }, [current, inquiryId]);
  const read = async () => {
    if (!pending.current || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await uploadSupplier(
        inquiryId,
        pending.current.file,
        operator,
        pending.current.requestId,
      );
      if (live.current) {
        receive(result);
        pending.current = null;
      }
    } catch (error) {
      if (live.current)
        setError(error instanceof Error ? error.message : "报价读取失败");
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const selected =
    current?.rows.find((row) => row.id === activeRow) || current?.rows[0];
  const update = (
    key: keyof SupplierValues,
    value: SupplierValues[keyof SupplierValues],
  ) =>
    setCurrent((old) =>
      old
        ? {
            ...old,
            rows: old.rows.map((row) =>
              row.id === selected?.id
                ? { ...row, values: { ...row.values, [key]: value } }
                : row,
            ),
          }
        : old,
    );
  const confirm = async () => {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await supplierRequest(
        `/api/inquiries/${inquiryId}/supplier-imports/${current.id}/confirm`,
        {
          version: current.version,
          operator,
          rows: current.rows.map((row) => ({ id: row.id, ...row.values })),
        },
      );
      if (live.current) receive(result);
      await onImported();
    } catch (error) {
      if (live.current)
        setError(error instanceof Error ? error.message : "报价入库失败");
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="导入供应商报价"
      className="supplier-import-dialog"
      busy={busy}
      onClose={onClose}
    >
      <div className="supplier-import-body">
        <div className="supplier-import-actions">
          <input
            ref={upload}
            type="file"
            hidden
            accept=".csv,.xlsx,.pdf,.txt,.eml,.png,.jpg,.jpeg,.webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              pending.current = { file, requestId: crypto.randomUUID() };
              void read();
              event.target.value = "";
            }}
          />
          <button
            className="btn"
            disabled={busy}
            onClick={() => upload.current?.click()}
          >
            选择报价文件
          </button>
          {pending.current && error && (
            <button className="btn" disabled={busy} onClick={() => void read()}>
              重试读取
            </button>
          )}
          {busy && <span role="status">处理中…</span>}
        </div>
        {error && <p role="alert">{error}</p>}
        {imports.length > 0 && (
          <nav className="supplier-import-list" aria-label="报价导入记录">
            {imports.map((item) => (
              <button
                className="btn"
                key={item.id}
                disabled={busy}
                aria-pressed={current?.id === item.id}
                onClick={() => {
                  receive(item);
                  setError("");
                }}
              >
                {item.fileName || "报价文件"} · {states[item.status]} ·{" "}
                {item.rows.length} 行
              </button>
            ))}
          </nav>
        )}
        {current?.issues.length ? (
          <ul className="supplier-import-issues">
            {current.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        {current && current.rows.length > 0 && (
          <>
            <div className="supplier-import-table">
              <table>
                <thead>
                  <tr>
                    <th>件号</th>
                    <th>供应商</th>
                    <th>单价</th>
                    <th>币种</th>
                    <th>原文位置</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {current.rows.map((row) => (
                    <tr
                      key={row.id}
                      className={selected?.id === row.id ? "selected" : ""}
                    >
                      <td>{row.values.partNumber || "待补充"}</td>
                      <td>{row.values.supplierName || "待补充"}</td>
                      <td>{row.values.unitPrice ?? "待补充"}</td>
                      <td>{row.values.currency || "待补充"}</td>
                      <td>
                        {String(row.locator.sheet || "")} · 第{" "}
                        {String(row.locator.row || row.locator.page || "?")} 行
                      </td>
                      <td>
                        <button
                          className="btn"
                          onClick={() => setActiveRow(row.id)}
                        >
                          核对
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selected && (
              <section
                aria-label="核对报价字段"
                className="supplier-import-fields"
              >
                <h3>{selected.values.partNumber || "报价字段"}</h3>
                <div className="supplier-field-grid">
                  {fields.map((field) => (
                    <label key={field.key}>
                      <span>{field.label}</span>
                      <input
                        aria-label={field.label}
                        type={field.numeric ? "number" : "text"}
                        min={
                          field.key === "leadDays"
                            ? 0
                            : field.numeric
                              ? 0.01
                              : undefined
                        }
                        step="any"
                        placeholder={
                          field.key === "validFrom" ||
                          field.key === "validUntil"
                            ? "YYYY-MM-DD"
                            : undefined
                        }
                        value={selected.values[field.key] ?? ""}
                        disabled={busy || current.status === "confirmed"}
                        onChange={(event) =>
                          update(
                            field.key,
                            field.numeric
                              ? event.target.value === ""
                                ? null
                                : Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                <fieldset disabled={busy || current.status === "confirmed"}>
                  <legend>计税口径</legend>
                  {[
                    ["", "待确认"],
                    ["inclusive", "含税"],
                    ["exclusive", "未税"],
                  ].map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="supplier-tax"
                        checked={selected.values.taxBasis === value}
                        onChange={() => update("taxBasis", value)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <label className="supplier-source-confirm">
                  <input
                    type="checkbox"
                    checked={selected.values.authorized}
                    disabled={busy || current.status === "confirmed"}
                    onChange={(event) =>
                      update("authorized", event.target.checked)
                    }
                  />
                  已核对该供应商报价的来源与授权
                </label>
              </section>
            )}
          </>
        )}
      </div>
      <footer className="supplier-import-footer">
        <button className="btn" disabled={busy} onClick={onClose}>
          关闭
        </button>
        {current?.status === "needs_review" && (
          <button
            className="btn primary"
            disabled={busy || !!current.issues.length || !current.rows.length}
            onClick={() => void confirm()}
          >
            确认入库并刷新依据
          </button>
        )}
        {current?.status === "confirmed" && <span role="status">已入库</span>}
      </footer>
    </Modal>
  );
}
