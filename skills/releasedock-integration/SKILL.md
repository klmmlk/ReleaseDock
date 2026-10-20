---
name: releasedock-integration
description: Integrate software update checking with a ReleaseDock (发布坞) server, or automate releases to it. Use when a project needs an update checker / auto-updater, a release pipeline for installers, or mentions ReleaseDock, 发布坞, version query, 灰度发布, or 强制更新. Covers the HTTP contract (query, download, SHA-256 verify), client behavior rules, per-language recipes, and the release/rollback/rollout admin workflow.
---

# ReleaseDock 集成技能

为下游软件开发者（人类或 AI）准备的集成指南。ReleaseDock 是基于 Cloudflare Workers + R2 + D1 的多软件升级分发系统：**客户端侧只有两个 GET 接口**（版本查询返回 JSON、二进制下载），版本比较、changelog 拼接、灰度判定、强制更新判定全部在服务端完成，任何能发 HTTP 请求的语言都能直接集成，无需 SDK。

**当前示例部署**：`https://releasedock.xxxxx.workers.dev`（下游自建时替换为实际地址）。本地开发默认 `http://127.0.0.1:8787`。

## 一、客户端集成（更新检查）

### 必做的 6 步

1. **配置四要素**：`base_url`（服务地址）、`app_id`（如 `com.yourco.product-a`）、`channel`（默认 `stable`）、`current_version`（本机当前版本）。
2. **生成并永久持久化 `client_id`**（UUID v4，首次启动生成）。存放位置：Windows 建议注册表 `HKCU`，Linux `~/.config/<app>/update_client_id`，macOS `defaults`。⚠️ 没有它客户端永远不进灰度。
3. **查询**（完整字段与错误码见 [references/api.md](references/api.md)）：
   ```
   GET {base_url}/v1/updates/{app_id}/{channel}?current={current_version}&client_id={client_id}
   ```
4. **判定**：`update_available=false` 直接结束；`mandatory=true` 时必须阻断旧版本使用并引导更新；`changelog_truncated=true` 时提示"仅展示最近 5 个版本"。
5. **下载并校验**：流式下载 `download_url`，边下边算 SHA-256，与响应 JSON 中的 `sha256`（即 `X-Checksum-Sha256` 头）比对。**不一致：删除临时文件，重试一次；再失败提示用户**。⚠️ 下载接口暂不支持 Range 断点续传（恒返回 200 全量），大文件中断需整体重下。
6. **安装**：校验通过后把文件交给该软件自己的安装逻辑（回调/子进程/重启替换），安装完成后更新本地 `current_version`。

### 行为规则（必须遵守）

- **检查时机**：启动后异步检查一次（不阻塞主流程）、之后每 6 小时静默一次、用户手动"检查更新"立即查。禁止在主界面加载时同步等待。
- **错误处理**：网络失败静默重试；5xx 按"无更新"处理下次再查；收到 429 `RATE_LIMITED` 必须退避（限流为查询 120 次/分按 client_id、下载 30 次/分按 IP，正常节奏远远够用，**不要实现重试风暴**）。
- **版本号**：查询参数 `current` 必须是语义化版本 `X.Y.Z`（可带 `-prerelease`）。版本比较在服务端做，客户端只如实上报。
- **灰度语义**：同一 `client_id` 永远落同一桶；被灰度排除时查询返回"无更新"（回退版本信息），客户端无需也无法感知灰度。

### 各语言实现配方

Python / C / C# / Go / Qt 等语言的最小可运行实现（库选型、代码、坑位）见 [references/recipes.md](references/recipes.md)，可直接运行的示例脚本见 [examples/python_check.py](examples/python_check.py)。Node/Electron 直接复制本仓库 `client/` 目录使用。

## 二、发布自动化（供 CI / 发布 AI 使用）

标准流程：**申请预签名 URL → PUT 上传 → 登记（draft）→ 上线（promote）**，回滚/灰度调整不需要重新上传。

