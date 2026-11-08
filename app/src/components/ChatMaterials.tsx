import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { SupplierImportDialog } from "./SupplierImportDialog";
import { supplierRequest } from "../engine/supplierImport";
import {
  refreshChatInquiry,
  submitChatSupplier,
  type MaterialPurpose,
  type ChatSupplierRequest,
  type ChatSupplierReceipt,
} from "../engine/chatMaterials";
import type { IntakeBatch } from "../engine/intake";

export function ChatMaterialPurpose({
  value,
  onChange,
  disabled,
}: {
  value: MaterialPurpose;
  onChange: (value: MaterialPurpose) => void;
  disabled: boolean;
}) {
  return (
    <div className="chat-material-purpose" role="group" aria-label="资料用途">
      {(
        [
          ["customer_inquiry", "客户询价"],
          ["supplier_quote", "供应商报价"],
          ["question", "仅提问"],
        ] as const
      ).map(([key, label]) => (
        <button
          type="button"
          className="btn"
          key={key}
          aria-pressed={value === key}
          disabled={disabled}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ChatSupplierFlow({
  request,
  onReceived,
  onCancel,
  onTarget,
}: {
  request: ChatSupplierRequest;
  onTarget: (id: string) => void;
  onReceived: (receipt: ChatSupplierReceipt) => void;
  onCancel: () => void;
}) {
  const [inquiryId, setInquiryId] = useState(request.inquiryId || "");
  const [inquiries, setInquiries] = useState<{ id: string; title: string }[]>(
    [],
  );
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    if (!request.inquiryId)
      void supplierRequest("/api/inquiries")
        .then((data) => {
          if (live.current) setInquiries(data.inquiries);
        })
        .catch((error) => {
          if (live.current) setError(error.message);
        });
    return () => {
      live.current = false;
    };
  }, [request]);
  const read = async () => {
    if (busy || !inquiryId) return;
    setBusy(true);
    setError("");
    onTarget(inquiryId);
    try {
      const receipt = await submitChatSupplier(request, inquiryId);
      if (live.current) onReceived(receipt);
    } catch (error) {
      if (live.current)
        setError(
          error instanceof Error ? error.message : "报价读取失败，请重试",
        );
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="接收供应商报价"
      busy={busy}
      onClose={onCancel}
      className="chat-supplier-dialog"
    >
      <div className="chat-supplier-body">
        <ul className="chat-supplier-files">
          {request.attachments.map((file) => (
            <li key={file.id}>{file.name}</li>
          ))}
        </ul>
        {!request.inquiryId && (
          <>
            <input
              aria-label="搜索询价任务"
              placeholder="搜索询价任务"
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              role="group"
              aria-label="选择询价任务"
              className="chat-supplier-targets"
            >
              {inquiries
                .filter((item) =>
                  `${item.title} ${item.id}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((item) => (
                  <button
                    type="button"
                    className="btn"
                    key={item.id}
                    aria-pressed={item.id === inquiryId}
                    disabled={busy}
                    onClick={() => setInquiryId(item.id)}
                  >
                    {item.title}
                  </button>
                ))}
              {!inquiries.length && !error && (
                <p>暂无询价任务，请先创建客户询价。</p>
              )}
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">正在保存原件并提取供应商报价…</p>}
      </div>
      <footer className="supplier-import-footer">
        <button className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={busy || !inquiryId}
          onClick={() => void read()}
        >
          {busy ? "读取中…" : "读取报价"}
        </button>
      </footer>
    </Modal>
  );
}

export function ChatSupplierResult({
  receipt,
  operator,
  onImported,
  onOpen,
}: {
  receipt: ChatSupplierReceipt;
  operator: string;
  onImported?: (batch: IntakeBatch) => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const ids = receipt.imports.map((item) => item.id).join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(
      receipt.imports.map((item) =>
        supplierRequest(
          `/api/inquiries/${receipt.inquiryId}/supplier-imports/${item.id}`,
        ),
      ),
    )
      .then((results) => {
        if (live) {
          setStatuses(
            Object.fromEntries(results.map((item) => [item.id, item.status])),
          );
          setError("");
        }
      })
      .catch((error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [receipt.inquiryId, ids, open]);
  const confirmed = receipt.imports.every(
    (item) => statuses[item.id] === "confirmed",
  );
  const labels: Record<string, string> = {
    confirmed: "已入库",
    needs_review: "待核对",
    processing: "读取中",
    failed: "读取失败",
  };
  return (
    <section className="chat-inquiry-receipt" aria-label="供应商报价接收结果">
      <header>
        <strong>供应商报价已接收</strong>
        <span>{receipt.imports.length} 份材料</span>
      </header>
      <ul>
        {receipt.imports.map((item) => (
          <li key={item.id}>
            {item.fileName} · {labels[statuses[item.id]] || "读取状态中"}
          </li>
        ))}
      </ul>
      <button className="btn" onClick={() => setOpen(true)}>
        {confirmed ? "查看供应商报价" : "核对报价并入库"}
      </button>
      {onOpen && (
        <button className="btn" onClick={onOpen}>
          打开工作台
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {open && (
        <SupplierImportDialog
          inquiryId={receipt.inquiryId}
          operator={operator}
          initialImportId={receipt.imports[0]?.id}
          onClose={() => setOpen(false)}
          onImported={async () => {
            const batch = await refreshChatInquiry(receipt.inquiryId);
            onImported?.(batch);
          }}
        />
      )}
    </section>
  );
}
