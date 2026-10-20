# ReleaseDock（发布坞）

> 简体中文 | [English](README.md)

多软件升级分发系统：基于 **Cloudflare Workers + R2 + D1**，提供版本查询、Changelog 拼接、受控下载与发布管理。

架构、数据模型与接口契约见 [docs/开发文档.md](docs/开发文档.md)。当前进度：**阶段一～三已完成**（查询 / 下载 / 登记 / 上线 / 回滚 / 强制更新阈值 / 灰度调整 / 速率限制 / 基础监控 / 客户端更新库 / CI 示例），65 个自动化测试全部通过。

## 目录结构

```
src/
├── index.ts                # Hono 入口、统一错误处理
├── types.ts                # Env 绑定与 API DTO
├── errors.ts               # 错误码（文档第 10 节）
├── middleware/
│   ├── adminAuth.ts        # 管理接口 Bearer Token
│   └── rateLimit.ts        # 查询/下载限流（ratelimit 绑定，缺失时跳过）
├── routes/
│   ├── updates.ts          # GET /v1/updates/:appId/:channel
│   ├── download.ts         # GET /v1/download/:releaseId
│   └── admin.ts            # /v1/admin/*（建应用/登记/上线/回滚/阈值/灰度/列表）
├── services/
│   ├── releases.ts         # D1 数据访问、指针移动（上线/回滚共用 CAS）
│   ├── changelog.ts        # Changelog 拼接（最多 5 个版本）
│   └── metrics.ts          # Analytics Engine 基础监控
└── utils/                  # semver 比较、灰度哈希、ID 生成
client/                     # 客户端更新库（releasedock-client，纯 Web API）
├── src/index.ts            # 查询 / 下载 / SHA-256 校验 / 进度（Node、Electron、浏览器通用）
├── src/node.ts             # Node 专用：流式下载到文件，失败自动清理
└── test/                   # 库测试
migrations/                 # D1 迁移
scripts/seed-demo.sql       # 本地演示数据（只建应用与通道）
.github/workflows/release.yml  # CI 发布流水线示例
```

## 本地开发

无需 Cloudflare 账号，wrangler 会在本地模拟 D1 与 R2。

```bash
npm install
npm run db:migrate:local     # 应用 D1 迁移
npm run dev                  # 启动 wrangler dev，默认 http://127.0.0.1:8787
npm test                     # 运行全部 65 个测试
npm run typecheck            # 服务端 + 客户端库类型检查
```

本地管理 Token 在 `.dev.vars` 中：`ADMIN_TOKEN=dev-admin-token-change-me`。

### 发布操作示例（curl）

```bash
BASE=http://127.0.0.1:8787
TOKEN="Authorization: Bearer dev-admin-token-change-me"

# 1. 创建应用
curl -X POST $BASE/v1/admin/apps -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"com.example.demo","name":"演示应用"}'

# 2. 上传更新包（推荐）：向管理接口申请预签名 URL，下游只需管理 Token，无需 Cloudflare S3 凭据
curl -X POST $BASE/v1/admin/uploads/presign -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"com.example.demo","channel":"stable","version":"1.0.0","filename":"setup.exe"}'
# -> {"upload_url":"https://<account>.r2.cloudflarestorage.com/releasedock-packages/…?X-Amz-Signature=…",
#     "method":"PUT","headers":{},"r2_key":"…","expires_at":"…"}
curl -X PUT --data-binary @./your-setup.exe "<upload_url>"    # 不要附加任何自定义头

# 备选（CI 侧持有 R2 凭据时）：
# npx wrangler r2 object put releasedock-packages/com.example.demo/stable/1.0.0/setup.exe --file ./your-setup.exe --remote

# 3. 登记版本（draft，客户端不可见）
curl -X POST $BASE/v1/admin/releases -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"com.example.demo","channel":"stable","version":"1.0.0",
       "r2_key":"com.example.demo/stable/1.0.0/setup.exe",
       "sha256":"<64位十六进制>","size":12345,
       "changelog":["首个版本","修复登录超时问题"],"rollout":10}'
# 返回 {"release_id":"rel_xxx",...}

# 4. 上线（首次省略 expected；之后必须带当前指针做乐观并发控制）
curl -X POST $BASE/v1/admin/releases/rel_xxx/promote -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{}'

# 5. 调整灰度比例（可随时改，无需重新发版）
curl -X PATCH $BASE/v1/admin/releases/rel_xxx -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{"rollout":50}'

# 6. 回滚到旧版本（必须带当前指针）
curl -X POST $BASE/v1/admin/releases/rel_old/rollback -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{"expected_current_release_id":"rel_xxx"}'

# 7. 设置强制更新阈值
curl -X PATCH $BASE/v1/admin/apps/com.example.demo/channels/stable -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{"min_supported_version":"1.1.0"}'

# 8. 客户端查询与下载
curl "$BASE/v1/updates/com.example.demo/stable?current=0.9.0&client_id=<uuid>"
# download_url 是短时效 R2 预签名直链（不经过 Worker）；download_api_url 是 Worker 兜底地址；
# sha256 在 JSON 响应里，下载完成后必须比对
curl -o setup.exe "$(curl -s "$BASE/v1/updates/...&current=0.9.0" | jq -r .download_url)"
sha256sum setup.exe
```

