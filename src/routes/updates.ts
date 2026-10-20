import { Hono } from "hono";
import type { Env, ReleaseRow, UpdateResponse } from "../types";
import { Errors } from "../errors";
import { rateLimitUpdates } from "../middleware/rateLimit";
import { buildChangelog } from "../services/changelog";
import { recordMetric } from "../services/metrics";
import { presignR2Get } from "../services/presign";
import {
  getApp,
  getChannel,
  getPreviousPublishedRelease,
  getReleaseById,
  listReleasesByStatus,
} from "../services/releases";
import { rolloutBucket } from "../utils/hash";
import { compareVersions, isValidVersion } from "../utils/semver";

/**
 * 预签名直链有效期。够长以覆盖用户"看到更新提示后隔一阵才点下载"的场景；
 * 过期后 R2 返回 403，客户端应重新查询本接口换新链接。
 */
const DOWNLOAD_URL_TTL_SECONDS = 3600;

/**
 * GET /v1/updates/:appId/:channel
 * 行为规则见开发文档 4.2。
 */
export const updates = new Hono<{ Bindings: Env }>();

updates.get("/updates/:appId/:channel", rateLimitUpdates, async (c) => {
  const appId = c.req.param("appId");
  const channel = c.req.param("channel");
  const current = c.req.query("current");
  const clientId = c.req.query("client_id");
  const includeChangelog = c.req.query("include_changelog") !== "false";

  if (!current) throw Errors.invalidRequest("缺少必填参数 current");
  if (!isValidVersion(current)) throw Errors.invalidRequest("current 不是合法的语义化版本号");

  const app = await getApp(c.env.DB, appId);
  if (!app || app.status !== "active") throw Errors.appNotFound();

  const channelRow = await getChannel(c.env.DB, appId, channel);
  if (!channelRow) throw Errors.channelNotFound();

  // 确定该客户端视角下的“有效最新版本”
  let effective: ReleaseRow | null =
    channelRow.current_release_id != null
      ? await getReleaseById(c.env.DB, channelRow.current_release_id)
      : null;

  if (effective && effective.rollout < 100) {
    const inRollout = clientId ? (await rolloutBucket(clientId)) < effective.rollout : false;
    if (!inRollout) {
      // 灰度未命中 / 无 client_id：回退到上一个已发布版本，可能为 null（视为无更新）
      effective = await getPreviousPublishedRelease(c.env.DB, appId, channel, effective.id);
    }
  }

  const latestVersion = effective ? effective.version : current;
  const updateAvailable = effective !== null && compareVersions(current, latestVersion) < 0;
  const mandatory = compareVersions(current, channelRow.min_supported_version) < 0;

  const body: UpdateResponse = {
    app_id: appId,
    channel,
    update_available: updateAvailable,
    latest: latestVersion,
    current,
    mandatory,
  };

  if (updateAvailable && effective) {
    body.min_supported_version = channelRow.min_supported_version;
    body.sha256 = effective.sha256;
    body.size = effective.size;
    body.published_at = effective.promoted_at ?? undefined;

    // 主下载地址：R2 预签名直链（不经过 Worker，避免 Worker 链路带宽受限）。
    // 未配置 R2 S3 凭据时回退为 Worker 代理地址。
    const apiUrl = new URL(`/v1/download/${effective.id}`, c.req.url).toString();
    body.download_api_url = apiUrl;

    if (c.env.R2_ACCOUNT_ID && c.env.R2_ACCESS_KEY_ID && c.env.R2_SECRET_ACCESS_KEY) {
      const presigned = await presignR2Get({
        env: {
          R2_ACCOUNT_ID: c.env.R2_ACCOUNT_ID,
          R2_ACCESS_KEY_ID: c.env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: c.env.R2_SECRET_ACCESS_KEY,
        },
        bucket: c.env.R2_BUCKET_NAME ?? "releasedock-packages",
        key: effective.r2_key,
        expiresSeconds: DOWNLOAD_URL_TTL_SECONDS,
      });
      body.download_url = presigned.url;
      body.download_expires_at = presigned.expiresAt;
      recordMetric(c.env, {
        appId,
        channel,
        type: "download_url_issued",
        detail: "direct",
      });
    } else {
      body.download_url = apiUrl;
      recordMetric(c.env, {
        appId,
        channel,
        type: "download_url_issued",
        detail: "worker",
      });
    }

    if (includeChangelog) {
      // 文档 4.5 会把被替换的版本置为 archived，因此拼接范围取所有已发布版本（live+archived）
      const publishedReleases = await listReleasesByStatus(c.env.DB, appId, channel, [
        "live",
        "archived",
      ]);
      const { entries, truncated } = buildChangelog(publishedReleases, current, latestVersion);
      body.changelog = entries;
      if (truncated) body.changelog_truncated = true;
    }
  }

  c.header("Cache-Control", "public, max-age=60");
  recordMetric(c.env, {
    appId,
    channel,
    type: "update_check",
    detail: updateAvailable ? "update_available" : "up_to_date",
  });
  return c.json(body);
});
