/** 生成带前缀的随机 ID，如 rel_1a2b3c...（18 个十六进制字符，96 位随机） */
export function generateId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${prefix}_${hex}`;
}

/** 当前时间的 ISO 8601 UTC 字符串，如 2026-10-20T08:00:00.000Z */
export function nowIso(): string {
  return new Date().toISOString();
}
