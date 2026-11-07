# Quanta · RFQ 工作台

面向航材等备件询价的工作台与报价助手：接收材料 → 提取物料需求 → 查询依据 → 检查条件 → 形成报价草稿 → 人工确认与导出。缺少依据的行不编价格，不连接真实邮箱，不自动发送报价。

## 本地运行

需要 Node.js 22 或以上版本。

```sh
cd app
npm ci
cp .env.example .env.local
# 在本地 .env.local 填写模型接口、密钥和模型名称
npm run server
```

另开终端：

```sh
cd app
npm run dev
```

打开 [RFQ 工作台](http://127.0.0.1:5176/?workspace=1)。后端默认监听本机 3004，前端默认 5176。没有模型或 OCR 配置时，相关调用会明确失败，离线规则测试无需密钥。

模型通过服务端环境变量连接 OpenAI 兼容接口：`RFQ_LLM_BASE_URL`、`RFQ_LLM_API_KEY`、`VITE_LLM_MODEL`（最后一项仅是模型名称，沿用旧命名）。**不要设置 `VITE_*_API_KEY`**，Vite 的前端变量可能进入浏览器构建。页面内旧模型设置保存在本机浏览器，不会修改服务端 `.env.local`；Agent 实际配置以服务端文件或环境变量为准。

## 工程结构

- `app/src/`：工作台、六阶段流程、对话、附件预览与业务规则。
- `app/server/`：SQLite、统一接收/解析、报价 Agent、平台对话和运行审计。
- `app/public/data/`：供页面和测试使用的内置比赛样例数据；不是生产库存，不包含本机新增询价。
- `app/scripts/`：离线验证、数据转换和测试素材。
- `docs/design/`：现行设计与技术资料，部分笔记保留了设计迭代记录。
- `scripts/check_secrets.py`：检查 Git 暂存内容和提交历史，不输出密钥值。

询价和原件保存在本机 `app/server/inventory.sqlite`；对话及关联元数据在浏览器存储，附件预览原件在 IndexedDB。它们均不通过 Git 同步。Agent 输出草稿，用户核对后才可接受价格或导出；审计是本机运行记录，不等同于管理员不可篡改的企业审批。

## 验证与提交

```sh
cd app
npm test
npm run build
cd ..
git add .
python3 scripts/check_secrets.py --history --build
# 新克隆目录启用本地提交/推送检查
git config core.hooksPath .githooks
```

`npm test` 执行离线规则、接收链路、审计、范围隔离、对话流、附件预览和导出检查。它们不等同于真实 OCR、浏览器视觉或完整生产验收。GitHub Actions 也会执行扫描、离线测试及构建。

只提交源码、文档和明确的样例文件。`.env.local`、数据库、上传原件、导出记录、依赖及构建产物被忽略。原始资料和旧工程仍在本地版本对比目录，未纳入本仓库。

[设计文档](docs/README.md) · [整理说明](docs/整理与发布说明.md) · [密钥处理约定](SECURITY.md)

## 服务器运行

生产静态服务和API入口使用 `npm start`，需配置访问凭据与来源白名单。Docker与myserver发布/回滚说明见 [部署说明](deploy/README.md)。本地开发继续使用 `npm run server` 和 `npm run dev`。
