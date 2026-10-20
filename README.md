# ReleaseDock

> English | [简体中文](README_ZH.md)

A multi-app software update distribution system built on **Cloudflare Workers + R2 + D1**: version checks, changelog stitching, controlled downloads, and release management.

The architecture spec and API contract live in [docs/开发文档.md](docs/开发文档.md) (Chinese). Current status: **Phases 1–3 complete** (version query, download, release registration, promote, rollback, forced-update threshold, rollout adjustment, rate limiting, analytics, client update library, CI template), with all 65 automated tests passing.

## Project layout

```
src/
├── index.ts                # Hono entry point, unified error handling
├── types.ts                # Env bindings and API DTOs
├── errors.ts               # Error codes (spec section 10)
├── middleware/
│   ├── adminAuth.ts        # Bearer token auth for admin API
│   └── rateLimit.ts        # Query/download rate limiting (ratelimit binding, skipped when absent)
├── routes/
│   ├── updates.ts          # GET /v1/updates/:appId/:channel
│   ├── download.ts         # GET /v1/download/:releaseId
│   └── admin.ts            # /v1/admin/* (create app, register, promote, rollback, threshold, rollout, list)
├── services/
│   ├── releases.ts         # D1 data access, pointer moves (shared CAS for promote/rollback)
│   ├── changelog.ts        # Changelog stitching (max 5 versions)
│   └── metrics.ts          # Analytics Engine instrumentation
└── utils/                  # semver compare, rollout hashing, ID generation
client/                     # Client update library (releasedock-client, pure Web APIs)
├── src/index.ts            # Check / download / SHA-256 verify / progress (Node, Electron, browsers)
├── src/node.ts             # Node-only: streaming download to file with auto cleanup
└── test/                   # Library tests
migrations/                 # D1 migrations
scripts/seed-demo.sql       # Local demo data (apps and channels only)
.github/workflows/release.yml  # CI release pipeline template
```

## Local development

No Cloudflare account needed — wrangler simulates D1 and R2 locally.

```bash
npm install
npm run db:migrate:local     # Apply D1 migrations
npm run dev                  # Start wrangler dev at http://127.0.0.1:8787
npm test                     # Run all 65 tests
npm run typecheck            # Typecheck server + client library
```

The local admin token lives in `.dev.vars`: `ADMIN_TOKEN=dev-admin-token-change-me`.

### Release walkthrough (curl)

```bash
BASE=http://127.0.0.1:8787
TOKEN="Authorization: Bearer dev-admin-token-change-me"

# 1. Create an app
curl -X POST $BASE/v1/admin/apps -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"com.example.demo","name":"Demo App"}'

# 2. Upload the package — recommended: presigned URL via the admin API.
#    Only the admin token is needed; no Cloudflare S3 credentials on the client side.
curl -X POST $BASE/v1/admin/uploads/presign -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"com.example.demo","channel":"stable","version":"1.0.0","filename":"setup.exe"}'
# -> {"upload_url":"https://<account>.r2.cloudflarestorage.com/releasedock-packages/…?X-Amz-Signature=…",
#     "method":"PUT","headers":{},"r2_key":"com.example.demo/stable/1.0.0/setup.exe","expires_at":"…"}
curl -X PUT --data-binary @./your-setup.exe "<upload_url>"    # send NO extra headers

# Alternative (CI with R2 credentials available):
# npx wrangler r2 object put releasedock-packages/com.example.demo/stable/1.0.0/setup.exe --file ./your-setup.exe --remote

# 3. Register the release (draft, invisible to clients)
curl -X POST $BASE/v1/admin/releases -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"app_id":"com.example.demo","channel":"stable","version":"1.0.0",
       "r2_key":"com.example.demo/stable/1.0.0/setup.exe",
       "sha256":"<64 hex chars>","size":12345,
       "changelog":["Initial release","Fixed login timeout"],"rollout":10}'
# -> {"release_id":"rel_xxx",...}

# 4. Promote (omit "expected" for the first release; afterwards it is required for optimistic concurrency)
curl -X POST $BASE/v1/admin/releases/rel_xxx/promote -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{}'

# 5. Adjust rollout percentage (any time, no re-upload needed)
curl -X PATCH $BASE/v1/admin/releases/rel_xxx -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{"rollout":50}'

# 6. Roll back to an older release (current pointer required)
curl -X POST $BASE/v1/admin/releases/rel_old/rollback -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{"expected_current_release_id":"rel_xxx"}'

# 7. Set the forced-update threshold
curl -X PATCH $BASE/v1/admin/apps/com.example.demo/channels/stable -H "$TOKEN" \
  -H "Content-Type: application/json" -d '{"min_supported_version":"1.1.0"}'

# 8. Client-side check and download
curl "$BASE/v1/updates/com.example.demo/stable?current=0.9.0&client_id=<uuid>"
curl -O "$BASE/v1/download/rel_xxx"   # verify X-Checksum-Sha256
```

> Windows note: inline Chinese text in `curl -d` may be sent as GBK from the console and stored garbled. Prefer writing the request body to a UTF-8 file and using `--data-binary @file.json`.

## Client update library (releasedock-client)

Shared by all Node/Electron software; it only handles check, download, SHA-256 verification, and progress callbacks — installation is delegated back to each app (spec section 8.5). Non-Node programs (Python, C, C++, Qt, etc.) integrate directly against the HTTP contract in spec sections 4.2/4.3.

