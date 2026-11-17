# ESP32 手机键鼠桥 —— 安装到使用

> 给 DSH / dsh-go 用的「手机操控外挂」：ESP32-S3 在 Android 看来就是一把真实的蓝牙键盘 + 一根绝对坐标触控笔。
> 遇到无障碍够不着的地方（系统弹窗、安全键盘、自绘界面、无障碍被杀），就用它。

版本：固件 `0.2.1-nimble` · 插件 `dsh-esp32-hid 0.1.0`
最后验证：2026-11-11 · 一加 6T（ONEPLUS A6013 / Android 15 / 1080×2340）+ ESP32-S3 YD 板（16MB Flash）实测通过

---

## 0. 先看懂链路

```
        ┌──────────── 命令通道（二选一）────────────┐
        │                                          │
   [DSH 插件] ──HTTP──▶ Termux hidlink ──USB CDC──▶ ESP32-S3 ──BLE HID──▶ 手机自己
   (工具 esp32_*)        127.0.0.1:8892            (libusb 免 root)        (键盘/触控笔)
        │                                          ▲
        └──────── 调试时也可以直接从树莓派 curl ──────┘
```

要点：

- **ESP32 是"手"，不是"脑"**。它只负责按键和点屏；看屏幕、做决策的是 DSH 里的视觉模型。
- **USB 只负责传命令，不负责当键鼠**。真正的输入走蓝牙 HID，所以要同时：① USB 连上 ② 蓝牙配对好。
- 手机通过 OTG 给板子供电，板子不用另接电源。

---

## 1. 准备清单

| 东西 | 规格 / 备注 |
|---|---|
| ESP32-S3 开发板 | 本机是 YD-ESP32-S3（印刷 YD-ESP32-23），实测 16MB Flash + 8MB PSRAM |
| 数据线 ×1 | **必须能传数据**，纯充电线不行 |
| 树莓派（或任意 Linux 主机） | 用来编译烧录，aarch64 原生支持，不需要 x86 |
| 手机 | 开 OTG；本机是一加 6T / Android 15 |
| Termux | 手机上装，跑 OTG 桥 |

### 认板子：两个 Type-C 口，插错是最常见的坑

| 板上印字 | 实际走什么 | 用途 |
|---|---|---|
| `COM` | CH343P 桥 (GPIO43/44, UART0) | **烧录和看日志走这个** |
| `USB-OTG` | 芯片原生 USB (GPIO19/20) | **跑起来后插手机走这个** |

两者枚举出来**都可能叫 `/dev/ttyACM0`**，别靠设备名判断，看 `lsusb`：

```bash
lsusb | grep -i 303a    # 303a:1001 = 芯片原生 USB（OTG 口）
lsusb | grep -i 1a86    # 1a86:55d3 = CH343 桥（COM 口）
```

> ⚠️ 烧录时只插 COM 口。**烧完要把 COM 口线拔掉**，再插 OTG 口到手机 —— 两路 5V 并接会互相顶供电，出难查的枚举故障。

---

## 2. 烧录固件

固件在 `~/esp32-android-agent/hardware/hid_ble_nimble/`，用 PlatformIO 构建。

### 2.1 环境

```bash
# PlatformIO 装在独立 venv 里
python3 -m venv ~/.pio-venv
~/.pio-venv/bin/pip install platformio
```

### 2.2 编译 + 烧录

```bash
cd ~/esp32-android-agent/hardware/hid_ble_nimble

# 只编译
~/.pio-venv/bin/pio run -e esp32_s3_devkitc

# 编译并烧录（COM 口，通常是 /dev/ttyACM0）
~/.pio-venv/bin/pio run -e esp32_s3_devkitc -t upload --upload-port /dev/ttyACM0

# 看串口日志
~/.pio-venv/bin/pio device monitor -p /dev/ttyACM0 -b 115200
```

### 2.3 `platformio.ini` 每一项为什么这么写

