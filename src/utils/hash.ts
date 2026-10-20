/**
 * 灰度分流：对 client_id 做 SHA-256 稳定哈希，映射到 0–99。
 * 同一 client_id 永远落在同一桶，灰度比例调整时客户端体验稳定。
 */
export async function rolloutBucket(clientId: string): Promise<number> {
  const data = new TextEncoder().encode(clientId);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const firstWord = new DataView(digest).getUint32(0);
  return firstWord % 100;
}