```ts
import { checkForUpdate } from "./client/src/index";
// For large files on Node/Electron: import { downloadToFile } from "./client/src/node";

const info = await checkForUpdate({
  baseUrl: "https://releasedock.xxxxx.workers.dev",
  appId: "com.example.demo",
  channel: "stable",
  currentVersion: app.getVersion(),
  clientId: persistedUuid,          // generated once at first launch, used for rollout bucketing
});

if (!info.updateAvailable) return;
if (info.mandatory) showBlockingDialog(info.changelog);
else showOptionalDialog(info.changelog);

const { bytes, sha256 } = await info.download!({
  onProgress: (loaded, total) => updateProgressBar(loaded, total),
});
// bytes passed SHA-256 verification; hand off to your installer
```

For large files prefer the streaming variant (failed verification deletes the partial file automatically):

```ts
import { downloadToFile } from "./client/src/node";
await downloadToFile(info.downloadUrl!, {
  sha256: info.sha256!, filePath: "/tmp/app-setup.exe",
  onProgress: (loaded, total) => updateProgressBar(loaded, total),
});
```

## AI integration skill

[`skills/releasedock-integration/`](skills/releasedock-integration/SKILL.md) is a packaged Agent Skill (SKILL.md format) for AI coding agents that integrate update checking into downstream software — in any language — or automate releases to this server. Copy the folder into your project's skills directory (`.zcode/skills/`, `.claude/skills/`, …) or just attach the file to your AI's context. It contains the client behavior rules, the full HTTP contract ([references/api.md](skills/releasedock-integration/references/api.md)), per-language recipes (Python/C/C#/Go/Qt/Rust/Java, [references/recipes.md](skills/releasedock-integration/references/recipes.md)), and a zero-dependency runnable Python example.

## CI integration

`.github/workflows/release.yml` is a ready-to-copy template: triggered manually, it computes the SHA-256, uploads to R2, registers the draft release, and (optionally) promotes it. Before promoting it reads the current live pointer for optimistic concurrency control. The recommended flow is a partial rollout first, then a full promote after error rates look clean. Configure the `CLOUDFLARE_API_TOKEN` and `RELEASEDOCK_ADMIN_TOKEN` repository secrets.

## Deployment

Currently live at: **https://releasedock.xxxxx.workers.dev** (D1 `releasedock` + R2 `releasedock-packages`, region WNAM, first deployed 2026-10-20).

Redeploying is just:

```bash
npm run deploy
```

Full first-time setup (for a new account):

```bash
npx wrangler login
npx wrangler d1 create releasedock        # put the returned database_id into wrangler.jsonc
npx wrangler r2 bucket create releasedock-packages   # R2 must be enabled in the dashboard first
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN       # production admin token, never reuse the local one
# presigned uploads need an R2 S3 API token (dashboard → R2 → Manage API Tokens, Object Read & Write
# scoped to releasedock-packages). Skip these three if you upload with wrangler/cli instead.
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npm run deploy
```

It is recommended to also protect `/v1/admin/*` with Cloudflare Access (service tokens or an email allowlist) on top of the Bearer token.

## Confirmed decisions (relative to the spec)

| Topic | Decision |
| :--- | :--- |
| Changelog format (spec open question 6) | Structured string arrays `string[]` for both storage and API responses |
| Download auth (spec open question 2) | None initially: unguessable `release_id` + HTTPS; `draft` downloads rejected with 404 |
| Rollout | SHA-256 stable hash of `client_id` mod 100; misses fall back to the previous published release; no `client_id` means never in rollout |
| Changelog stitching scope | All **published** releases (live + archived). Promoting archives the replaced release, so live-only queries would break multi-version stitching |
| Promote/rollback validation | The R2 object must exist before the pointer moves, preventing broken releases (`R2_OBJECT_NOT_FOUND`) |
| App management | Added `POST/GET /v1/admin/apps` (not in the spec, required to onboard apps) |
| Package upload | Added `POST /v1/admin/uploads/presign`: returns a 15-min AWS SigV4 presigned R2 PUT URL (path-style), so downstreams need only the admin token — no Cloudflare S3 credentials. Requires `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets, else 503 `UPLOAD_NOT_CONFIGURED`. Clients must send **no** extra headers (manual `host`/`x-amz-content-sha256` breaks the signature). Signing refuses keys already used by a live/archived release (409 `KEY_ALREADY_LIVE`) |
| Rollout adjustment | Added `PATCH /v1/admin/releases/:releaseId` (needed for spec 6.1 "adjustable at any time") |
| Rollback concurrency control | `expected_current_release_id` required to prevent accidental rollbacks |
| Rate limiting | Workers ratelimit bindings: 120/min for queries (by client_id/IP), 30/min for downloads (by IP), 429 when exceeded |
| Analytics | Analytics Engine dataset `releasedock_metrics` (enabled): check counts/visibility and download counts/bytes per app. Query via the dashboard (Workers → Analytics Engine) or the SQL API, e.g. `SELECT * FROM releasedock_metrics WHERE _timestamp > NOW() - INTERVAL '1' HOUR` |
| Missing bindings | Rate limiting and metrics are skipped automatically when bindings are absent (local/test); production enforcement verified (30/min trips precisely) |

## Not implemented (Phase 4, optional)

- Admin dashboard / release board, short-lived signed download URLs, per-OS/arch distribution, release approval flow, finer-grained alerting