```ini
[env:esp32_s3_devkitc]
platform = espressif32@6.12.0
board = esp32-s3-devkitc-1
framework = arduino
board_build.flash_mode = dio
board_upload.flash_size = 8MB
board_build.partitions = default_8MB.csv
lib_deps =
    bblanchon/ArduinoJson@7.4.2
    h2zero/NimBLE-Arduino
build_unflags =
    -DBOARD_HAS_PSRAM
build_flags =
    -DCORE_DEBUG_LEVEL=0
    -DARDUINO_USB_MODE=0
    -DARDUINO_USB_CDC_ON_BOOT=1
```

| 配置 | 作用 / 踩坑 |
|---|---|
| `ARDUINO_USB_CDC_ON_BOOT=1` | **关键**：让 `Serial` 走到原生 USB(OTG) 口，手机才能通过 USB CDC 发命令 |
| `ARDUINO_USB_MODE=0` | 走 USB-Serial/JTAG 而非 Hardware CDC，配合上一项 |
| 自建 `logPort(0)` | UART0(GPIO43/44) 仍独立可用 → **插树莓派 COM 口照样有日志，插手机 OTG 口照样能发命令**，两不误 |
| `build_unflags = -DBOARD_HAS_PSRAM` | 板上 PSRAM 未启用，取消该宏避免初始化卡住。**一行一个宏**，写在一行会一个都取消不掉 |
| `default_8MB.csv` | 芯片实际 16MB，但按 8MB 分区表烧足够用且稳定 |

### 2.4 烧完自检

拔掉 COM 口线 → 插到树莓派或手机，看串口：

```
=== hid_ble_nimble 0.2.1-nimble ===
screen default 1080x2340
[ble] advertising as "Tangyuan HID N"
[ble] connected (7.5~15ms)
```

看到 `advertising` 就说明固件活了、正在等手机连。

---

## 3. 手机侧：蓝牙配对

1. 手机 **设置 › 蓝牙** → 打开蓝牙
2. 等待扫描出现 **`Tangyuan HID N`** → 点配对（**无配对码**，固件用 Just Works + bonding）
3. 连上后，在任意输入框打字，通知栏/输入法会提示「**物理键盘已连接**」

> 配对一次后系统会记住（bonding），之后 ESP32 上电会自动回连，不用每次重配。

> 这一步成功后再往下做，否则后面命令发得出去、屏幕上什么都不会发生。

---

## 3.5 推荐路线：装「汤圆蓝牙桥」App（不插线、不用 Termux）

插件跑在 proot 里**拿不到安卓蓝牙栈**，所以由这个独立 App 握住 BLE GATT，对插件暴露
`127.0.0.1:8893` 的本机 HTTP（路由和固件完全一致）。dsh-go 作者给的方向就是这条：
*「自己单独做 app，然后用插件来桥接独立 app 和 agent 就行」*。

工程：`~/android-hid/bridge_app`（源码 + README + `build.sh`，git 已初始化）。

```bash
# 1) 构建（树莓派 aarch64 直接跑，不需要 Gradle）
cd ~/android-hid/bridge_app && bash build.sh     # → TangyuanBridge.apk

# 2) 安装 + 授权（Android 12+ 的蓝牙权限直接给，省掉弹窗）
adb install -r TangyuanBridge.apk
adb shell pm grant com.tangyuan.bridge android.permission.BLUETOOTH_SCAN
adb shell pm grant com.tangyuan.bridge android.permission.BLUETOOTH_CONNECT
adb shell pm grant com.tangyuan.bridge android.permission.POST_NOTIFICATIONS

# 3) 打开 App 点「启动桥接」；状态变 ready 即可
```

验证（手机本机或 `adb forward tcp:8893 tcp:8893` 后从树莓派打）：

```bash
curl -s http://127.0.0.1:8893/health
# {"ok":true,"svc":"tangyuan-hid","proto":1,"transport":"app","ble":true,"state":"ready",...}
curl -s "http://127.0.0.1:8893/cmd?j=%7B%22t%22%3A%22ping%22%7D"
```

> **首次装完必须先在系统蓝牙里配对 `Tangyuan HID N`**（见 §3）。固件开了
> `setSecurityAuth(bond=true)`，没配对的 central 写 CCCD 会被拒（Android 常见 `status=133`），
> App 会显示 `subscribe_failed` 并提示去配对。

