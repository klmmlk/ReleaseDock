import type { AppChannelRow, AppRow, ReleaseRow, ReleaseStatus } from "../types";

// ---------- apps ----------

export async function getApp(db: D1Database, appId: string): Promise<AppRow | null> {
  return db.prepare("SELECT * FROM apps WHERE app_id = ?").bind(appId).first<AppRow>();
}

export async function listApps(db: D1Database): Promise<AppRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM apps ORDER BY created_at ASC")
    .all<AppRow>();
  return results;
}

export async function insertApp(
  db: D1Database,
  row: { app_id: string; name: string; now: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO apps (app_id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .bind(row.app_id, row.name, row.now, row.now)
    .run();
}

// ---------- app_channels ----------

export async function getChannel(
  db: D1Database,
  appId: string,
  channel: string,
): Promise<AppChannelRow | null> {
  return db
    .prepare("SELECT * FROM app_channels WHERE app_id = ? AND channel = ?")
    .bind(appId, channel)
    .first<AppChannelRow>();
}

/** 首次登记版本时自动补建通道行（无生效版本指针） */
export function insertChannelIfMissing(
  db: D1Database,
  row: { app_id: string; channel: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO app_channels (app_id, channel, current_release_id, min_supported_version, updated_at) VALUES (?, ?, NULL, '0.0.0', ?)",
    )
    .bind(row.app_id, row.channel, row.now);
}

// ---------- releases ----------

export async function getReleaseById(db: D1Database, id: string): Promise<ReleaseRow | null> {
  return db.prepare("SELECT * FROM releases WHERE id = ?").bind(id).first<ReleaseRow>();
}

export async function getReleaseByVersion(
  db: D1Database,
  appId: string,
  channel: string,
  version: string,
): Promise<ReleaseRow | null> {
  return db
    .prepare("SELECT * FROM releases WHERE app_id = ? AND channel = ? AND version = ?")
    .bind(appId, channel, version)
    .first<ReleaseRow>();
}

export async function listReleasesByStatus(
  db: D1Database,
  appId: string,
  channel: string,
  statuses: ReleaseStatus[],
): Promise<ReleaseRow[]> {
  const placeholders = statuses.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT * FROM releases WHERE app_id = ? AND channel = ? AND status IN (${placeholders})`,
    )
    .bind(appId, channel, ...statuses)
    .all<ReleaseRow>();
  return results;
}

/**
 * 灰度未命中的客户端回退到的“上一个已发布版本”：
 * 该通道下除当前生效版本外、最近上线的 live/archived 记录。
 */
export async function getPreviousPublishedRelease(
  db: D1Database,
  appId: string,
  channel: string,
  excludeId: string,
): Promise<ReleaseRow | null> {
  return db
    .prepare(
      `SELECT * FROM releases
       WHERE app_id = ? AND channel = ? AND status IN ('live', 'archived') AND id != ?
       ORDER BY promoted_at DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(appId, channel, excludeId)
    .first<ReleaseRow>();
}

export async function listReleases(
  db: D1Database,
  filters: { appId: string; channel?: string; status?: ReleaseStatus; limit: number; offset: number },
): Promise<ReleaseRow[]> {
  const conditions = ["app_id = ?"];
  const binds: unknown[] = [filters.appId];
  if (filters.channel) {
    conditions.push("channel = ?");
    binds.push(filters.channel);
  }
  if (filters.status) {
    conditions.push("status = ?");
    binds.push(filters.status);
  }
  binds.push(filters.limit, filters.offset);
  const { results } = await db
    .prepare(
      `SELECT * FROM releases WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds)
    .all<ReleaseRow>();
  return results;
}

export interface RegisterReleaseRow {
  id: string;
  app_id: string;
  channel: string;
  version: string;
  r2_key: string;
  sha256: string;
  size: number;
  changelog_json: string;
  rollout: number;
  now: string;
  created_by: string | null;
}

/** 登记版本：写入 draft 记录、补建通道行、写审计日志，单批原子提交 */
export async function registerRelease(
  db: D1Database,
  row: RegisterReleaseRow,
  operator: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO releases (id, app_id, channel, version, r2_key, sha256, size, changelog, status, rollout, created_at, promoted_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL, ?)`,
      )
      .bind(
        row.id,
        row.app_id,
        row.channel,
        row.version,
        row.r2_key,
        row.sha256,
        row.size,
        row.changelog_json,
        row.rollout,
        row.now,
        row.created_by,
      ),
    insertChannelIfMissing(db, { app_id: row.app_id, channel: row.channel, now: row.now }),
    buildAuditStmt(db, {
      action: "register_release",
      appId: row.app_id,
      channel: row.channel,
      releaseId: row.id,
      operator,
      detail: { version: row.version, r2_key: row.r2_key, rollout: row.rollout },
      now: row.now,
    }),
  ]);
}

