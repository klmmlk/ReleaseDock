/**
 * 轻量语义化版本解析与比较（semver 2.0.0 优先级规则）。
 * 只接受 `X.Y.Z` 与 `X.Y.Z-预发布标识` 两种形式，拒绝 `v` 前缀与 `+build`。
 */

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识按 "." 拆分；纯数字段转为 number，便于按 semver 规则比较 */
  prerelease: Array<string | number>;
}

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  const prerelease = pre
    ? pre.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
  };
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

/** a > b 返回正数，a < b 返回负数，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`非法版本号: ${!pa ? a : b}`);

  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }

  // 无预发布标识的版本优先级更高
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ida = pa.prerelease[i];
    const idb = pb.prerelease[i];
    if (ida === undefined) return -1; // 字段更少的一方优先级更低
    if (idb === undefined) return 1;
    if (ida === idb) continue;
    const aNum = typeof ida === "number";
    const bNum = typeof idb === "number";
    if (aNum && bNum) return ida - (idb as number);
    if (aNum) return -1; // 数字标识低于字母数字标识
    if (bNum) return 1;
    return ida < (idb as string) ? -1 : 1;
  }
  return 0;
}
