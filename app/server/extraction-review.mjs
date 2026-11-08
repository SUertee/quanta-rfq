import { createHash } from "node:crypto";
import { rows } from "./intake.mjs";
import { reviewableExtractionIssue } from "../shared/extraction-issues.mjs";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const fingerprint = (batch) =>
  createHash("sha256").update(JSON.stringify(batch)).digest("hex");

export function createExtractionReview(db, persist, getInquiry) {
  db.run(`CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,task TEXT DEFAULT '',pn TEXT DEFAULT '',
    action TEXT DEFAULT '',detail TEXT DEFAULT '',operator TEXT DEFAULT '',created_at TEXT DEFAULT ''
  )`);
  function read(id) {
    const batch = getInquiry(id);
    if (!batch) fail(404, "询价不存在");
    const files = batch.files.filter(
      (file) =>
        ["customer_inquiry", "unknown"].includes(file.document_type) ||
        !file.document_type,
    );
    const issues = batch.issues.filter(reviewableExtractionIssue);
    const blocked = [];
    if (!["needs_input", "evidence_ready"].includes(batch.status))
      blocked.push("材料处理尚未完成");
    if (!files.length) blocked.push("缺少客户询价材料");
    for (const file of files) {
      if (file.document_type !== "customer_inquiry")
        blocked.push(`${file.name} 的资料用途尚未确认`);
      const readable = batch.contents.some(
        (content) => content.file_id === file.id && content.text.trim(),
      );
      const children = files.some((child) => child.parent_id === file.id);
      if (file.status !== "parsed" || (!readable && !children))
        blocked.push(`${file.name} 尚未读取完整`);
    }
    if (!batch.lines.length) blocked.push("尚无物料行");
    if (batch.lines.some((line) => line.issues?.length))
      blocked.push("物料字段仍有待核对项");
    if (!issues.length) blocked.push("没有待复核的提取问题");
    return {
      batch,
      fingerprint: fingerprint(batch),
      issues,
      fileIds: files.map((file) => file.id),
      blocked,
    };
  }
  function confirm(id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail(400, "复核数据无效");
    const before = read(id);
    if (input.fingerprint !== before.fingerprint)
      fail(409, "材料或物料已变化，请载入最新内容后核对");
    if (before.blocked.length) fail(409, before.blocked.join("；"));
    if (
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 2000
    )
      fail(400, "请填写复核依据");
    if (
      typeof input.operator !== "string" ||
      !input.operator.trim() ||
      input.operator.length > 100
    )
      fail(400, "复核人无效");
    const ids = input.fileIds;
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.length !== before.fileIds.length ||
      before.fileIds.some((id) => !ids.includes(id))
    )
      fail(400, "请逐份核对全部客户询价材料");
    const old = rows(
      db,
      "SELECT status,issues,updated_at FROM inquiry WHERE id=?",
      [id],
    )[0];
    const remaining = JSON.parse(old.issues).filter(
      (issue) => !reviewableExtractionIssue(issue),
    );
    const at = new Date().toISOString();
    let logId;
    db.run("BEGIN");
    try {
      db.run("UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?", [
        remaining.length ? "needs_input" : "evidence_ready",
        JSON.stringify(remaining),
        at,
        id,
      ]);
      db.run(
        "INSERT INTO review_log(task,pn,action,detail,operator,created_at) VALUES(?,?,?,?,?,?)",
        [
          id,
          "",
          "人工复核需求提取",
          JSON.stringify({
            schemaVersion: 1,
            fingerprint: before.fingerprint,
            reason: input.reason.trim(),
            issues: before.issues,
            fileIds: ids,
            lines: before.batch.lines.map((line) => ({
              id: line.id,
              version: line.version,
            })),
          }),
          input.operator.trim(),
          at,
        ],
      );
      logId = rows(db, "SELECT last_insert_rowid() id")[0].id;
      db.run("COMMIT");
      persist();
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {}
      db.run("UPDATE inquiry SET status=?,issues=?,updated_at=? WHERE id=?", [
        old.status,
        old.issues,
        old.updated_at,
        id,
      ]);
      if (logId) db.run("DELETE FROM review_log WHERE id=?", [logId]);
      throw error;
    }
    return getInquiry(id);
  }
  return { read, confirm };
}
