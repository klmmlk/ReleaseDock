#!/usr/bin/env python3
"""ReleaseDock 更新检查示例（Python 标准库实现，零第三方依赖）。

用法：
    python python_check.py --current 1.0.0
    python python_check.py --current 1.0.0 --download ./setup.exe

只做查询 / 下载 / SHA-256 校验；安装动作请交给你的软件自行处理。
真实项目建议用 requests/httpx 改写（见 ../references/recipes.md），本脚本
刻意只用标准库以便任何环境直接运行。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_BASE = "https://releasedock.xxxxx.workers.dev"
DEFAULT_APP = "com.example.demo"  # 生产演示应用，可用于只读测试
CLIENT_ID_FILE = pathlib.Path.home() / ".releasedock_demo_client_id"


def get_client_id() -> str:
    """首次生成 UUID 并持久化；同一安装实例永远使用同一个 id（灰度分流依据）。"""
    if CLIENT_ID_FILE.exists():
        return CLIENT_ID_FILE.read_text(encoding="utf-8").strip()
    client_id = str(uuid.uuid4())
    CLIENT_ID_FILE.write_text(client_id, encoding="utf-8")
    return client_id


def http_get(url: str, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "releasedock-example/0.1"})
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        return resp.status, resp.read()


def check_update(base: str, app_id: str, channel: str, current: str) -> dict:
    query = urllib.parse.urlencode({"current": current, "client_id": get_client_id()})
    url = f"{base.rstrip('/')}/v1/updates/{app_id}/{channel}?{query}"
    try:
        _, body = http_get(url, timeout=15)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        if err.code == 404:
            sys.exit(f"应用或通道不存在: {detail} —— 检查 app_id/channel 拼写")
        if err.code == 429:
            sys.exit("触发限流，请稍后重试（正常检查节奏不应出现）")
        sys.exit(f"查询失败 HTTP {err.code}: {detail}")
    return json.loads(body)


def download_and_verify(info: dict, dest: str) -> pathlib.Path:
    """流式下载，边下边算 SHA-256；校验失败删除半成品并抛错。"""
    expected = info["sha256"].lower()
    path = pathlib.Path(dest)
    digest = hashlib.sha256()
    total = int(info.get("size", 0))
    done = 0
    request = urllib.request.Request(info["download_url"],
                                     headers={"User-Agent": "releasedock-example/0.1"})
    with urllib.request.urlopen(request, timeout=600) as resp, path.open("wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            if total:
                print(f"\r下载进度 {done}/{total} 字节", end="", flush=True)
    print()
    if digest.hexdigest() != expected:
        path.unlink(missing_ok=True)
        raise RuntimeError(f"SHA-256 校验失败（期望 {expected}），已删除损坏文件 {dest}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="ReleaseDock 更新检查示例")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--app", default=DEFAULT_APP)
    parser.add_argument("--channel", default="stable")
    parser.add_argument("--current", required=True, help="本机当前版本，如 1.0.0")
    parser.add_argument("--download", help="可选：下载并校验到指定路径")
    args = parser.parse_args()

    info = check_update(args.base, args.app, args.channel, args.current)
    print(json.dumps({k: v for k, v in info.items() if k != "changelog"},
                     ensure_ascii=False, indent=2))
    if info.get("changelog"):
        for entry in info["changelog"]:
            print(f"\n[{entry['version']}]")
            for item in entry["items"]:
                print(f"  - {item}")
        if info.get("changelog_truncated"):
            print("（仅展示最近 5 个版本的更新说明）")

    if not info["update_available"]:
        print("\n已是最新版本。")
        return
    if info["mandatory"]:
        print(f"\n⚠️ 强制更新：服务端最低支持版本为 {info.get('min_supported_version')}")

    if args.download:
        path = download_and_verify(info, args.download)
        print(f"已下载并通过校验: {path}（请在此处接入你的安装逻辑）")


if __name__ == "__main__":
    main()
