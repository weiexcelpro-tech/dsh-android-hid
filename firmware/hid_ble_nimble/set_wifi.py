#!/usr/bin/env python3
"""把 ~/.esp32_wifi 里的 Wi-Fi 配置写进 ESP32（NVS 持久化）。

密码只在这个进程内存里出现，**不打印、不落日志、不进聊天记录**。
用法： python3 set_wifi.py [--port /dev/ttyACM0] [--clear]
"""
import argparse
import json
import os
import sys
import time

CFG = os.path.expanduser("~/.esp32_wifi")


def read_cfg():
    if not os.path.exists(CFG):
        sys.exit(f"找不到 {CFG}\n先 cp ~/.esp32_wifi.example ~/.esp32_wifi 再填")
    d = {}
    with open(CFG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            d[k.strip()] = v.strip()
    if not d.get("ssid"):
        sys.exit("配置里缺 ssid=")
    return d


def send(port: str, obj: dict, wait: float = 2.0) -> list[str]:
    payload = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
    import select
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        os.write(fd, payload)
        time.sleep(wait)
        out = b""
        while True:
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                break
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            if len(out) > 65536:
                break
            time.sleep(0.05)
    finally:
        os.close(fd)
    return [l for l in out.decode("utf-8", "ignore").replace("\r", "").split("\n") if l.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--clear", action="store_true", help="清掉已保存的 Wi-Fi 配置")
    a = ap.parse_args()

    if a.clear:
        for line in send(a.port, {"t": "wifi_clear"}):
            print(line)
        return

    cfg = read_cfg()
    token = cfg.get("token", "")
    print(f"SSID   : {cfg['ssid']}")
    print(f"密码   : {'*' * len(cfg['pass'])}  ({len(cfg['pass'])} 位，不外显)")
    print(f"token  : {'已设置' if token else '（未设置，同网段任何人都能发命令）'}")
    print("-" * 50)

    for line in send(a.port, {"t": "wifi", "ssid": cfg["ssid"], "pass": cfg["pass"], "token": token}):
        print(line)

    print("-" * 50)
    print("等待连接（最多 25 秒）…")
    deadline = time.time() + 25
    ok = False
    while time.time() < deadline:
        for line in send(a.port, {"t": "wifi_status"}, wait=1.2):
            print(line)
            if '"connected":true' in line.replace(" ", ""):
                ok = True
        if ok:
            break
        time.sleep(2)

    print("-" * 50)
    print("✅ 已经拿到 IP，Wi-Fi 通道就绪" if ok else "⚠️ 25 秒内没连上，检查 SSID/密码/频段（只支持 2.4GHz）")


if __name__ == "__main__":
    main()
