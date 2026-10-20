import { Hono } from "hono";
import type { Env, PromoteRequest, RegisterReleaseRequest, ReleaseStatus } from "../types";
import { Errors } from "../errors";
import { adminAuth } from "../middleware/adminAuth";
import { parseChangelog } from "../services/changelog";
import {
  getApp,
  getChannel,
  getReleaseById,
  getReleaseByVersion,
  insertApp,
  listApps,
  listReleases,
  moveChannelPointer,
  registerRelease,
  updateMinSupportedVersion,
  updateRollout,
} from "../services/releases";
import { generateId, nowIso } from "../utils/id";
import { isValidVersion } from "../utils/semver";

/** 应用与通道命名约束：出现在 URL 路径中，必须 URL 安全 */
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_STATUSES: ReleaseStatus[] = ["draft", "live", "archived"];

export const admin = new Hono<{ Bindings: Env }>();

admin.use("*", adminAuth);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function optionalString(value: unknown, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLen) {
    throw Errors.invalidRequest();
  }
  return value;
}

// ---------- 应用管理（文档补充接口） ----------

admin.post("/admin/apps", async (c) => {
  const body = await readJsonBody(c);
  if (!isRecord(body)) throw Errors.invalidRequest("请求体必须是 JSON 对象");

  const appId = body.app_id;
  const name = body.name;
  if (typeof appId !== "string" || !APP_ID_RE.test(appId)) {
    throw Errors.invalidRequest("app_id 必须由字母/数字开头，仅含字母、数字、点、下划线、连字符，长度 1-128");
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 128) {
    throw Errors.invalidRequest("name 必须是 1-128 字符的非空字符串");
  }
  if (await getApp(c.env.DB, appId)) throw Errors.appAlreadyExists();

  const now = nowIso();
  await insertApp(c.env.DB, { app_id: appId, name, now });
  return c.json({ app_id: appId, name, status: "active", message: "应用已创建" }, 201);
});

admin.get("/admin/apps", async (c) => {
  const apps = await listApps(c.env.DB);
  return c.json({ apps });
});

// ---------- 登记版本（文档 4.4） ----------

admin.post("/admin/releases", async (c) => {
  const body = await readJsonBody(c);
  if (!isRecord(body)) throw Errors.invalidRequest("请求体必须是 JSON 对象");
  const req = body as unknown as RegisterReleaseRequest;

  if (typeof req.app_id !== "string" || req.app_id.length === 0 || req.app_id.length > 128) {
    throw Errors.invalidRequest("app_id 缺失或格式错误");
  }
  if (typeof req.channel !== "string" || !CHANNEL_RE.test(req.channel)) {
    throw Errors.invalidRequest("channel 必须由小写字母/数字开头，仅含小写字母、数字、下划线、连字符，长度 1-32");
  }
  if (typeof req.version !== "string" || !isValidVersion(req.version)) {
    throw Errors.invalidRequest("version 必须是语义化版本号，如 1.3.0");
  }
  if (
    typeof req.r2_key !== "string" ||
    req.r2_key.length === 0 ||
    req.r2_key.length > 512 ||
    req.r2_key.startsWith("/")
  ) {
    throw Errors.invalidRequest("r2_key 必须是不以 / 开头、长度 1-512 的对象键");
  }
  if (typeof req.sha256 !== "string" || !SHA256_RE.test(req.sha256.toLowerCase())) {
    throw Errors.invalidRequest("sha256 必须是 64 位十六进制字符串");
  }
  if (!Number.isInteger(req.size) || (req.size as number) <= 0) {
    throw Errors.invalidRequest("size 必须是大于 0 的整数（文件字节数）");
  }
  if (
    !Array.isArray(req.changelog) ||
    req.changelog.length === 0 ||
    req.changelog.length > 50 ||
    !req.changelog.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 500)
  ) {
    throw Errors.invalidRequest("changelog 必须是 1-50 条非空字符串（每条不超过 500 字符）");
  }
  const rollout = req.rollout === undefined ? 100 : req.rollout;
  if (!Number.isInteger(rollout) || (rollout as number) < 0 || (rollout as number) > 100) {
    throw Errors.invalidRequest("rollout 必须是 0-100 的整数");
  }
  const createdBy = optionalString(req.created_by, 128);

  const app = await getApp(c.env.DB, req.app_id);
  if (!app) throw Errors.appNotFound();
  if (app.status !== "active") throw Errors.forbidden("应用已停用，禁止登记新版本");
  if (await getReleaseByVersion(c.env.DB, req.app_id, req.channel, req.version)) {
    throw Errors.versionAlreadyExists();
  }

  const releaseId = generateId("rel");
  await registerRelease(
    c.env.DB,
    {
      id: releaseId,
      app_id: req.app_id,
      channel: req.channel,
      version: req.version,
      r2_key: req.r2_key,
      sha256: req.sha256.toLowerCase(),
      size: req.size,
      changelog_json: JSON.stringify(req.changelog),
      rollout,
      now: nowIso(),
      created_by: createdBy,
    },
    createdBy,
  );

  return c.json(
    { release_id: releaseId, status: "draft", message: "版本已登记，尚未上线" },
    201,
  );
});