// ---------- 通道指针移动（上线 / 回滚共用） ----------

export type PointerAction = "promote" | "rollback";

/**
 * 上线 / 回滚本质都是把通道指针移到目标版本：整个批次在一个事务内执行，
 * 且每条语句都带守卫条件，并发冲突时相关语句影响行数为 0、批次整体不产生脏数据。
 *
 * - 语句 0：CAS 移动通道指针（`current_release_id IS ?expected`），
 *   期望值为 NULL 表示首次上线；影响行数为 0 即 POINTER_CONFLICT。
 * - 语句 1/2：仅当指针已指向目标版本时才激活目标、归档旧版本，
 *   因此 CAS 失败时它们同样写 0 行，批次保持一致。
 */
export async function moveChannelPointer(
  db: D1Database,
  release: ReleaseRow,
  action: PointerAction,
  expectedCurrentReleaseId: string | null,
  operator: string | null,
  reason: string | null,
  previousReleaseId: string | null,
  now: string,
): Promise<{ casRows: number }> {
  const [casResult] = await db.batch([
    db
      .prepare(
        "UPDATE app_channels SET current_release_id = ?, updated_at = ? WHERE app_id = ? AND channel = ? AND current_release_id IS ?",
      )
      .bind(release.id, now, release.app_id, release.channel, expectedCurrentReleaseId),
    db
      .prepare(
        `UPDATE releases SET status = 'live', promoted_at = ?
         WHERE id = ? AND status IN ('draft', 'archived')
           AND ? = (SELECT current_release_id FROM app_channels WHERE app_id = ? AND channel = ?)`,
      )
      .bind(now, release.id, release.id, release.app_id, release.channel),
    db
      .prepare(
        `UPDATE releases SET status = 'archived'
         WHERE app_id = ? AND channel = ? AND status = 'live' AND id != ?
           AND ? = (SELECT current_release_id FROM app_channels WHERE app_id = ? AND channel = ?)`,
      )
      .bind(release.app_id, release.channel, release.id, release.id, release.app_id, release.channel),
    buildAuditStmt(db, {
      action,
      appId: release.app_id,
      channel: release.channel,
      releaseId: release.id,
      operator,
      detail: {
        version: release.version,
        from: previousReleaseId,
        expected_current_release_id: expectedCurrentReleaseId,
        reason,
      },
      now,
    }),
  ]);

  return { casRows: casResult.meta.rows_written ?? 0 };
}

// ---------- 强制更新阈值 / 灰度比例 ----------

export async function updateMinSupportedVersion(
  db: D1Database,
  appId: string,
  channel: string,
  minSupportedVersion: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE app_channels SET min_supported_version = ?, updated_at = ? WHERE app_id = ? AND channel = ?",
    )
    .bind(minSupportedVersion, now, appId, channel)
    .run();
  return (result.meta.rows_written ?? 0) > 0;
}

export async function updateRollout(
  db: D1Database,
  release: ReleaseRow,
  rollout: number,
  operator: string | null,
  now: string,
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE releases SET rollout = ? WHERE id = ?").bind(rollout, release.id),
    buildAuditStmt(db, {
      action: "update_rollout",
      appId: release.app_id,
      channel: release.channel,
      releaseId: release.id,
      operator,
      detail: { version: release.version, from: release.rollout, to: rollout },
      now,
    }),
  ]);
}

// ---------- 审计 ----------

export function buildAuditStmt(
  db: D1Database,
  entry: {
    action: string;
    appId: string;
    channel: string;
    releaseId: string | null;
    operator: string | null;
    detail: unknown;
    now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_logs (id, action, app_id, channel, release_id, operator, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      entry.action,
      entry.appId,
      entry.channel,
      entry.releaseId,
      entry.operator,
      JSON.stringify(entry.detail),
      entry.now,
    );
}
