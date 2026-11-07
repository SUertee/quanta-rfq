import type {IntakeBatch} from '../engine/intake';

export type ChatInquiryResult = Pick<IntakeBatch, 'id' | 'title' | 'status'> & {
  fileCount: number;
  lineCount: number;
  issues: string[];
};

export function chatInquiryResult(batch: IntakeBatch): ChatInquiryResult {
  return {
    id: batch.id,
    title: batch.title,
    status: batch.status,
    fileCount: batch.files.length,
    lineCount: batch.lines.length,
    issues: [...new Set([...batch.issues, ...batch.lines.flatMap(line => line.issues || [])])],
  };
}

export function ChatInquiryReceipt({result, onOpen}: {result: ChatInquiryResult; onOpen: () => void}) {
  return <section className="chat-inquiry-receipt" aria-label="询价接收结果">
    <header><strong>{result.title}</strong><span>{result.status === 'evidence_ready' ? '待核对' : '待补全'}</span></header>
    <p>{result.fileCount} 个原文件已保存 · {result.lineCount} 行物料</p>
    {result.issues.length > 0 && <ul>{result.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    <button className="btn" onClick={onOpen}>打开工作台</button>
  </section>;
}
