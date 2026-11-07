# Agent 运行审计接口

核对日期：2026-11-07。来源为 `app/server/index.mjs`、`agent-scope.mjs`、`agent.mjs` 和 `agent-audit-store.mjs`。这是本机原型接口说明，不声明具备生产身份认证、租户隔离或合规审计认证。

## 执行与范围

`POST /api/agent/run`：JSON 请求包含 `instruction`、`lines`、可选 `history` 与 `policy`；业务询价应带 `inquiryId`，兼容旧 `batchId`。instruction 1–2000字符；1–150行、正数数量、唯一 key；history上限12条、每条2000、总12000字符。policy 支持显式 markupRate、marginRate、aogPremium、bulkDiscount、bulkQty，详见输入 schema。

服务器按请求 keys 从当前询价重建字段，不能客户端修改件号、数量后直接绕过持久记录。不存在的询价、重复 key 与跨询价行拒绝。无询价 ID 的兼容请求只能作为旧演示通路，不据此声称持久询价 scope 已验证。

请求限制300KB；带 Origin 时仅接受本机5176工作台。关闭响应或90秒超时触发取消。校验失败400、请求过大413、执行失败/超时502；失败响应使用脱敏 error 和可用的 runId，不返回密钥或模型全文。接口按本机约束实现，不等于访问者鉴权系统。

正常响应包含 `runId`、`status: needs_review`、`model`、`summary`、`answer`、`draft`、`events` 及实际提供的运行回执。公开总结取工具产物，不接受模型自由文本为权威。`draft.mode` 为 analysis/draft；成本证据、suggestedPrice和问题分别表示，analysis不出价。完成请求仍是待审核，不自动写入业务价格、风险确认或导出。

## 只读审计查询

| 接口 | 返回 |
| --- | --- |
| `GET /api/agents` | `{agents:[...]}`，注册的agentId/version、prompt指纹、工具清单、创建时间 |
| `GET /api/agent/runs?inquiryId=…&limit=30` | `{runs:[...]}`；按started_at降序，limit归一至1–100，默认30；省略inquiryId可列本机运行 |
| `GET /api/agent/runs/:runId` | run及按sequence排列的events；不存在404 |

run公开字段包括runId、agentId、version、actorId、inquiryId、status、model、startedAt、finishedAt、durationMs、error、受限input/result摘要与input/costSnapshot/resultFingerprint。event包括eventId、runId、sequence、tool、state、createdAt、durationMs及受限arguments/result摘要，不保存原始prompt、密钥或完整模型输出。

工具执行事件实际为started/done/failed/cancelled/blocked；run状态为running/completed/failed/cancelled。重启遗留running按interrupted收尾，不自动继续模型过程。

## 结构与可信边界

registry主键(agent_id,version)，runs以复合FK引用；events以run_id FK引用runs且(run_id,sequence)唯一。registry和events阻止UPDATE/DELETE，runs阻止DELETE及终态再UPDATE。所有记录由同一数据库持久化，详见 [七表关系图](RFQ-Agent审计关系.html)。

inquiry_id关联为逻辑约定，不是数据库FK。quote_snapshot保存导出内容、inquiry_id和content_sha256，列表已返回inquiry_id/content_sha256，但没有run_id外键。页面刷新后的已导出状态仅在当前内容哈希严格匹配服务端快照时恢复。人工核对和定价仍依赖localStorage及review_log；服务端检查提交版本和reviewed标志，不等于企业审批身份或跨设备审核。输入、成本和结果指纹用于比对，不保留完整成本原快照，不能完整历史重放。SQL trigger不阻止数据库管理员移除约束，不构成不可抵赖签名或可信时间戳。

## 验证证据

2026-11-07单行合成CSV真实模型运行对应receipt、6条started/done事件及两份导出记录位于 `docs/verification/2026-11-07/`。测试与浏览器结果统一见 [验收报告](</Users/suerte/Obsidian/星宫/事业/竞赛/黑客松/2026/MatrixNEXT 2026 AI BUILDER FESTIVAL/04-开发实施/UI与Agent验收报告.md>)。不把一例成功扩写为全部异常或生产能力通过。


## 工作台操作入口（2026-11-07）

助手完成一轮后，结果下方直接显示“查看运行审计”按钮，不再使用“工具与来源”小字折叠入口。点击后读取本轮runId对应的服务端记录，查看运行状态、模型、时间、指纹和工具调用；可以刷新或收起审计。成本在报价卡片直接展示，操作人和接收时间不再常驻材料面板。

审计是查看执行证据，不是报价审批，也不修改库存、单价或人工核对状态；发现错误时，应返回对应询价修改材料/条件，再运行助手，新运行会另记runId并保留旧记录。
