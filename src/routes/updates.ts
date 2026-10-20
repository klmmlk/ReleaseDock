import { Hono } from "hono";
import type { Env, ReleaseRow, UpdateResponse } from "../types";
import { Errors } from "../errors";
import { rateLimitUpdates } from "../middleware/rateLimit";
import { buildChangelog } from "../services/changelog";
import { recordMetric } from "../services/metrics";
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
    body.download_url = new URL(`/v1/download/${effective.id}`, c.req.url).toString();
    body.sha256 = effective.sha256;
    body.size = effective.size;
    body.published_at = effective.promoted_at ?? undefined;

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