> Windows 注意：curl -d 内联中文可能被控制台按 GBK 发出导致存储乱码，建议把请求体写成 UTF-8 文件后用 `--data-binary @file.json`。

## 客户端更新库（releasedock-client）

所有软件共用，只负责查询、下载、SHA-256 校验与进度回调；安装逻辑通过回调交给各软件（文档 8.5）。非 Node 程序（Python/C/C++/Qt 等）直接按 HTTP 契约集成即可，见开发文档 4.2/4.3。

```ts
import { checkForUpdate } from "./client/src/index";
// Node/Electron 大文件场景：import { downloadToFile } from "./client/src/node";

const info = await checkForUpdate({
  baseUrl: "https://releasedock.xxxxx.workers.dev",
  appId: "com.example.demo",
  channel: "stable",
  currentVersion: app.getVersion(),
  clientId: persistedUuid,          // 首次启动生成并保存，用于灰度分流
});

if (!info.updateAvailable) return;
if (info.mandatory) showBlockingDialog(info.changelog);
else showOptionalDialog(info.changelog);

const { bytes, sha256 } = await info.download!({
  onProgress: (loaded, total) => updateProgressBar(loaded, total),
});
// bytes 已通过 SHA-256 校验，交给安装器
```

大文件建议用流式版本（校验失败会自动删除半成品文件）：

```ts
import { downloadToFile } from "./client/src/node";
await downloadToFile(info.downloadUrl!, {
  sha256: info.sha256!, filePath: "/tmp/app-setup.exe",
  onProgress: (loaded, total) => updateProgressBar(loaded, total),
});
```

## AI 集成技能

[`skills/releasedock-integration/`](skills/releasedock-integration/SKILL.md) 是面向 AI 编程助手的技能包（SKILL.md 格式）：下游软件用什么语言开发，AI 装上它就知道如何集成更新检查、如何自动化发布。把文件夹复制到下游项目的技能目录（`.zcode/skills/`、`.claude/skills/` 等），或直接把文件投喂给 AI。内含客户端行为规则、完整 HTTP 契约（[references/api.md](skills/releasedock-integration/references/api.md)）、各语言实现配方（Python/C/C#/Go/Qt/Rust/Java，[references/recipes.md](skills/releasedock-integration/references/recipes.md)）和零依赖可直接运行的 Python 示例。

## CI 集成

