#!/usr/bin/env python3
"""把树莓派当前所用 Wi-Fi 的凭据直接转给 ESP32（NVS 持久化）。

密码只在内存里传递：读出来 → 组 JSON → 写串口，**不打印、不落盘、不进聊天记录**。
用法： python3 push_wifi_from_pi.py [--port /dev/ttyACM0]
"""
import argparse
import json
import os
import subprocess
import sys
import time


def sh(cmd, check=True):
    p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or f"命令失败: {cmd}")
    return p.stdout.strip()


def active_wifi():
    """返回 (SSID, 连接名)。用 iwgetid 取 SSID —— nmcli 的 ACTIVE 字段会被本地化成「是」。"""
    ssid, name = "", ""
    p = subprocess.run(["iwgetid", "-r", "wlan0"], capture_output=True, text=True)
    if p.returncode == 0:
        ssid = p.stdout.strip()
    for line in sh(["nmcli", "-t", "-f", "NAME,DEVICE", "connection", "show", "--active"]).split("\n"):
        if line.endswith(":wlan0"):
            name = line.rsplit(":", 1)[0]
            break
    return ssid, name


def psk(name):
    if not name:
        return ""
    p = subprocess.run(
        ["sudo", "-n", "nmcli", "-s", "-g", "802-11-wireless-security.psk", "connection", "show", name],
        capture_output=True, text=True,
    )
    return p.stdout.strip() if p.returncode == 0 else ""


def send(port, obj, wait=2.0):
    import select
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        os.write(fd, (json.dumps(obj, ensure_ascii=False) + "\n").encode())
        time.sleep(wait)
        out = b""
        deadline = time.time() + wait + 1.5
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.25)
            if not r:
                continue
            try:
                chunk = os.read(fd, 4096)
            except (BlockingIOError, OSError):
                continue
            if not chunk:
                break
            out += chunk
    finally:
        os.close(fd)
    return [l for l in out.decode("utf-8", "ignore").replace("\r", "").split("\n") if l.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyACM0")
    a = ap.parse_args()

    ssid, name = active_wifi()
    if not ssid:
        sys.exit("树莓派没连 Wi-Fi，改用 ~/.esp32_wifi 手填")
    pw = psk(name)

    print(f"SSID     : {ssid}")
    print(f"连接名   : {name}")
    print(f"密码     : {'已取到（' + str(len(pw)) + ' 位，不外显）' if pw else '❌ 取不到（需要 sudo 或改用 ~/.esp32_wifi）'}")
    if not pw:
        sys.exit(1)

    print("-" * 52)
    for line in send(a.port, {"t": "wifi", "ssid": ssid, "pass": pw, "token": ""}):
        print(line)

    print("-" * 52)
    print("等待连接（最多 30 秒）…")
    deadline = time.time() + 30
    for _ in range(15):
        hit = False
        for line in send(a.port, {"t": "wifi_status"}, wait=1.2):
            print(line)
            if '"connected":true' in line.replace(" ", ""):
                hit = True
        if hit:
            print("-" * 52)
            print("✅ Wi-Fi 通道就绪")
            return
        time.sleep(2)
    print("-" * 52)
    print("⚠️ 30 秒内没连上（ESP32 只支持 2.4GHz，确认热点不是 5GHz-only）")


if __name__ == "__main__":
    main()
