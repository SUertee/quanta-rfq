# myserver 部署

生产环境使用独立 Docker Compose 项目 `quanta-rfq`，应用监听容器3000端口；服务器仅绑定 `127.0.0.1:18182`，公网通过既有Caddy和HTTPS访问。共享网络别名为 `quanta-rfq`，不更换现有代理配置。

## 文件位置

- `/home/ubuntu/apps/quanta-rfq/releases/<commit>/`：不可变源码发布目录。
- `/home/ubuntu/apps/quanta-rfq/current`：当前发布链接。
- `/home/ubuntu/apps/quanta-rfq/shared/runtime.env`：权限600的服务端模型/OCR运行密钥，禁止提交。
- `/home/ubuntu/apps/quanta-rfq/shared/release.env`：镜像版本，内容为 `RFQ_IMAGE=quanta-rfq:<commit>`。
- Docker卷 `quanta-rfq_data`：持久化 SQLite，包含服务器新建询价及原件。本机数据库不自动迁移。

## 上线

先在本机执行离线测试、构建、`npm run test:production`（工作目录app）及密钥扫描。只用 `git archive` 打包已提交源码，运行环境文件经SSH单独传输。`.dockerignore`同时排除凭据、数据库和依赖，镜像构建中不提供真实密钥。

服务器发布示例（替换版本号）：

```sh
cd /home/ubuntu/apps/quanta-rfq/releases/<commit>
docker build -t quanta-rfq:<commit> .
# 更新 shared/release.env 的 RFQ_IMAGE，再切换 current 链接
cd /home/ubuntu/apps/quanta-rfq
docker compose -p quanta-rfq --env-file shared/release.env -f current/deploy/compose.yml up -d
```

Caddy域名块指向 `quanta-rfq:3000`，设置 `flush_interval -1` 以透传流式回复。修改共享Caddyfile前必须备份，验证配置后再reload；失败时恢复原文件。

## 验证与回滚

`/healthz`只返回内部API健康状态。按用户确认，静态网页和API均可匿名访问，不再提供HTTP Basic登录挑战；公网经HTTPS使用。`RFQ_ALLOWED_ORIGINS`配置完整域名来源，不能设置通配符。模型和OCR仍使用服务端环境变量。

验证匿名工作台/API200且无WWW-Authenticate头、跨站403、隐藏环境文件404，以及真实聊天流和重建容器后记录仍在。网页、模型请求或健康检查失败时，不应影响已有项目。

回滚：将 `shared/release.env` 指回上一镜像，将current链接切回上一发布目录，再执行相同compose up命令。不要执行 `down -v`，否则会删除业务数据库。迁移前另行备份数据库；跨数据库结构版本不能仅靠旧镜像保证数据回滚。

模型/OCR凭据不记录在本文件，也不放进Caddyfile或镜像。浏览器对话/预览文件仍是浏览器本机存储，与服务器SQLite业务任务的持久化边界不同。

## 项目子路径

访问地址为 `https://projects.suertexu.com/quanta-rfq/?workspace=1`。域名根目录用于项目入口。镜像构建与生产服务均使用 `RFQ_BASE_PATH=/quanta-rfq/`，前端所有项目内请求与链接通过统一URL函数添加前缀。Caddy使用 路径匹配 `/quanta-rfq` 和 `/quanta-rfq/*` 保留前缀转发，由生产服务去除前缀后路由；不能再使用 `handle_path` 重复去除。`/quanta-rfq` 返回308到带斜杠地址。容器内部 `/healthz` 用于健康检查，根域名的 `/api`、`/assets` 不再归RFQ所有。

更换路径需要同步重建镜像与调整代理，不能只修改域名路由。独立数据库卷、密钥和访问凭据保持不变。子路径生产测试包括HTML资源路径、真实静态资源/API200及根API不可达。

域名项目入口和RFQ子路径的完整配置见 [projects.caddy](projects.caddy)。首次切换后的镜像版本为 `b1b8d84`；访问凭据及 `quanta-rfq_data` 卷沿用，未迁移或删除业务数据。

2026-11-07：按用户要求移除站点登录，停用并移除RFQ_ACCESS_USER/RFQ_ACCESS_PASSWORD环境项。只移除站点认证；来源检查、隐藏文件隔离、服务端模型凭据和原数据卷保持不变。