// ---------- 版本列表（文档 4.8） ----------

admin.get("/admin/releases", async (c) => {
  const appId = c.req.query("app_id");
  if (!appId) throw Errors.invalidRequest("缺少必填查询参数 app_id");
  const channel = c.req.query("channel") || undefined;
  const statusParam = c.req.query("status") || undefined;
  if (statusParam && !RELEASE_STATUSES.includes(statusParam as ReleaseStatus)) {
    throw Errors.invalidRequest("status 只能是 draft / live / archived");
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const rows = await listReleases(c.env.DB, {
    appId,
    channel,
    status: statusParam as ReleaseStatus | undefined,
    limit,
    offset,
  });

  return c.json({
    releases: rows.map((row) => ({
      id: row.id,
      app_id: row.app_id,
      channel: row.channel,
      version: row.version,
      status: row.status,
      rollout: row.rollout,
      r2_key: row.r2_key,
      sha256: row.sha256,
      size: row.size,
      changelog: parseChangelog(row.changelog),
      created_at: row.created_at,
      promoted_at: row.promoted_at,
      created_by: row.created_by,
    })),
  });
});

// ---------- 上线版本（文档 4.5） ----------

admin.post("/admin/releases/:releaseId/promote", async (c) => {
  const releaseId = c.req.param("releaseId");
  const body = await readJsonBody(c);
  if (body !== null && body !== undefined && !isRecord(body)) {
    throw Errors.invalidRequest("请求体必须是 JSON 对象");
  }
  const req = (body ?? {}) as PromoteRequest;
  if (
    req.expected_current_release_id !== undefined &&
    req.expected_current_release_id !== null &&
    typeof req.expected_current_release_id !== "string"
  ) {
    throw Errors.invalidRequest("expected_current_release_id 必须是字符串或 null");
  }
  const reason = optionalString(req.reason, 500);
  const operator = optionalString(req.operator, 128);

  const release = await getReleaseById(c.env.DB, releaseId);
  if (!release) throw Errors.releaseNotFound();
  if (release.status === "live") throw Errors.releaseNotPromotable();

  const channelRow = await getChannel(c.env.DB, release.app_id, release.channel);
  if (!channelRow) throw Errors.channelNotFound();

  // 上线前确认 R2 中确实存在更新包，防止把坏版本推给客户端
  if (!(await c.env.BUCKET.head(release.r2_key))) throw Errors.r2ObjectNotFound();

  // 期望指针缺省 = 期望通道尚无生效版本（首次上线）
  const expected = req.expected_current_release_id ?? null;
  const { casRows } = await moveChannelPointer(
    c.env.DB,
    release,
    "promote",
    expected,
    operator ?? release.created_by,
    reason,
    channelRow.current_release_id,
    nowIso(),
  );

  if (casRows === 0) throw Errors.pointerConflict();

  return c.json({
    app_id: release.app_id,
    channel: release.channel,
    current_release_id: release.id,
    message: "已上线",
  });
});

// ---------- 回滚（文档 4.6） ----------

admin.post("/admin/releases/:releaseId/rollback", async (c) => {
  const releaseId = c.req.param("releaseId");
  const body = await readJsonBody(c);
  if (!isRecord(body)) throw Errors.invalidRequest("请求体必须是 JSON 对象");
  const req = body as unknown as PromoteRequest;
  if (typeof req.expected_current_release_id !== "string") {
    throw Errors.invalidRequest("回滚必须显式传入 expected_current_release_id");
  }
  const reason = optionalString(req.reason, 500);
  const operator = optionalString(req.operator, 128);

  const release = await getReleaseById(c.env.DB, releaseId);
  if (!release) throw Errors.releaseNotFound();
  if (release.status === "draft") throw Errors.invalidRequest("回滚目标不能是 draft 版本");

  const channelRow = await getChannel(c.env.DB, release.app_id, release.channel);
  if (!channelRow) throw Errors.channelNotFound();
  if (!(await c.env.BUCKET.head(release.r2_key))) throw Errors.r2ObjectNotFound();

  const { casRows } = await moveChannelPointer(
    c.env.DB,
    release,
    "rollback",
    req.expected_current_release_id,
    operator,
    reason,
    channelRow.current_release_id,
    nowIso(),
  );
  if (casRows === 0) throw Errors.pointerConflict();

  return c.json({
    app_id: release.app_id,
    channel: release.channel,
    current_release_id: release.id,
    message: "已回滚",
  });
});

// ---------- 强制更新阈值（文档 4.7） ----------

admin.patch("/admin/apps/:appId/channels/:channel", async (c) => {
  const appId = c.req.param("appId");
  const channel = c.req.param("channel");
  const body = await readJsonBody(c);
  if (!isRecord(body)) throw Errors.invalidRequest("请求体必须是 JSON 对象");

  const minSupportedVersion = body.min_supported_version;
  if (typeof minSupportedVersion !== "string" || !isValidVersion(minSupportedVersion)) {
    throw Errors.invalidRequest("min_supported_version 必须是语义化版本号，如 1.3.0");
  }

  if (!(await getApp(c.env.DB, appId))) throw Errors.appNotFound();
  if (!(await getChannel(c.env.DB, appId, channel))) throw Errors.channelNotFound();

  const updated = await updateMinSupportedVersion(
    c.env.DB,
    appId,
    channel,
    minSupportedVersion,
    nowIso(),
  );
  if (!updated) throw Errors.channelNotFound();

  return c.json({
    app_id: appId,
    channel,
    min_supported_version: minSupportedVersion,
    message: "已更新",
  });
});

// ---------- 灰度比例调整（文档 6.1：比例可随时调整，无需重新发版） ----------

admin.patch("/admin/releases/:releaseId", async (c) => {
  const releaseId = c.req.param("releaseId");
  const body = await readJsonBody(c);
  if (!isRecord(body)) throw Errors.invalidRequest("请求体必须是 JSON 对象");

  const rollout = body.rollout;
  if (!Number.isInteger(rollout) || (rollout as number) < 0 || (rollout as number) > 100) {
    throw Errors.invalidRequest("rollout 必须是 0-100 的整数");
  }
  const operator = optionalString(body.operator, 128);

  const release = await getReleaseById(c.env.DB, releaseId);
  if (!release) throw Errors.releaseNotFound();

  await updateRollout(c.env.DB, release, rollout as number, operator, nowIso());
  return c.json({ release_id: releaseId, rollout, message: "已更新" });
});