```bash
BASE="https://releasedock.xxxxx.workers.dev"      # 以下属实际部署为准
AUTH="Authorization: Bearer $RELEASEDOCK_ADMIN_TOKEN" # Token 必须来自环境变量/Secret，严禁写死

# 1. 申请上传地址（对象键约定：{app_id}/{channel}/{version}/{filename}）
curl -sf -X POST "$BASE/v1/admin/uploads/presign" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "app_id": "com.yourco.app", "channel": "stable", "version": "1.5.0", "filename": "setup.exe"
}'
# -> {"upload_url":"https://<account>.r2.cloudflarestorage.com/releasedock-packages/…?X-Amz-Signature=…",
#     "method":"PUT","headers":{},"r2_key":"com.yourco.app/stable/1.5.0/setup.exe","expires_at":"…"}

# 2. 直接 PUT 文件内容到 upload_url。⚠️ 不要附加任何自定义请求头
#    （尤其 host / x-amz-content-sha256 —— 交给 HTTP 客户端自动处理，手动设置会导致 403）
curl -sf -X PUT --data-binary @./setup.exe "<upload_url>"


# 3. 登记为 draft（客户端不可见）。sha256=64位十六进制；changelog 为 1-50 条字符串数组
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

预签名 URL 默认 15 分钟有效（`expires_seconds` 可调，60–86400）；过期重新申请，不要重试旧 URL。服务端未配置 R2 S3 凭据时返回 503 `UPLOAD_NOT_CONFIGURED`，此时改用 `wrangler r2 object put` 或 S3 兼容工具上传；已被 live/archived 版本占用的对象键返回 409 `KEY_ALREADY_LIVE`，改用新版本号或文件名。

**治理操作**（均要求 `expected_current_release_id` 或当前指针）：

- 调整灰度：`PATCH /v1/admin/releases/{release_id}` `{"rollout": 50}` —— 可随时调整，无需重新发版；建议首发 5–10%，观察错误率后逐步放大。
- 回滚：`POST /v1/admin/releases/{旧_release_id}/rollback`，`expected_current_release_id` **必填**；文件不用重传。
- 强制更新阈值：`PATCH /v1/admin/apps/{app_id}/channels/{channel}` `{"min_supported_version":"1.3.0"}`；低于它的客户端查询返回 `mandatory=true`。
- 排错：`GET /v1/admin/releases?app_id=&channel=&status=` 查看登记状态（draft/live/archived）。

**CI 集成**：本仓库 `.github/workflows/release.yml` 是可直接复制的 GitHub Actions 模板（登记自动、上线手动触发）。只需要 `RELEASEDOCK_ADMIN_TOKEN` 一个 Secret —— 上传走预签名接口，无需 Cloudflare API Token。

**红线**：不要对同一 `app_id + channel + version` 重复登记（409）；不要覆盖已上线版本的 R2 对象键（新版本用新键）；生产 `stable` 通道的 promote/rollback 应人工确认，自动化只做 draft 登记。

## 三、集成验证清单（AI 完成集成后自测）

- [ ] 查询一个不存在的 app_id → 返回 404 `{"error":{"code":"APP_NOT_FOUND"}}`，错误处理路径生效
- [ ] 用真实 app 查询 `current=0.0.1` → `update_available=true`，能解析出 changelog 数组
- [ ] 用与最新版本相同的 `current` → `update_available=false`，且响应中**没有** `download_url`/`changelog` 字段
- [ ] 下载 `download_url`，本地计算的 SHA-256 与 `sha256` 字段一致
- [ ] 故意篡改本地校验逻辑 → 能触发"删除文件并重试"分支
- [ ] `client_id` 二次启动不变（持久化生效）
- [ ] 检查过程不阻塞软件主流程启动

生产环境只读测试可直接使用演示应用 `com.example.demo`（stable 通道有已上线版本）。**写操作测试请使用 beta 通道或本地 dev 环境，严禁向真实应用的 stable 通道发布测试版本。**
