/**
 * 为 R2 生成 AWS SigV4 预签名 PUT URL。
 * 不需要 wrangler/SDK，纯 Web API（crypto.subtle），零依赖。
 *
 * 凭据来源：控制台 R2 → Manage R2 API Tokens → Create API token
 * 选 "Object Read & Write"，范围建议只勾选 releasedock-packages 桶。
 *   R2_ACCOUNT_ID     —— 账户 ID（控制台右下角，或 URL 中 32 位 hex）
 *   R2_ACCESS_KEY_ID  —— Access Key ID
 *   R2_SECRET_ACCESS_KEY —— Secret Access Key（仅写入时需要 secret）
 *
 * 签名说明（按 AWS SigV4 规范）：
 *   endpoint = https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>
 *   region = 'auto'（R2 固定值）
 *   service = 's3'
 *   signed headers = host + x-amz-* 元数据（本函数只签 host）
 *   有效期通过 X-Amz-Expires（秒）控制，最大 604800（7 天）
 */

export interface PresignEnv {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** 默认绑桶 */
  R2_BUCKET?: string;
}

export interface PresignResult {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  r2Key: string;
}

const DEFAULT_EXPIRES_SECONDS = 900; // 15 分钟

const encoder = new TextEncoder();

/** SHA-256 hash，返回二进制 buffer */
async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  let buf: Uint8Array;
  if (typeof data === "string") {
    buf = encoder.encode(data);
  } else if (data instanceof Uint8Array) {
    buf = data;
  } else {
    buf = new Uint8Array(data);
  }
  const view = new ArrayBuffer(buf.byteLength);
  new Uint8Array(view).set(buf);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256，返回二进制 buffer */
async function hmacSha256(keyBytes: Uint8Array, data: string): Promise<ArrayBuffer> {
  // 拷贝到新的 ArrayBuffer，确保类型为 ArrayBuffer（排除 SharedArrayBuffer 的歧义）
  const raw = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(raw).set(keyBytes);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * RFC 3986 unreserved characters (ALPHA / DIGIT / - . _ ~) 之外才转义；
 * / 始终保留（path-style key 必备）。encodeSlash 用来管值（如 X-Amz-Credential）里的 /。
 */
function uriEscape(value: string, encodeSlash: boolean): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = ch.charCodeAt(0);
    const isUnreserved =
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x2d || // -
      code === 0x2e || // .
      code === 0x5f || // _
      code === 0x7e;   // ~
    if (isUnreserved) {
      result += ch;
    } else if (ch === "/" && !encodeSlash) {
      result += "/";
    } else {
      // 标准 percent-encoding
      result += encodeURIComponent(ch);
    }
  }
  return result;
}

function hmacSha256String(keyBytes: Uint8Array, data: string): Promise<string> {
  return hmacSha256(keyBytes, data).then(toHex);
}

/** 派生签名 key（4 步 HMAC 链） */
async function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = new Uint8Array(await hmacSha256(encoder.encode("AWS4" + secret), date));
  const kRegion = new Uint8Array(await hmacSha256(kDate, region));
  const kService = new Uint8Array(await hmacSha256(kRegion, service));
  return new Uint8Array(await hmacSha256(kService, "aws4_request"));
}

export async function presignR2Put(args: {
  env: PresignEnv;
  bucket: string;
  key: string;
  expiresSeconds?: number;
}): Promise<PresignResult> {
  const { env, bucket, key } = args;
  const expires = Math.min(Math.max(args.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS, 60), 604800);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateShort = amzDate.slice(0, 8);

  const region = "auto";
  const service = "s3";
  // 必须使用 path-style（bucket 在路径中）：R2 对预签名 URL 按 path-style 计算 canonical request，
  // 使用 virtual-hosted style（bucket 在子域）会导致 SignatureDoesNotMatch。
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = "/" + uriEscape(`${bucket}/${key}`, false);
  const endpoint = `https://${host}${canonicalUri}`;

  // 1. Canonical request
  // canonicalQuery：参数按字典序排序，key/value 都按 RFC 3986 编码（值里的 "/" 编码为 %2F）
  const rawQueryParams: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${env.R2_ACCESS_KEY_ID}/${dateShort}/${region}/${service}/aws4_request`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = rawQueryParams
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${uriEscape(k, true)}=${uriEscape(v, true)}`)
    .join("&");
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";
  // SigV4：各段以 \n 分隔。canonicalHeaders 自身以 \n 结尾，因此与 signedHeaders 之间
  // 由两个 \n 形成规范要求的空行。
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // 2. String to sign
  const requestHash = await sha256Hex(canonicalRequest);
  const credentialScope = `${dateShort}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, requestHash].join("\n");

  // 3. Sign
  const signingKey = await deriveSigningKey(env.R2_SECRET_ACCESS_KEY, dateShort, region, service);
  const signature = await hmacSha256String(signingKey, stringToSign);

  const signedQuery = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  const url = `${endpoint}?${signedQuery}`;

  return {
    url,
    method: "PUT",
    // 不需要任何额外请求头：Host 由 HTTP 客户端自动设置，手动附带反而会破坏 R2 的签名校验
    headers: {} as Record<string, string>,
    expiresAt: new Date(now.getTime() + expires * 1000).toISOString(),
    r2Key: key,
  };
}