装好这一节，§4 的 Termux/OTG 路线可以完全跳过（它只是没有 App 时的备选）。

---

## 4. 打通 USB 命令通道（OTG + Termux，备选）

原理：Android 自己不会把 USB CDC 转成串口发给 App，所以借 Termux 的 `termux-usb` 拿到 fd，再用 **libusb 直接操作**，**不需要 root**。

### 4.1 一次性准备

```bash
# Termux 里
pkg update
pkg install python libusb termux-api

# 确认能列出 USB 设备（ESP32 已插 OTG 口）
termux-usb -l
# 例：/dev/bus/usb/001/002
```

### 4.2 把桥接脚本放进 Termux

从树莓派推过去（或用 `curl` 拉）：

```bash
# 树莓派上起个临时 HTTP 服务
cd ~/android-hid/phone && python3 -m http.server 8891

# 手机上
cd ~ && curl -O http://<树莓派IP>:8891/hidlink.py
# 同理拿 serve.sh / start_otg.sh
chmod +x hidlink.py serve.sh start_otg.sh
```

### 4.3 启动

```bash
sh start_otg.sh
```

输出应该是：

```
=== 状态 ===
{"ok": true, "info": "VID=303a PID=1001 iface=1 IN=0x84 OUT=0x03 mps=64"}
=== 自检 ping ===
{"ok":true,"t":"ping","ble":true}
```

`ble:true` = 蓝牙那一头也连着，整条链路通了。

**设备路径会变**（换口/重启后会变），`start_otg.sh` 里写死了 `/dev/bus/usb/001/002`，不对就改成 `termux-usb -l` 看到的那个。

### 4.4 手动测试（不经插件）

```bash
curl 'http://127.0.0.1:8892/health'

# 回桌面
curl -G --data-urlencode 'j={"t":"akey","k":"home"}' 'http://127.0.0.1:8892/cmd'

# 点屏幕中心
curl -G --data-urlencode 'j={"t":"tap","x":540,"y":1170}' 'http://127.0.0.1:8892/cmd'

# 打字（仅 ASCII）
curl -G --data-urlencode 'j={"t":"text","s":"hello"}' 'http://127.0.0.1:8892/cmd'
```

---

## 5. 安装 DSH 插件

插件在 `~/dsh-plugins/dsh-esp32-hid/`（package.json / cordis.patch.yml / lib/）。

### 5.1 传到手机并装进 profile

```bash
# 树莓派 → 手机共享目录
adb push dsh-esp32-hid /sdcard/Download/
```

然后在**手机 App 的终端**（或让 App 里的 Agent 帮你跑）执行：

```bash
# 复制进 profile 的插件目录
mkdir -p ~/.dsh/profiles/web/plugins
cp -r /sdcard/Download/dsh-esp32-hid ~/.dsh/profiles/web/plugins/dsh-esp32-hid

# 确认依赖可解析（@deepseek-ai/dsh-tools）
ls ~/.dsh/profiles/web/node_modules/@deepseek-ai

# 语法自检
node --check ~/.dsh/profiles/web/plugins/dsh-esp32-hid/lib/index.js
```

> ⚠️ `dsh plugin --profile web add /本地目录` 对**本地目录**支持不好（`link:` 来源常装不进去）。
> 实测可靠的做法就是上面这样**直接复制进 `plugins/`**。

### 5.2 启用并重启

1. 手机 App → **设置 › 插件** → 找到 **ESP32 键鼠** → 确认开关是开的
2. 点 **「重启内核以重载」**；找不到就整 App 重启：

```bash
adb shell am force-stop io.github.ccch1mneyyy.dsh_app
adb shell monkey -p io.github.ccch1mneyyy.dsh_app -c android.intent.category.LAUNCHER 1
```

3. **开一个新对话** —— 工具目录是按会话构建的，老会话看不到新工具

### 5.3 验证

新对话里说一句「跑一下 esp32_status」，应该返回：

