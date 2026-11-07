# RFQ 前三环节：统一接收、需求提取、依据查询

更新：2026-11-06。适用工程：merged-workbench；Node 22.23.1。本文记录本轮实际实现及验证边界，不表示后续检查、核价、审批导出全链路通过。

## 数据落点

继续使用 `app/server/inventory.sqlite`（sql.js SQLite），保留原 inventory、unit_conv、review_log、quote_snapshot。迁移以新增表为主，不删除旧数据；启动前保存一次 `inventory.sqlite.pre-intake.bak`，导出数据库使用临时文件加重命名。旧版浏览器询价不自动迁移，也不删除。

| 表 | 职责和关联 |
| --- | --- |
| inquiry | 询价主记录（首版一次提交创建一份询价）：id、request_id、source、operator、title、created_at、updated_at、status、issues。询价ID关联文件，不靠时间猜关联 |
| file | 文件登记和原始二进制：inquiry_id、parent_id、source、file_type、mime_type、name、sha256、size、raw、解析版本/状态/错误、邮件元信息。邮件附件挂父邮件 |
| file_content | 一个文件对应多条实际内容：file_id、ordinal、locator、format、text、cells。邮件正文、PDF页、工作表行和文本行保留位置 |
| inquiry_line | 结构化需求：inquiry_id、content_id、line_no、fields、issues、method、version。缺字段保留空，原文与字段分开 |
| line_revision | 人工修改前的字段版本、执行人和时间；不覆盖原始文件内容 |
| inventory | 保留现有件号主键、数量/仓库/件状、三类成本、币种和更新时间等字段，仍由现有库存API维护 |
| price_resource | 把原 prices.json 一次性迁入SQL；件号索引、数据JSON、source和更新时间，演示来源明确标 official_demo |
| evidence | 逐行查询出的内部库存成本及供应商报价快照，记录 source、source_key、matched_at；无依据为空，不生成虚构价格 |
| evidence_history | 刷新或修改件号前归档旧的依据快照，保留原匹配时间和归档时间 |
| schema_migration | 一次性播种标记，避免每次启动覆盖价格资源 |

file.source 记录 manual_upload / paste / chat / email_attachment / manual_entry 等进入方式；file_type 记录 eml / xlsx / csv / pdf / txt 等格式，mime_type 单独保留。inquiry.source 与 operator 是业务归属/筛选字段；本机版尚无身份认证，执行人不等于经过验证的权限主体。

[可交互数据库关系图](RFQ接收与依据数据库.html)。source_key 对库存/价格的多态关联由应用查询校验，非SQL外键。现有库存每件号只有一条记录，不支持同件号多仓库/批次库存；本轮未将它描述为生产库存模型。

## 接收及需求提取

新建询价可一次选择多个文件并附加文字，通过同一服务端入口保存。两个入口重试共用 requestId；同一ID同内容返回原批次，不同内容报409。故意另建一批可重用同一文件，文件哈希是追溯依据，不会把不同业务批次强行合并。

- EML：MailParser 解 MIME、编码、正文和真实附件二进制；附件递归进入同一解析入口，不再读取预置样例附件。保留父子关系。
- XLSX：ExcelJS 读取全部工作表，保留工作表名与实际行号，标准表头通过列别名映射。CSV 使用 csv-parse 处理BOM、引号和换行。
- PDF：PDF.js 逐页提取文本，保留页号；无文本页尝试服务端配置的OCR。无配置或失败明确为 needs_ocr，不伪装已解析。暂不支持旧二进制XLS、图片单独导入及任意压缩包。
- 标准表格、带明确字段标签的文字先用确定性映射/规则。未结构化文字再提交服务端模型提取，不再仅在“零行”时兜底。
- LLM返回经过结构校验，contentId必须存在，件号/数量/单位/件状/日期等关键值应在对应原文中找到。无法定位的数量等清空并提示，不以模型猜测补齐。中文数量转换、跨页/跨文件需求合并尚无独立完整验证。
- 邮件正文与附件疑似重复内容不会自动合并不同业务行。未理解内容仍保留；证书、交期等未落实到物料行的文字会标待核对，不静默放行；模型未配置、失败或超限时显示问题，允许人工新增和修改需求行。

为内存版原型设置上传上限：每批1–20个根文件、总原件24MB、单文件8MB；展开附件数量/层级/总大小另有限制；XLSX最多10000行/150列，PDF最多80页。大文件流式解析和持久后台队列不属于本轮交付。

配置沿用服务端 `.env.local` 的 RFQ_LLM_BASE_URL、RFQ_LLM_API_KEY、VITE_LLM_MODEL；OCR另配置 RFQ_OCR_BASE_URL、RFQ_OCR_API_KEY，地址需HTTPS并指向提供 `/parse/sync` 的兼容服务。密钥不随批次返回。旧工作台浏览器端模型设置尚未全量迁移，不能假设修改旧设置会改变服务端提取模型。

## 查询依据与界面

