import type { ChangelogEntry, ReleaseRow } from "../types";
import { compareVersions } from "../utils/semver";

/** 文档 4.2：最多拼接 5 个版本的 Changelog */
const MAX_CHANGELOG_VERSIONS = 5;

/** changelog 列存储 JSON 字符串数组，解析失败或格式不对时按空数组处理 */
export function parseChangelog(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {
    // fallthrough
  }
  return [];
}

/**
 * 拼接 current 之后到 latest 为止的 Changelog（按文档 5.2）：
 * - 仅统计 live 版本，按版本从旧到新排序；
 * - current 不在已发布版本中时，只返回最新版本的 Changelog；
 * - 超过 5 个版本时只保留最近 5 个，并置 truncated。
 */
export function buildChangelog(
  liveReleases: ReleaseRow[],
  currentVersion: string,
  latestVersion: string,
): { entries: ChangelogEntry[]; truncated: boolean } {
  const knownCurrent = liveReleases.some((r) => r.version === currentVersion);

  let candidates = liveReleases.filter(
    (r) =>
      compareVersions(r.version, currentVersion) > 0 &&
      compareVersions(r.version, latestVersion) <= 0,
  );
  if (!knownCurrent) {
    candidates = liveReleases.filter((r) => r.version === latestVersion);
  }

  candidates.sort((a, b) => compareVersions(a.version, b.version));
  const truncated = candidates.length > MAX_CHANGELOG_VERSIONS;
  const recent = truncated ? candidates.slice(-MAX_CHANGELOG_VERSIONS) : candidates;

  return {
    entries: recent.map((r) => ({ version: r.version, items: parseChangelog(r.changelog) })),
    truncated,
  };
}