```
ESP32 通道 OTG (http://127.0.0.1:8892)，蓝牙 HID 已连接
ble = true · transport = OTG
```

---

## 6. 使用

### 6.1 插件提供的 7 个工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `esp32_status` | — | 动作失败时先调它：查通道、地址、BLE 是否连着 |
| `esp32_tap` | `x, y` | 按坐标点击 |
| `esp32_swipe` | `x1,y1,x2,y2,ms` | 滑动 / 拖拽（默认 300ms） |
| `esp32_long` | `x,y,ms` | 长按（默认 900ms），出右键菜单用 |
| `esp32_text` | `s` | 打字，**仅 ASCII**；中文用 DSH 原生输入 |
| `esp32_key` | `k, mods` | 物理键：`enter`/`esc`/`tab`/`space`/方向键/单字符，`mods` 可 `ctrl+shift` |
| `esp32_akey` | `k` | 系统键：`home`/`back`/`forward`/`search`/`menu`/`volup`/`voldown`/`mute`/`playpause`/`next`/`prev`/`wakeup`/`sleep`/`power` |

典型用法（模型自己会这么组织）：

```
截图 → 分析 / 用 uiautomator dump 拿控件 bounds → 算中心点 → esp32_tap(540, 1170)
→ 再截图验证
```

### 6.2 固件完整命令表（绕过插件直连时用）

一行一个 JSON，走 `/cmd?j=<json>` 或串口：

| 命令 | 示例 | 说明 |
|---|---|---|
| `ping` | `{"t":"ping"}` | 链路自检，回 `ble` 状态 |
| `screen` | `{"t":"screen","w":1080,"h":2340}` | 设定逻辑屏幕，换机/横竖屏切换时发 |
| `tap` | `{"t":"tap","x":540,"y":1170}` | 点按 |
| `long` | `{"t":"long","x":540,"y":1170,"ms":1200}` | 长按 |
| `swipe` | `{"t":"swipe","x1":540,"y1":2000,"x2":540,"y2":600,"ms":350}` | 滑动 |
| `text` | `{"t":"text","s":"hello"}` | ASCII 打字 |
| `key` | `{"t":"key","k":"enter","mods":"ctrl"}` | 组合键 |
| `akey` | `{"t":"akey","k":"home"}` | 系统键 |
| `paste/copy/cut/selectall/enter` | `{"t":"paste"}` | 剪贴板与回车快捷操作 |
| `wait` | `{"t":"wait","ms":500}` | 固件侧延时 |

**限速 40 条/秒**，超了回 `{"ok":false,"err":"rate_limited"}`；不在白名单回 `op_not_allowed`。

### 6.3 坐标怎么取

坐标是**屏幕像素，左上角原点**，1080×2340 的机器就是 X∈[0,1079] Y∈[0,2339]。

```bash
# ① 拿控件位置（最准）
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml
# 解析 bounds="[418,890][1799,984]" → 中心 (1108, 937)

# ② 没有 UI 树（游戏/画布）就截图目测
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png
```

> ⚠️ **横竖屏**：固件按「竖屏长边」做坐标映射。手机横屏时要先发 `screen` 命令同步新尺寸，否则会点歪。
> 稳的做法：操作前把手机锁成竖屏。

### 6.4 一个真实好用的场景

DSH 检测到「物理键盘已连接」时，会要求 **Ctrl+Enter** 发送。这时：

```bash
curl -G --data-urlencode 'j={"t":"key","k":"enter","mods":"ctrl"}' \
  'http://127.0.0.1:8892/cmd'
```

—— 用 ESP32 自己把消息发出去。实测连发 3 条都正常。

---

## 7. 排错表

按"现象 → 先查什么"的顺序看。