`.github/workflows/release.yml` 是可直接复制的模板：手动触发，自动完成「计算 SHA-256 → 上传 R2 → 登记 draft →（可选）上线」。上线前自动读取当前 live 指针做乐观并发控制；建议日常灰度发布，观察错误率后再手动触发全量。需要在仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` 与 `RELEASEDOCK_ADMIN_TOKEN`。

## 部署到 Cloudflare

当前已部署：**https://releasedock.xxxxx.workers.dev**（D1 `releasedock` + R2 `releasedock-packages`，区域 WNAM，2026-10-20 首次部署）。

后续重新部署只需：

```bash
npm run deploy
```

首次部署完整流程（新账号参考）：

```bash
npx wrangler login
npx wrangler d1 create releasedock        # 把返回的 database_id 填入 wrangler.jsonc
npx wrangler r2 bucket create releasedock-packages   # 需先在控制台开通 R2
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN       # 生产管理 Token，勿与本地相同
# 预签名上传需要 R2 S3 API Token（控制台 R2 → Manage API Tokens，权限 Object Read & Write，
# 桶范围仅 releasedock-packages）；若只用 wrangler 上传则无需这三项
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npm run deploy
```

建议同时为 `/v1/admin/*` 启用 Cloudflare Access（服务令牌或邮箱白名单），与 Bearer Token 双重保护。

## 已确认决策（相对文档的落地口径）

| 事项 | 决策 |
| :--- | :--- |
| Changelog 格式（文档待确认 6） | 存储与返回均为结构化字符串数组 `string[]` |
| 下载通道 | 查询响应下发**短时效 R2 预签名直链**（`download_url`，1 小时），载荷完全绕过 Worker；`download_api_url` 为 Worker 兜底，`download_expires_at` 供客户端判断何时需重新查询。原因：实测跨境链路上 Worker 下载被限速到约 6KB/s，R2 直链 20MB 仅 2.5 秒。未配置 R2 凭据时自动回退为 Worker 地址 |
| 下载鉴权（文档待确认 2） | 载荷不鉴权：对象键不可猜测 + 预签名短时效；`draft` 版本永不签发 |
| 灰度 | `client_id` SHA-256 稳定哈希 mod 100，未命中回退上一个已发布版本；无 `client_id` 不进灰度 |
| Changelog 拼接范围 | 所有**已发布**版本（live + archived）。因上线会把旧版本置为 archived，仅查 live 将导致拼接失效 |
| 上线/回滚校验 | 操作前校验 R2 对象存在，防止把缺文件的版本推上线（`R2_OBJECT_NOT_FOUND`） |
| 应用管理 | 新增 `POST/GET /v1/admin/apps`（文档未定义，接入新应用必需） |
| 更新包上传 | 新增 `POST /v1/admin/uploads/presign`：返回 15 分钟有效的 AWS SigV4 预签名 R2 PUT URL（path-style），下游只需管理 Token、无需 Cloudflare S3 凭据。需配置 `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secret，否则返回 503 `UPLOAD_NOT_CONFIGURED`。**客户端不得附加任何自定义头**（手动设 host / x-amz-content-sha256 会导致签名失败）。已被 live/archived 版本占用的对象键拒绝签发（409 `KEY_ALREADY_LIVE`） |
| 灰度比例调整 | 新增 `PATCH /v1/admin/releases/:releaseId`（文档 6.1 "可随时调整" 需要） |
| 回滚并发控制 | `expected_current_release_id` 必填，防止误回滚 |
| 速率限制 | Workers ratelimit 绑定：查询 120 次/分（按 client_id/IP），下载 30 次/分（按 IP），超限 429 |
| 基础监控 | Analytics Engine 数据集 `releasedock_metrics`（已启用）：查询次数/更新可见性、下载次数/字节数，按 app_id 聚合。可在控制台 Workers → Analytics Engine 或 SQL API 查询，如 `SELECT * FROM releasedock_metrics WHERE _timestamp > NOW() - INTERVAL '1' HOUR` |
| 限流与监控缺失行为 | 绑定未配置（本地/测试）时自动跳过，不阻塞主流程；生产限流已实测生效（30 次/分精确触发） |

## 已知限制与备选方案

**查询接口仍走 Worker 边缘节点**。在 Worker 链路被限速或阻断的网络上，`GET /v1/updates/...` 可能失败，而同文件的 R2 直链下载正常（实测跨境链路约 1/3 连接超时，而同一 20MB 文件从 R2 下载仅约 2.5 秒）。客户端应对查询做退避重试。

备选方案——**清单也放到 R2**（暂未实现，确有需要再加）：发布时把 `manifests/{app_id}/{channel}.json` 写入 R2，内容包含当前生效版本、灰度规则、`min_supported_version` 与 changelog，客户端直接读 R2，让更新检查完全绕开 Worker。注意：按 `client_id` 的灰度分流与 changelog 拼接需要转移到客户端（或清单携带原始规则），且秒级回滚/撤销将取决于 R2 对象的更新时机。

## 尚未实现（阶段四，可选增强）

- 管理后台/发布看板、下载短时效签名 URL、按 OS/arch 分发、发布审批流、更细粒度告警
