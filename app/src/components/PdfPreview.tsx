import {getAuth} from '../auth';
import {appUrl} from '../engine/appUrl';
import { useEffect, useRef, useState } from "react";

/** Render within the page so preview works in browsers without a native PDF viewer. */
export function PdfPreview({ url, name }: { url: string; name: string }) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1),
    [pages, setPages] = useState(0),
    [width, setWidth] = useState(600);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(160, node.clientWidth - 24)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPage(1);
    setPages(0);
  }, [url]);
  useEffect(() => {
    let live = true,
      dispose = () => {};
    setBusy(true);
    setError("");
    void (async () => {
      const [pdfjs, { default: workerUrl }] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      if (!live) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const token=url.startsWith(appUrl('/api/files/'))?getAuth()?.token:undefined;
      const loading = pdfjs.getDocument({ url, httpHeaders:token?{Authorization:`Bearer ${token}`}:undefined, useSystemFonts: true });
      dispose = () => {
        void loading.destroy().catch(() => {});
      };
      const doc = await loading.promise;
      if (!live) return;
      setPages(doc.numPages);
      const pdfPage = await doc.getPage(Math.min(page, doc.numPages));
      if (!live || !canvas.current) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(width / natural.width, 2),
        ratio = Math.min(devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      const node = canvas.current;
      node.width = viewport.width;
      node.height = viewport.height;
      node.style.width = `${viewport.width / ratio}px`;
      node.style.height = `${viewport.height / ratio}px`;
      await pdfPage.render({ canvas: node, viewport }).promise;
      if (live) setBusy(false);
    })().catch((error) => {
      if (live) {
        setError(error instanceof Error ? error.message : "PDF 读取失败");
        setBusy(false);
      }
    });
    return () => {
      live = false;
      dispose();
    };
  }, [url, page, width, retry]);
  return (
    <div ref={host} className="pdf-preview" aria-label={`${name} PDF 预览`}>
      <div className="pdf-preview-toolbar">
        <button
          type="button"
          className="btn"
          disabled={busy || page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          上一页
        </button>
        <span>{pages ? `第 ${page} 页，共 ${pages} 页` : "PDF"}</span>
        <button
          type="button"
          className="btn"
          disabled={busy || page >= pages}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </button>
      </div>
      {busy && <p role="status">正在显示 PDF…</p>}
      {error && (
        <div role="alert">
          <p>PDF 显示失败</p>
          <button
            type="button"
            className="btn"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}
      <canvas
        ref={canvas}
        aria-label={`${name} 第 ${page} 页`}
        hidden={!!error}
      />
    </div>
  );
}