| 现象 | 先查 | 解法 |
|---|---|---|
| 命令回 `connect ECONNREFUSED` | Termux 里 `curl 127.0.0.1:8892/health` | 桥没起，重跑 `sh start_otg.sh` |
| `ping` 回 `ble:false` | 手机蓝牙列表里 `Tangyuan HID N` 是否连着 | 重新配对；ESP32 断电重启后会自动重新广播 |
| `{"ok":false,"err":"rate_limited"}` | 是不是循环发太快 | 加 `wait`，别超过 40 条/秒 |
| `op_not_allowed` | 命令名拼错 | 对照 6.2 的命令表 |
| 点了没反应，坐标明显偏移 | 手机是否横屏；屏幕分辨率 | 锁竖屏 + 先发 `screen` |
| 打字出乱码/不出字 | 是不是中文/emoji | 固件只支持 ASCII，中文走 DSH 原生输入 |
| 烧录报 `LIBUSB_ERROR_BUSY` | 有进程占着串口 | `pkill -f hidlink`；或 `systemctl --user stop` 相关服务 |
| 烧录找不到端口 | 插的是哪个口 | 烧录插 COM 口；`lsusb` 看 303a/1a86 |
| 烧完串口一个字符都没有 | 插错口了 | CDC 固件必须从 **USB-OTG 口**输出，或从 COM 口看 `logPort` |
| 板子反复重启 | 供电冲突 | 拔掉 COM 口线，只留 OTG |
| 插件装了但模型说没有这个工具 | 有没有开新对话 / 重启内核 | 开新对话；改代码必须重启内核 |
| `esp32_status` 报"蓝牙未连接"但实际连着 | 老版本 bug（`/health` 无 `ble` 字段） | 升级到 0.1.0 之后（已改为 ping 兜底） |

---

## 8. 已知限制

1. **只有 OTG 通道能用**。固件目前**没有 Wi-Fi**（`WiFi.h` 未引入）；插件里的"无线"地址是给以后留的口子，`DSH_ESP32_URL` 可指向任意实现了同协议的桥。
2. **只支持 ASCII 输入**。中文请走 DSH 原生输入法通道。
3. **坐标按竖屏长边映射**，横屏需先发 `screen` 同步。
4. **蓝牙空闲会掉**，掉线后 ESP32 自动重新广播，手机端一般自动重连；连不上就手动点一下。
5. **安全边界**：模型不会用 HID 去点"银行/支付/密码/验证码"这类确认框 —— 这类操作留给人。这是刻意设计的，不是缺陷。

---

## 9. 文件清单

| 路径 | 作用 |
|---|---|
| `~/esp32-android-agent/hardware/hid_ble_nimble/` | 固件（`src/main.cpp` + `platformio.ini`） |
| `~/android-hid/phone/hidlink.py` | libusb CDC 驱动 + HTTP 服务 |
| `~/android-hid/phone/serve.sh` | `termux-usb -e` 回调包装（`-e` 只收单个可执行路径） |
| `~/android-hid/phone/start_otg.sh` | 一键启动 + 自检 |
| `~/dsh-plugins/dsh-esp32-hid/` | DSH 插件源码 |
| `~/.dsh/profiles/web/plugins/dsh-esp32-hid` | 手机上插件实际安装位置 |

---

## 10. 一分钟跑通（老手版）

```bash
# 1. 树莓派：烧固件（COM 口）
cd ~/esp32-android-agent/hardware/hid_ble_nimble && \
  ~/.pio-venv/bin/pio run -e esp32_s3_devkitc -t upload --upload-port /dev/ttyACM0

# 2. 拔 COM 线 → 插手机 OTG 口 → 手机蓝牙配对 "Tangyuan HID N"

# 3. 手机 Termux：起桥
sh ~/start_otg.sh
#   看到 {"ok":true,"t":"ping","ble":true} 就通了

# 4. 手机 App：设置›插件 确认启用 → 重启内核 → 开新对话 → 说"跑一下 esp32_status"
```

---

## 11. 无线模式（免 OTG，推荐）

### 为什么值得换

| | OTG 有线 | 无线 |
|---|---|---|
| 手机供电给 ESP32 | ✅ 要给（峰值 240mA，很耗电） | ❌ 不用 |
| 手机能同时充电 | ❌ USB 口被占 | ✅ |
| 拖着线 | 要 | 不用 |
| 命令通道 | USB CDC | Wi-Fi（ESP32 自己的电） |

