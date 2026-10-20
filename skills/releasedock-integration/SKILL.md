---
name: releasedock-integration
description: Integrate software update checking with a ReleaseDock (发布坞) server, or automate releases to it. Use when a project needs an update checker / auto-updater, a release pipeline for installers, or mentions ReleaseDock, 发布坞, version query, 灰度发布, 强制更新, or uploading update packages. Covers the HTTP contract (query, download, SHA-256 verify, presigned upload), client behavior rules, per-language recipes, troubleshooting, and the release/rollback/rollout admin workflow.
---

# ReleaseDock 集成技能

ReleaseDock 是基于 Cloudflare Workers + R2 + D1 的多软件升级分发系统。客户端侧只有**两个 GET 接口**（版本查询返回 JSON、二进制下载），版本比较、changelog 拼接、灰度判定、强制更新判定全部在服务端完成——任何能发 HTTP 请求的语言都能直接集成，无需 SDK。

本技能覆盖两件独立的事：

| 你要做的 | 看哪一节 | 参考文件 |
| :--- | :--- | :--- |
| 让软件具备"检查更新"能力 | [一、客户端集成](#一客户端集成更新检查) | [references/recipes.md](references/recipes.md)、[examples/python_check.py](examples/python_check.py) |
| 把新版本发布到服务器 / 接入 CI | [二、发布自动化](#二发布自动化供-ci--发布-ai-使用) | — |
| 查字段定义、错误码 | — | [references/api.md](references/api.md) |
| 遇到报错 | [三、排障速查](#三排障速查) | — |

服务地址 `{base_url}` 由下游自建部署决定（示例用 `https://releasedock.xxxxx.workers.dev` 占位）；本地开发默认 `http://127.0.0.1:8787`。

---

## 一、客户端集成（更新检查）

### 必做的 6 步

1. **配置四要素**：`base_url`、`app_id`（如 `com.yourco.product-a`）、`channel`（默认 `stable`）、`current_version`（本机当前版本）。
2. **生成并永久持久化 `client_id`**（UUID v4，首次启动生成）。存放位置：Windows 注册表 `HKCU`，Linux `~/.config/<app>/`，macOS `defaults`。⚠️ 没有它客户端永远不进灰度。
3. **查询**：
   ```
   GET {base_url}/v1/updates/{app_id}/{channel}?current={current_version}&client_id={client_id}
   ```
4. **判定**：`update_available=false` 直接结束；`mandatory=true` 必须阻断旧版本使用并引导更新；`changelog_truncated=true` 提示"仅展示最近 5 个版本"。
5. **下载并校验**：`download_url` 是**短时效（1 小时）的 R2 预签名直链**，直接 GET 即可，不需要任何鉴权头，也不经过本服务。流式下载并边下边算 SHA-256，与 JSON 里的 `sha256` 比对（直链响应**不带** `X-Checksum-Sha256` 头）。**不一致：删除临时文件，重试一次**。直链支持 Range，可做断点续传；`download_expires_at` 之后直链会返回 403，此时重新查询本接口换新链接即可。`download_api_url` 是 Worker 兜底地址（始终可用，但速率可能受网络链路限制）。
6. **安装**：校验通过后交给该软件自己的安装逻辑，安装完成后更新本地 `current_version`。

### 行为规则（必须遵守）

- **检查时机**：启动后异步检查一次（不阻塞主流程）、之后每 6 小时静默一次、用户手动"检查更新"立即查。禁止在主界面加载时同步等待。
- **网络失败**：静默重试，不打扰用户；查询接口 5xx 按"无更新"处理，下次再查。
- **429 限流**：查询接口 120 次/分（按 `client_id`）。收到 429 必须退避到下一个检查周期，**不要实现重试风暴**（直链下载由 R2 承载，不受本服务限流）。
- **版本号**：`current` 必须是语义化版本 `X.Y.Z`（可带 `-prerelease`），格式非法返回 400。版本比较在服务端做，客户端只如实上报。
- **灰度语义**：同一 `client_id` 永远落同一桶；被灰度排除时查询返回"无更新"，客户端无法也无需感知。
- **响应字段是蛇形命名**（`update_available` / `download_url` / `sha256`），反序列化注意映射；`sha256` 比对统一转小写。

### 各语言实现配方

Python / C / C# / Go / Qt / Rust / Java 的最小实现、库选型与坑位见 [references/recipes.md](references/recipes.md)。可直接运行的零依赖示例见 [examples/python_check.py](examples/python_check.py)。Node/Electron 直接复制本仓库 `client/` 目录。

---

## 二、发布自动化（供 CI / 发布 AI 使用）

### 0. 首次接入一个新软件（只需一次）

```bash
BASE="https://releasedock.xxxxx.workers.dev"
AUTH="Authorization: Bearer $RELEASEDOCK_ADMIN_TOKEN"   # 来自环境变量/Secret，严禁写死

curl -sf -X POST "$BASE/v1/admin/apps" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"app_id":"com.yourco.app","name":"Your App"}'
```

通道（`stable`/`beta`）在首次登记版本时自动创建，无需单独接口。应用已存在返回 409 `APP_ALREADY_EXISTS`（可忽略）。

### 标准发布流程（四步）

```bash
# 1. 申请上传地址（对象键固定为 {app_id}/{channel}/{version}/{filename}）
curl -sf -X POST "$BASE/v1/admin/uploads/presign" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "app_id": "com.yourco.app", "channel": "stable", "version": "1.5.0", "filename": "setup.exe"
}'
# -> {"upload_url":"https://<account>.r2.cloudflarestorage.com/releasedock-packages/…?X-Amz-Signature=…",
#     "method":"PUT","headers":{},"r2_key":"com.yourco.app/stable/1.5.0/setup.exe","expires_at":"…"}

# 2. 直接 PUT 文件内容到 upload_url。⚠️ 不要附加任何自定义请求头
#    （尤其 host / x-amz-content-sha256 —— 交给 HTTP 客户端自动处理，手动设置会导致 403）
curl -sf -X PUT --data-binary @./setup.exe "<upload_url>"

# 3. 登记为 draft（客户端不可见）。sha256=64 位十六进制；changelog 为 1-50 条非空字符串
curl -sf -X POST "$BASE/v1/admin/releases" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "app_id": "com.yourco.app", "channel": "stable", "version": "1.5.0",
  "r2_key": "com.yourco.app/stable/1.5.0/setup.exe",
  "sha256": "<sha256sum 输出>", "size": <字节数>,
  "changelog": ["修复登录超时", "新增离线模式"], "rollout": 10, "created_by": "ci"
}'
# → {"release_id":"rel_xxx",...}

# 4. 上线（乐观并发控制：先查当前 live 指针；首次上线传 null 或省略）
EXPECTED=$(curl -sf "$BASE/v1/admin/releases?app_id=com.yourco.app&channel=stable&status=live" \
  -H "$AUTH" | jq -r '.releases[0].id // "null"')
curl -sf -X POST "$BASE/v1/admin/releases/rel_xxx/promote" -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"expected_current_release_id\": $(if [ "$EXPECTED" = null ]; then echo null; else echo "\"$EXPECTED\""; fi)}"
```

**关键约束**

- 预签名 URL 默认 15 分钟有效（`expires_seconds` 可调 60–86400）；过期重新申请，不要重试旧 URL。
- 已被 `live`/`archived` 版本占用的对象键，预签名与登记都会拒绝（409 `KEY_ALREADY_LIVE`）——新版本必须用新的版本号/文件名。
- 服务端未配置 R2 S3 凭据时返回 503 `UPLOAD_NOT_CONFIGURED`，回退用 `wrangler r2 object put` 或 S3 兼容工具直传。
- GB 级大文件：预签名 PUT 是单次整包上传；需要分片/断点续传时用 boto3 / rclone / aws-cli 走 R2 S3 协议直传，对象键规则不变。
- 登记不校验文件内容（只记录元数据），`sha256`/`size` 必须由发布方准确计算；上线前服务端会校验 R2 对象**存在**。

### 治理操作（均需要当前指针做并发控制）

| 操作 | 调用 | 说明 |
| :--- | :--- | :--- |
| 调整灰度 | `PATCH /v1/admin/releases/{release_id}` `{"rollout": 50}` | 随时生效，无需重新发版；首发建议 5–10%，观察错误率后放大 |
| 回滚 | `POST /v1/admin/releases/{旧_id}/rollback` `{"expected_current_release_id":"rel_当前"}` | expected **必填**；文件不用重传；目标不能是 draft |
| 强制更新阈值 | `PATCH /v1/admin/apps/{app_id}/channels/{channel}` `{"min_supported_version":"1.3.0"}` | 低于它的客户端查询返回 `mandatory=true` |
| 查看状态 | `GET /v1/admin/releases?app_id=&channel=&status=` | status ∈ draft/live/archived，用于选择回滚目标 |

**CI 集成**：`.github/workflows/release.yml` 是可直接复制的 GitHub Actions 模板（登记自动、上线手动触发），只需要 `RELEASEDOCK_ADMIN_TOKEN` 一个 Secret。

**红线**：不要对同一 `app_id + channel + version` 重复登记（409）；不要覆盖已上线版本的对象键；生产 `stable` 通道的 promote/rollback 应人工确认，自动化只做 draft 登记；测试版本只发 beta 或本地 dev，严禁发到真实应用的 stable。

---

## 三、排障速查

| 症状 | 原因 | 处理 |
| :--- | :--- | :--- |
| 上传 PUT 返回 `403 SignatureDoesNotMatch` | 手动设置了 `host` 或 `x-amz-content-sha256` 请求头 | 删除所有自定义头，只发 PUT + 请求体；URL 过期也会导致此错→重新申请 |
| 上传返回 503 `UPLOAD_NOT_CONFIGURED` | 服务端没配 R2 S3 凭据 | 改用 wrangler/S3 工具上传，或让管理员配置 `R2_*` secrets |
| 上传返回 409 `KEY_ALREADY_LIVE` | 该对象键已被已发布版本占用 | 换新版本号或新文件名，重新申请上传地址 |
| 登记 409 `VERSION_ALREADY_EXISTS` | 同 app+channel+version 已登记过 | 查列表确认；数据错误需管理员清理，不要改版本号糊弄 |
| 上线 409 `POINTER_CONFLICT` | `expected_current_release_id` 与当前指针不符（别人先发布了） | 重新查询当前 live 指针后再试 |
| 上线 409 `RELEASE_NOT_PROMOTABLE` | 目标已是 live | 无需操作；要重新发布用新版本 |
| 上线 404 `R2_OBJECT_NOT_FOUND` | 文件没上传成功或键不符 | 核对 `r2_key` 与上传对象键完全一致 |
| 查询 404 `APP_NOT_FOUND` / `CHANNEL_NOT_FOUND` | app_id 拼错，或通道名大小写不符（须小写） | 核对配置；通道在首次登记时自动创建 |
| 查询 400 `INVALID_REQUEST` | `current` 不是 `X.Y.Z` 形式（如 `v1.0`、`1.0`） | 规范化版本号，去掉 `v` 前缀、补足三段 |
| 客户端"永远没有更新" | 未传 `client_id` 或该 id 落在灰度外 | 确认 client_id 持久化；检查该版本 `rollout`；查 `GET /v1/admin/releases?status=live` 的 rollout |
| 下载直链返回 403 | 预签名已过期（默认 1 小时） | 重新查询 updates 接口换新链接；不要缓存旧直链 |
| 客户端"有更新但下载失败" | R2 对象缺失（draft 版本不会签发直链） | 检查对象键是否与上传一致；draft 需先上线 |
| 浏览器/Electron 渲染进程直连报 CORS 错误 | R2 桶未配置 CORS | 给桶配置 CORS 规则允许你的来源；桌面进程（Python/C/主进程）不受影响 |
| 429 `RATE_LIMITED` | 超过查询 120 次/分或下载 30 次/分 | 退避到下一个周期；检查是否有重试循环打爆配额 |

---

## 四、集成验证清单（AI 完成集成后自测）

**客户端侧**

- [ ] 查询不存在的 app_id → 404 `APP_NOT_FOUND`，错误处理路径生效
- [ ] 查询 `current=0.0.1` → `update_available=true`，能解析出 changelog 数组
- [ ] 查询与最新相同的 `current` → `update_available=false`，且响应中**没有** `download_url`/`changelog`
- [ ] 下载 `download_url`，本地 SHA-256 与 `sha256` 一致
- [ ] 篡改本地校验值 → 能触发"删除文件并重试"分支
- [ ] `client_id` 二次启动不变（持久化生效）
- [ ] 检查过程不阻塞主流程启动；429 时不产生重试风暴

**发布侧**

- [ ] 预签名 → PUT → 登记 → 上线全链路在 beta 通道跑通
- [ ] 上传时不附加任何自定义头（否则 403）
- [ ] 登记的 `sha256`/`size` 与实际文件一致，客户端能校验通过
- [ ] 重复登记同一版本被拒（409）
- [ ] 回滚一次并确认客户端视角正确（已升级的客户端收到"无更新"，不会降级）

生产只读测试可直接用演示应用 `com.example.demo`（stable 通道有已上线版本）。**写操作测试请用 beta 通道或本地 dev 环境，严禁向真实应用的 stable 通道发布测试版本。**