新需求按精确件号查询同一数据库的 inventory 和 price_resource，返回全部候选及快照，不用模型生成成本，不把未匹配当零成本。匹配存在不代表候选已通过有效期、件状、MOQ或证书检查，这些属于下一环节。

详情内“原始材料／需求提取／报价依据”展示原件下载、文件状态、解析方式、原文位置、缺口及库存/供应商依据。可手动刷新依据；刷新会归档旧快照。人工修改需求写回数据库、留修订并重新查询；前端清除该行旧单价和核对标记。人工新增行也产生来源文件、内容、需求与匹配记录。新Agent传递inquiryId，由服务端读取持久需求，客户端不能用另一份行内容替换该批次事实。

新批次状态：processing（处理中）、needs_input（待补充）、evidence_ready（依据查询完成、待核价）、failed、interrupted。evidence_ready不等于报价已完成或已审核。旧任务的工作台状态和审批仍沿用原逻辑，不能宣称已全量统一。

前端优先从数据库读取库存和价格；服务不可用时旧演示回退保留，并显示询价记录未加载提示。库存接口返回空数组时以空库为准，不悄悄恢复静态演示成本。

## API

- POST /api/inquiries：requestId、source、operator、title?、files[{name,mime?,base64}]。
- GET /api/inquiries：支持 source、operator、from、to 筛选；时间为ISO字符串。
- GET /api/inquiries/:id：文件、内容、需求及当前依据，不返回原件二进制。
- GET /api/files/:id/raw：按附件下载原件。
- POST /api/inquiries/:id/evidence：重新查询依据并保存快照。
- PATCH /api/inquiries/:id/lines/:lineId：version、patch、operator，版本冲突返回409。
- POST /api/inquiries/:id/lines：人工补充件号、数量、单位、描述、执行人。
- GET /api/price-resources：统一价格资源查询。

本机API仅监听127.0.0.1，新接口对浏览器Origin限制为本机5176。它不是生产级多租户鉴权，也未接邮箱或客户聊天室。

## 验证结果与限制

`npm run test:intake` 使用隔离SQLite和合成材料，检查真实MIME正文/附件、CSV引号、多工作表、PDF文本及页码、扫描页待OCR、缺失值、来源校验、批次隔离、幂等、部分文件失败、两类依据、刷新、修订、人工新增、来源/执行人筛选、HTTP原件下载与服务重启持久化。真实createAgent循环另由脚本模型测试，不能当作真实模型报价验收。

本轮浏览器已创建一份标注UI验收的合成表格询价，观察到一行物料、原文第二行定位、一条内部库存及三条供应商价格。记录保留供复看。服务端真实模型另处理一条合成自然语言询价：提取出件号1134-2000、数量2、单位EA，件状未提取，留空并标待补充；这只是一次部分成功样例，不是准确率结论。

OCR真实服务尚未验证；完整邮件/PDF格式覆盖、跨文件去重和需求整合、生产权限、价格导入维护界面、审批/报价版本闭环尚未完成。旧工作台仍有模型估价及默认定价规则，未因本轮前三环节改造变成用户确认的六环节完整闭环。

## 解析方案依据

2026-11-06核对：[MailParser](https://nodemailer.com/extras/mailparser)（MIME与附件）、[PDF.js](https://mozilla.github.io/pdf.js/examples/)（文档/逐页读取）、[ExcelJS](https://github.com/exceljs/exceljs)（工作簿读取）、[csv-parse](https://csv.js.org/parse/api/sync/)（标准CSV解析）。依赖版本锁定在 app/package-lock.json。官方资料支持所用接口，不代表所有业务格式已通过验收。


## 表名与工作台调整（2026-11-06）

原 batch 表示一次提交的一组材料；首版一组材料对应一份询价，因此实际主表使用 inquiry，文件和物料通过 inquiry_id 关联。并未额外引入一套独立批次业务。未来向同一询价追加多次上传时，可以再增加独立上传事件，不靠同一时间戳合并不同询价。

所有本轮新增业务表去除 rfq_ 前缀。启动时用事务把旧表改名并同步外键，保留ID、内容、依据与历史；迁移前另存 inventory.sqlite.pre-names.bak。旧/新同名业务表并存时停止迁移，避免覆盖。旧 /api/intake/batches 与文件下载路径保留兼容入口，新页面使用 /api/inquiries。

工作台取消六个跳转步骤与六张大统计卡，以询价标题、三项实际处理结果和物料表作为主结构；物料核对与报价草稿分为同页标签。原始文件、提取问题及库存/供应商依据按需展开；更多操作默认折叠，浮窗助手保持可用。未声明全流程完成。

验证：带数据旧表改名、外键、重复迁移及冲突保护测试通过；构建和前三环节测试通过。界面运行静态检查，尚未做本轮改版的浏览器视觉验收。


现行工作台已调整为左侧六阶段入口，替代此前三项展开条及页签布局；见 [UI 组件与六阶段导航规范](UI组件与六阶段导航规范.md)。