**关键**：命令走 Wi-Fi，蓝牙只负责 HID。手机的耗电只剩蓝牙本身（几乎可以忽略），
Wi-Fi 那份电落在 ESP32 自己的充电器上——这就是"独立供电"。

```
插件 ──Wi-Fi(HTTP 8892)──▶ ESP32 ──BLE HID──▶ 手机（键鼠输入）
        ▲                              ▲
        └ 命令                          └ 输入
ESP32 插自己的充电器，手机插自己的充电器
```

### 11.1 固件要求

`0.3.0-wifi` 及以上（新增 Wi-Fi STA + HTTP + UDP 发现 + mDNS）。

```bash
cd ~/esp32-android-agent/hardware/hid_ble_nimble
~/.pio-venv/bin/pio run -e esp32_s3_devkitc -t upload --upload-port /dev/ttyACM0
# 启动日志里应看到：=== hid_ble_nimble 0.3.0-wifi ===
```

### 11.2 配 Wi-Fi（三种方式，密码都不进聊天记录）

**方式 A：树莓派已经在同一个热点上（最省事）**

```bash
cd ~/esp32-android-agent/hardware/hid_ble_nimble
python3 -u push_wifi_from_pi.py          # 从 NetworkManager 直接搬凭据到 ESP32
```

脚本只打印 SSID 和密码长度，密码本身不落地、不打印。

**方式 B：自己填文件**

```bash
cp ~/.esp32_wifi.example ~/.esp32_wifi && chmod 600 ~/.esp32_wifi
# 编辑 ~/.esp32_wifi 填 ssid/pass（可选 token）
python3 -u set_wifi.py
```

**方式 C：直接发串口命令**（任何串口终端都行）

```json
{"t":"wifi","ssid":"你的Wi-Fi","pass":"密码","token":"可选口令"}
{"t":"wifi_status"}
{"t":"wifi_clear"}
```

配置存在 NVS，重启不忘。**只支持 2.4GHz**——5GHz-only 的热点连不上。

### 11.3 验证

```bash
# 从同一网段任何一台机器
curl http://<ESP32-IP>:8892/health
curl http://<ESP32-IP>:8892/device      # 身份握手：svc / id / mac / fw
curl -G --data-urlencode 'j={"t":"ping"}' http://<ESP32-IP>:8892/cmd
```

`/device` 正常的样子：

```json
{"ok":true,"svc":"tangyuan-hid","proto":1,"id":"TY-8FEE68",
 "name":"tangyuan-8fee68","fw":"0.3.0-wifi","mac":"68:ee:8f:4e:ee:d4",
 "ip":"192.168.43.22","port":8892,"ble":true,"auth":false,"rssi":-37}
```

### 11.4 插件怎么认出"这是我们的 ESP32"

**不锁 MAC、不锁 IP**，靠协议握手：

1. 插件向 `255.255.255.255:8890` 广播 `{"q":"whois","svc":"tangyuan-hid"}`
2. 任何一台跑这套固件的板子回一份身份 JSON（含 `svc`、`id`、`ip`、`port`、`ble`）
3. 插件**只留 `svc === "tangyuan-hid"` 的**——同网段的路由器、电视、别的 IoT 一律忽略
4. 多台应答时，**`ble:true`（正连着蓝牙）的排前面**——它多半就是这台手机在用的那台
5. 拿到 IP 后再 `GET /health` 复核一次，才算连通

所以：换板子、换 IP、换网段都不用改配置，扫描自动发现。手动触发用工具 `esp32_scan`。

> mDNS 也在广播（`tangyuan-<chipid>.local` + `_tangyuan-hid._tcp`），
> 但很多路由器拦多播，所以**发现的主路径是 UDP 广播**，mDNS 只作兜底。

### 11.5 安全

- 同网段的任何人都能发命令 → 给 `/device` 里 `auth:true` 之前，建议设 `token`
- 设了 token 后：`curl 'http://<ip>:8892/cmd?token=<口令>&j=...'`，不带就是 `401 bad_token`
- 热点是私网，风险有限；接公共 Wi-Fi 时务必设 token

