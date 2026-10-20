import { Hono } from "hono";
import type { Env } from "../types";
import { Errors } from "../errors";
import { rateLimitDownload } from "../middleware/rateLimit";
import { recordMetric } from "../services/metrics";
import { getReleaseById } from "../services/releases";

/**
 * GET /v1/download/:releaseId
 * 行为规则见开发文档 4.3：R2 流式返回，draft 不可下载。
 */
export const download = new Hono<{ Bindings: Env }>();

download.get("/download/:releaseId", rateLimitDownload, async (c) => {
  const releaseId = c.req.param("releaseId");
  const release = await getReleaseById(c.env.DB, releaseId);
  // draft 与不存在的记录同等对待，避免泄露未发布版本的存在性
  if (!release || release.status === "draft") throw Errors.releaseNotFound();

  const object = await c.env.BUCKET.get(release.r2_key);
  if (!object) throw Errors.r2ObjectNotFound();

  recordMetric(c.env, {
    appId: release.app_id,
    channel: release.channel,
    type: "update_download",
    detail: release.version,
    value: object.size,
  });

  const filename = release.r2_key.split("/").pop() ?? release.r2_key;
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      "ETag": object.httpEtag,
      "X-Checksum-Sha256": release.sha256,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});
