# 各语言集成配方

所有配方的共同骨架：查 JSON → 判定 → 流式下载边算 SHA-256 → 比对 → 交安装器。以下代码为最小实现，生产使用时补上日志、退避与 UI 文案。

## Python（requests + hashlib）

完整可运行脚本见 [../examples/python_check.py](../examples/python_check.py)。核心：

```python
import hashlib, json, uuid, pathlib, requests

BASE, APP, CHANNEL = "https://releasedock.xxxxx.workers.dev", "com.yourco.app", "stable"

def client_id() -> str:
    f = pathlib.Path.home() / ".yourapp" / "update_client_id"
    f.parent.mkdir(parents=True, exist_ok=True)
    if not f.exists():
        f.write_text(str(uuid.uuid4()))
    return f.read_text().strip()

def check(current: str) -> dict:
    r = requests.get(f"{BASE}/v1/updates/{APP}/{CHANNEL}",
                     params={"current": current, "client_id": client_id()}, timeout=15)
    r.raise_for_status()
    return r.json()

def download(info: dict, dest: str) -> str:
    h = hashlib.sha256()
    with requests.get(info["download_url"], stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk); h.update(chunk)
    if h.hexdigest() != info["sha256"]:
        pathlib.Path(dest).unlink(missing_ok=True)
        raise RuntimeError("checksum mismatch, partial file removed")
    return dest
```

坑：`requests` 默认跟随重定向没问题；429 时 `r.status_code == 429` 自行退避。

## C（libcurl + OpenSSL + cJSON）

依赖：`libcurl`（HTTP）、`OpenSSL`（SHA-256，或换 mbedtls）、`cJSON`（解析）。

```c
#include <curl/curl.h>
#include <openssl/sha.h>
#include <cJSON.h>
#include <stdio.h>

/* 1. 查询：curl 拉取 URL 到内存字符串，cJSON 解析出
      update_available / mandatory / download_url / sha256 */
/* 2. 下载 + 边下边哈希：写回调里同时更新 SHA256_CTX */
typedef struct { FILE *fp; SHA256_CTX sha; } DL;

static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *ud) {
    DL *d = ud; size_t len = size * nmemb;
    fwrite(ptr, 1, len, d->fp);
    SHA256_Update(&d->sha, ptr, len);
    return len;
}

int download_and_verify(const char *url, const char *expect_hex, const char *dest) {
    DL d; d.fp = fopen(dest, "wb"); SHA256_Init(&d.sha);
    CURL *c = curl_easy_init();
    curl_easy_setopt(c, CURLOPT_URL, url);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &d);
    CURLcode rc = curl_easy_perform(c);
    curl_easy_cleanup(c); fclose(d.fp);
    if (rc != CURLE_OK) return -1;

    unsigned char md[SHA256_DIGEST_LENGTH];
    SHA256_Final(md, &d.sha);
    char hex[2 * SHA256_DIGEST_LENGTH + 1] = {0};
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) sprintf(hex + 2 * i, "%02x", md[i]);
    if (strcmp(hex, expect_hex) != 0) { remove(dest); return -2; } /* 校验失败删除 */
    return 0;
}
```

坑：`sprintf` 拼十六进制注意缓冲区；Windows 下 libcurl 需初始化 `curl_global_init`；不想链 OpenSSL 可下载后调 `certutil -hashfile %s SHA256`（`_popen`）比对。

## C# / .NET（全部内置，零第三方依赖）

```csharp
using System.Security.Cryptography;
using System.Text.Json;

static async Task<JsonElement> CheckAsync(HttpClient http, string baseUrl, string app, string channel,
    string current, string clientId)
{
    var json = await http.GetStringAsync(
        $"{baseUrl}/v1/updates/{app}/{channel}?current={Uri.EscapeDataString(current)}&client_id={clientId}");
    return JsonDocument.Parse(json).RootElement;
}

static async Task DownloadAndVerifyAsync(HttpClient http, JsonElement info, string dest)
{
    var expected = info.GetProperty("sha256").GetString()!;
    await using var stream = await http.GetStreamAsync(info.GetProperty("download_url").GetString()!);
    await using var fs = File.Create(dest);
    await using var hasher = new SHA256Stream(fs);   // 自定义透传 Stream：Write 时同时 SHA256.TransformBlock
    await stream.CopyToAsync(hasher);
    await hasher.FlushFinalBlockAsync();
    if (Convert.ToHexString(hasher.Hash ?? []).ToLowerInvariant() != expected)
    { fs.Close(); File.Delete(dest); throw new InvalidDataException("checksum mismatch"); }
}
```

坑：`HttpClient` 全局复用单例；进度用 `CopyToAsync(stream, buffer, progress)` 重载。

## Go（全部内置）

```go
func downloadAndVerify(url, expect, dest string) error {
    resp, err := http.Get(url)
    if err != nil { return err }
    defer resp.Body.Close()
    if resp.StatusCode != 200 { return fmt.Errorf("http %d", resp.StatusCode) }
    f, _ := os.Create(dest)
    defer f.Close()
    h := sha256.New()
    if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil { return err }
    if hex.EncodeToString(h.Sum(nil)) != expect {
        os.Remove(dest)
        return errors.New("checksum mismatch")
    }
    return nil
}
```

查询用 `net/http` + `encoding/json` 解析到 struct（字段带 `json:"update_available"` 标签）。

## Qt（QNetworkAccessManager + QCryptographicHash）

- 查询：`QNetworkAccessManager::get(QNetworkRequest(queryUrl))`，`QJsonDocument::fromJson` 解析。
- 下载：`QNetworkReply` 的 `readyRead` 增量写入 `QSaveFile`（自带原子提交）并喂 `QCryptographicHash::Sha256`；`downloadProgress(qint64, qint64)` 直接接进度条。
- `client_id` 存 `QSettings`。
- 坑：`QSaveFile::commit()` 前先比对哈希；注意 reply 的 `deleteLater`。

## Rust（reqwest + serde_json + sha2）

```rust
let resp = reqwest::get(&info.download_url).await?;
let mut file = tokio::fs::File::create(dest).await?;
let mut hasher = sha2::Sha256::new();
let mut stream = resp.bytes_stream();
while let Some(chunk) = stream.next().await {
    let chunk = chunk?;
    hasher.update(&chunk);
    file.write_all(&chunk).await?;
}
if format!("{:x}", hasher.finalize()) != info.sha256 {
    tokio::fs::remove_file(dest).await?;
    return Err(Error::ChecksumMismatch);
}
```

## Java 17+（java.net.http 内置）

`HttpClient.newHttpClient()` 发 GET；`MessageDigest.getInstance("SHA-256")` 包一层 `DigestInputStream` 读写文件；JSON 用 Jackson。`client_id` 存 `%APPDATA%` / `user.home`。

## Node / Electron

直接复制本仓库 `client/` 目录（纯 Web API 零依赖）：

```ts
import { checkForUpdate } from "./client/src/index";
import { downloadToFile } from "./client/src/node"; // Electron 主进程/Node
```

## 所有语言共同的坑

1. `client_id` 必须持久化且全局唯一（UUID v4），丢失会重进灰度判定。
2. 响应字段是蛇形命名（`update_available`、`download_url`、`sha256`），JSON 反序列化注意映射。
3. `sha256` 比对统一转小写。
4. 429 要退避重试（建议等下一个检查周期，不要立即重试）。
5. Windows 下写完安装包临时文件后，再启动安装器前记得 Flush + Close 句柄。
6. 校验失败必须删除半成品文件再重试一次，避免"损坏的安装包被重复执行"。