### 11.6 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 串口刷 `未配置 Wi-Fi` | NVS 里没有凭据 | 走 11.2 |
| 连不上、日志停在 connecting | 热点是 5GHz-only | 换 2.4GHz 或开双频 |
| `esp32_scan` 扫不到 | 不在同一网段 / 路由器隔离了广播 | 确认同网段；改用 `DSH_ESP32_URL=http://<ip>:8892` |
| 命令通但点不动 | `ble:false`（蓝牙没连） | 手机蓝牙里重新配对 "Tangyuan HID N" |
| 点了位置偏 | 屏幕参数没登记 / 传的是像素但没给 w,h | 先 `esp32_screen {w,h,rot}`，或动作工具直接带 `w/h` |

---

## 12. 旋转与坐标（实测四向变换表）

外部 HID 数字化仪进入 Android 后，**系统会自己施加显示旋转**，而且偏移量用的是
**面板固有尺寸**（X 用宽、Y 用高），不是旋转后的尺寸。实测（OnePlus 6T，1080×2340）：

| ROT | 屏幕坐标 ← 发出去的 px,py | 反解（要打 du,dv 就发） | 覆盖 |
|---|---|---|---|
| 0（竖屏） | `X=px, Y=py` | `px=du, py=dv` | ✅ 全屏 |
| 1（90°） | `X=PANEL_W−py, Y=px` | `px=dv, py=PANEL_W−du` | ⚠️ `du>1080` 不可达 |
| 2（180°） | `X=PANEL_W−px, Y=PANEL_H−py` | `px=PANEL_W−du, py=PANEL_H−dv` | ✅ 全屏 |
| **3（270°）** | `X=py, Y=PANEL_H−px` | `px=PANEL_H−dv, py=du` | ✅ **全屏** |

**结论：横屏请用 270°（`rot=3`）。** 90° 只能覆盖左侧 `1080/2340 ≈ 46%` 的宽度——
要覆盖 `X>1080` 需要 `py<0`，而无符号 HID 报告发不出负值。

固件 `0.3.1-rot` 起：
- 按上表反解，`px` 上界放宽到长边（270° 要靠 `px∈[1260,2340]` 走到屏幕下半部）
- 点位命令回包里带 `rot / px / py`，超出可达带时带 `clipped:true`
- `/screen` 的 GET 会返回当前 `w/h/rot/den`，插件据此判断要不要重新登记

### 坐标归一化的坑

插件的 `u,v` 是**各轴独立**的相对值（`u=x/宽`、`v=y/高`），不要统一除长边：
竖屏统一除长边会让横向整体偏 `2340/1080 ≈ 2.17` 倍（实测点 `x=270` 落到 `124`）。

### 一个已知限制：长按会阻塞固件主循环

`{"t":"long","ms":6000}` 这类长按在固件里是 `delay()` 阻塞的，期间 HTTP/UDP 都不响应。
默认长按 800ms 影响不大；需要超长按时，脚本里的下一条命令要等它结束再发，
否则会看到"扫描不到设备""命令没反应"这类假故障。

---

## 13. 输出 schema 的坑（工具"装了但没注册"的真正原因）

**症状**：设置›插件里显示「已启用、组件 1 个」，看着一切正常，但 agent 那边
`tools` 列表里**一个 `esp32_*` 都没有**，它只会说"没有这个工具"。

**原因**：`output.schema` 写成了属性级 `required: true`：

```js
// ❌ 加载时直接抛错，整个插件的工具都注册不上
properties: { ok: { type: 'boolean', required: true } }
```

JSON Schema 的 `required` 必须是**数组**、放在**对象层**：

```js
// ✅
properties: { ok: { type: 'boolean' } },
required: ['ok'],
```

注意 **tool 的 `parameters` 不受影响** —— `defineTool` 的扁平写法里 `required: true`
是合法的，只有 `output.schema` 会走严格的 JSON Schema 校验。

回归测试：`test/schema.test.js` 会扫所有 `output: {...}` 块，发现属性级
`required: true` 就报红（已做反向验证：塞回 bug 必红）。
