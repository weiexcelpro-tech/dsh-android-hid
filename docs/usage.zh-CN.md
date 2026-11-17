# 汤圆手机操控套件 · 脱离树莓派使用说明

> 版本：桥 1.2.0 · 插件 0.4.0 · 固件 hid_ble_nimble
> 目标：**手机自己就能跑**——不需要树莓派、不需要 adb、不需要 WiFi、不需要 root。

---

## 0. 一句话原理

```
dsh-go（手机上的 App）
   │ 工具调用 esp32_tap / esp32_shot / esp32_text …
   ▼
dsh-esp32-hid 插件（dsh-go 的 proot 里，只打 127.0.0.1:8893）
   │ HTTP（本机回环，不出手机）
   ▼
汤圆蓝牙桥 App（com.tangyuan.bridge，持有 BLE GATT 连接）
   │ BLE（蓝牙低功耗，NUS 串口服务）
   ▼
ESP32-S3（在系统看来就是一把蓝牙键盘 + 一个绝对定位鼠标）
   │ HID 报告
   ▼
手机：点、滑、长按、打字、系统键 —— 如同真人操作
```

**四件东西，三个在手机上，一个在板子上：**

| 组件 | 装在哪 | 怎么来 | 是否必需 |
|---|---|---|---|
| 汤圆蓝牙桥 App | 手机 | `TangyuanBridge.apk`（37 KB） | ✅ 必需（BLE 桥 + 眼睛） |
| dsh-go 插件 `dsh-esp32-hid` | 手机（dsh-go 内部） | 插件目录（约 110 KB） | ✅ 必需（给智能体工具） |
| ESP32-S3 + 固件 | 板子 | `hid_ble_nimble` 固件 | ✅ 必需（真正按屏幕的手） |
| 树莓派 | — | — | ❌ **完全不需要** |

---

## 1. 一次性准备：给 ESP32-S3 烧固件

> 只有这一步需要一台电脑（Windows / macOS / Linux / 树莓派都行）。烧完就可以永久拔线，
> 之后板子只要插个充电器供电即可。

### 1.1 硬件

- ESP32-S3 DevKitC-1（8 MB Flash）
- USB 数据线（插板子上的 **UART/COM 口**，不是 OTG 口）
- 一个 5V 电源（手机充电器、充电宝都行），**不需要联网**

### 1.2 烧录

**方式 A：有 PlatformIO（推荐）**

```bash
git clone <你的固件仓库>            # 或直接拷 hardware/hid_ble_nimble 目录
cd hardware/hid_ble_nimble
pio run -t upload                 # 自动编译并烧录
pio device monitor                # 115200，看到启动日志就对了
```

**方式 B：没有开发环境**

用 ESP32 官方 Flash Download Tool，烧这三样（在 `.pio/build/esp32_s3_devkitc/` 下）：

| 文件 | 地址 |
|---|---|
| `bootloader.bin` | `0x0` |
| `partitions.bin` | `0x8000` |
| `firmware.bin` | `0x10000` |

烧录参数：**8 MB Flash / DIO / 40 MHz**。

### 1.3 固件关键参数（改代码时别动错）

| 项 | 值 | 说明 |
|---|---|---|
| 蓝牙名称 | `Tangyuan HID N` | 手机里配对的就是这个名字 |
| NUS 服务 UUID | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | RX `…0002` / TX `…0003` |
| 安全 | bonding + Secure Connections，**MITM 关闭** | 所以**必须先系统配对**，未配对写 CCCD 会被拒（`status=133`） |
| MTU | 协商到 255 | 越大打字越快 |
| 串口 | UART0 (GPIO43/44) → 板载 CH343 | 日志口，可留空不接 |
| WiFi | 编译进来了但**不用** | BLE-only 模式完全不联网 |

### 1.4 上电自检

插上电源，板子上的 LED 亮 → 手机蓝牙列表里能看到 `Tangyuan HID N` → 说明固件活了。
**不用连它**（下一步在手机里配）。

---

## 2. 手机侧（第一步）：装「汤圆蓝牙桥」

### 2.1 安装

把 `TangyuanBridge.apk` 传到手机（微信文件传输助手 / 数据线 / 网盘都行），点安装。
首次会提示「未知来源」，允许即可。

装好打开，界面是这样：

```
汤圆蓝牙桥
v1.2.0 · ESP32 ⇄ BLE ⇄ 127.0.0.1:8893
服务：已停止
[启动桥接] [重连 BLE] [停止] [复制 HTTP 地址]
```

### 2.2 授权（一次性）

| 权限 | 为什么 | 怎么给 |
|---|---|---|
| 附近的设备（蓝牙） | 连 ESP32 | 首次点「启动桥接」时弹窗，允许 |
| 通知 | 前台服务常驻，不被杀 | Android 13+ 会弹，允许 |
| 电池优化白名单 | 防止后台被清 | 设置 › 应用 › 汤圆蓝牙桥 › 电池 › **不限制/允许后台活动** |

> 开机自启已内置（`BootReceiver`），重启手机后桥会自己回来，不用手动点。

### 2.3 配对 ESP32（关键，只有一次）

1. ESP32 通电
2. 手机 **设置 › 蓝牙** → 找到 `Tangyuan HID N` → 点它配对
3. 配对成功后，系统里它会显示成**已连接的键盘/鼠标设备**
4. 回到汤圆蓝牙桥 App → 点 **启动桥接**

状态应该变成：

```
服务：运行中
状态：ready · Tangyuan HID N 订阅完成 mtu=255
HTTP：http://127.0.0.1:8893
```

> ⚠️ **必须先配对再启动桥接**。顺序反了会一直 `连接失败`，此时到蓝牙里「取消保存」再重新配对一次即可。
> 换手机、刷机、板子换了名字，都要重新配对一次。

### 2.4 开无障碍（给智能体「眼睛」，强烈建议）

这一步是让智能体能 **截图 + 读控件树**，不然它只能盲点。

1. 设置 › 无障碍 › 已下载的服务（或「已安装的应用」）
2. 找到 **汤圆屏幕读取**（图标是汤圆蓝牙桥）→ 打开开关 → 确认
3. 回到桥 App，`/health` 里会显示 `"cap":true`（App 内不显示，见 §4 自检）

它跟 dsh-go 自己的「DSH 手机操控」无障碍**可以同时开**，不冲突。
关掉它只是不能截图/读树，点按打字仍然可用。

---

## 3. 手机侧（第二步）：给 dsh-go 装插件

### 3.1 版本要求

| 项 | 要求 |
|---|---|
| dsh-go | DSH `>= 0.2.1-rc.2` 且 `< 0.3.0`（1.0.14 实测通过） |
| 插件 | `dsh-esp32-hid` **0.4.0** |
| 桥 App | **1.2.0**（0.4.0 的截图/读树依赖它） |

### 3.2 把插件放进手机

任选一种：

- **A（有电脑/adb）**：`adb push dsh-esp32-hid /sdcard/Download/`
- **B（纯手机）**：把插件目录打包成 zip，用文件管理器解压到 `/sdcard/Download/dsh-esp32-hid/`

目录里应该有：`package.json` `lib/` `README.md` `cordis.patch.yml`（`docs/ test/ scripts/` 可有可无）。

### 3.3 让 dsh-go 自己搬进插件目录

dsh-go 的插件目录在它自己的 Linux 环境里（`/root/.dsh/profiles/web/plugins/`），
普通文件管理器进不去——但 **dsh-go 自己的智能体能进去**。

1. 打开 dsh-go → 右上角 **新对话**
2. 输入（**英文、别带括号和竖线**，输入法用英文键盘）：

```
cp -r /sdcard/Download/dsh-esp32-hid/. /root/.dsh/profiles/web/plugins/dsh-esp32-hid/ and then report the version
```

3. 发送 → 弹出「允许运行这条命令？」→ 点 **允许本次**
4. 等它回 `Version: 0.4.0` 之类的字样

### 3.4 重载（必须）

新代码要重启内核才生效：

- **方式 A（推荐）**：设置 › 插件 › 已安装 › **ESP32 键鼠** → **重启内核以重载**
- **方式 B**：从最近任务里划掉 dsh-go，重新打开（等 40–50 秒引擎启动）

> 重启后 **dsh-go 自己的无障碍会掉**，如果发现「DSH 手机操控」没反应：
> 设置 › 无障碍 › 重新打开「DSH 手机操控」开关即可。桥的「汤圆屏幕读取」通常也会掉，一并打开。
> （有 adb 时可一条命令重写整串，见 §7）

### 3.5 确认装载成功

设置 › 插件 › 已安装，应该看到：

```
E  ESP32 键鼠
   0.4.0 · Drive an ESP32-S3 BLE HID bridge from DSH: tap, swipe, type …
```

⚠️ **工具是「对话开始时」快照的**：装完插件/重启后，必须**新开一个对话**才能看到 `esp32_*` 工具。

---

## 4. 验收：5 分钟自检清单

新开一个对话，按顺序发这几句（英文，一次一句）：

| # | 说什么 | 期望 |
|---|---|---|
| 1 | `use the esp32_status tool and tell me the transport, screen and whether ble is connected` | 回 `ESP32·App桥`、`BLE 已连接`、`1080×2340`、`mtu=255` |
| 2 | `use esp32_shot to capture the screen, then open the saved image and describe it` | 生成 `/root/.esp32-shots/shot-*.jpg`，它能说出屏幕内容 |
| 3 | `use esp32_ui and list the first 5 nodes` | 每行一个控件，带 `center=(x,y)` |
| 4 | `use esp32_tap to tap the menu icon at x=76 y=136, then take another screenshot and tell me what changed` | 左侧抽屉弹出，它准确描述变化 |

四条全过 = **感知 + 动作闭环成立**。

---

## 5. 日常怎么用

### 5.1 智能体手里的 15 个工具

| 类别 | 工具 | 干什么 |
|---|---|---|
| 看 | `esp32_shot` | 截图落盘 → 用「查看图片」看 |
| 看 | `esp32_ui` | 读控件树，直接给出可点的中心坐标 |
| 点 | `esp32_tap` `esp32_tap_box` `esp32_aim` | 点坐标 / 点框中心 / 网格瞄准（小图标用） |
| 手势 | `esp32_swipe` `esp32_long` `esp32_sync` `esp32_release` | 滑、长按、按住不放、松手 |
| 输入 | `esp32_text` `esp32_key` `esp32_akey` | 打字 / 组合键 / 系统键（home、back、音量…） |
| 设置 | `esp32_screen` `esp32_status` `esp32_scan` | 登记屏幕尺寸 / 查状态 / 扫通道 |

### 5.2 推荐工作方式（给智能体的提示词）

```
先 esp32_shot 看一眼 → 用 esp32_ui 找目标控件的 center → esp32_tap 点它
→ 再 esp32_shot 确认结果。截图系统节流约 1 秒 1 张，别连发。
```

一句话任务示例：

- 「打开设置，把亮度调到一半」
- 「在计算器里算 1234 × 5678，并告诉我结果」
- 「微信里给张三发一句：我十分钟后到」（**注意：这会真发出去**）
- 「锁屏状态下帮我把飞行模式关掉」（a11y 够不到，HID 可以）

### 5.3 什么时候用哪条通道

| 场景 | 用谁 |
|---|---|
| 普通 App 界面（有语义控件） | `esp32_ui` + `esp32_tap`，或 dsh-go 原生无障碍 |
| 锁屏 / 密码键盘 | **只能 HID**（无障碍读不到安全窗口） |
| 系统权限弹窗、安装确认 | **HID 更稳**（无障碍常点不动） |
| 游戏 / Flutter / 自绘界面 | **HID**（无障碍只看到一大块空白） |
| 银行等检测无障碍的 App | **HID**（在系统看来就是物理键盘） |

---

## 6. 完全脱离树莓派之后

| 事情 | 能不能在手机上做 |
|---|---|
| 日常控制手机 | ✅ 全部在手机内完成，不联网 |
| 装/更新插件 | ✅ 文件放 `/sdcard/Download`，让 dsh-go 的智能体 `cp` 过去 |
| 更新桥 App | ✅ 直接装新 APK（同签名可覆盖升级） |
| 换手机重新配对 | ✅ 设置 › 蓝牙配对 `Tangyuan HID N` + 重开无障碍 |
| **重烧固件** | ⚠️ 需要一台电脑（或手机 + USB-OTG + ESP32 烧录 App）。一次性，一般不用再动 |
| 看 ESP32 日志 | ⚠️ 需要串口（电脑或树莓派）；日常不需要 |

**结论：烧好固件之后，树莓派就可以彻底撤掉。**

---

## 7. 故障排查

### 7.1 桥显示「连接失败」或一直转圈

1. 确认 ESP32 通电、蓝牙灯在闪
2. 手机 设置 › 蓝牙：`Tangyuan HID N` 是不是**已连接**（不是「已配对/未连接」）
3. 不行就：蓝牙里 **取消保存** → 重新配对 → App 里点 **重连 BLE**
4. 还不行：App 里点 **停止** 再 **启动桥接**

### 7.2 插件报「App 桥在线，但蓝牙没连上」

桥活着但 BLE 断了。就是 §7.1 的第 2–3 步。桥会自动重连，等 10 秒再看。

### 7.3 `esp32_shot` 报 503 / `screenshot_failed`

- 无障碍没开：设置 › 无障碍 › **汤圆屏幕读取** 打开
- 开着还失败：目标页面是安全窗口（银行、支付、部分视频 App）→ 系统禁止截图，无解，改用 `esp32_ui`
- 连续调用太快：系统节流（约 1 秒 1 张），等 1 秒重试

### 7.4 `esp32_ui` 返回 `no_root`

锁屏、输入法、系统弹窗、或 App 主动禁止无障碍时读不到。这三类场景改用截图（如果没被禁）或直接 HID 盲操作。

### 7.5 智能体说「没有 esp32_ 工具」

- 插件没启用：设置 › 插件 › 已安装 › ESP32 键鼠 → 打开开关
- 装完没重载：重启内核 / 重启 App
- **当前对话是装插件之前开的** → 新开一个对话

### 7.6 打字丢字 / 命令超时

- 蓝牙信号差：手机和板子别隔太远，别塞铁盒里
- 一次打太长：分段发，每段 < 100 字符
- 桥的 `/cmd` 有自动超时（每字符约 80 ms），长文本失败就分两次

### 7.7 重启手机后全都不灵

1. 桥 App 应该自己起来了（看通知栏有没有常驻通知）
2. 无障碍通常会被系统重置 → 重新打开「汤圆屏幕读取」和「DSH 手机操控」
3. 有 adb 的话一条命令搞定（需要 `WRITE_SECURE_SETTINGS`，普通用户手动点开关即可）：

```bash
VAL="com.android.systemui.accessibility.accessibilitymenu/com.android.systemui.accessibility.accessibilitymenu.AccessibilityMenuService:io.github.ccch1mneyyy.dsh_app/io.github.ccch1mneyyy.dsh_app.phone.a11y.PhoneA11yService:com.tangyuan.bridge/com.tangyuan.bridge.CapService"
adb shell settings put secure enabled_accessibility_services "\"$VAL\""
adb shell settings put secure accessibility_enabled 1
```

### 7.8 智能体点了但没反应 / 点偏了

- 屏幕尺寸登记不对：让智能体调 `esp32_screen`，或 `esp32_status` 看 `screen`
- 小图标点不准：用 `esp32_aim`（网格瞄准）或 `esp32_tap_box`（给框点中心），别硬估像素
- 检查有没有「幽灵手指」（一直按住不放）：`esp32_status` 里 `tip:true` 就调 `esp32_release`

---

## 8. 安全与边界

- 桥的 HTTP **只监听 `127.0.0.1`**，局域网/外网都访问不到；截图和控件树不落任何服务器
- ESP32 在系统看来是普通蓝牙键鼠，**不需要 root、不需要装 Xposed、不需要 adb 常驻**
- 配对是一次性信任关系：**别人拿到你的板子就能操作已配对的手机**，不用时把板子断电
- 智能体做的每个危险动作（发消息、转账、装 App）都该有人确认；dsh-go 的「权限：工作区内修改」档位要按需收紧
- 这套东西的定位是「你自己的设备、你自己的手」，别拿去做没授权的事

---

## 附：组件出处与版本

| 组件 | 位置 | 版本 |
|---|---|---|
| 桥 App 源码 / APK | `~/android-hid/bridge_app/` → `TangyuanBridge.apk` | 1.2.0 |
| 插件 | `~/dsh-plugins/dsh-esp32-hid/` | 0.4.0 |
| 固件 | `~/esp32-android-agent/hardware/hid_ble_nimble/` | — |
| dsh-go | 手机应用商店 / 官方渠道 | 1.0.14（DSH 0.2.2-rc.1） |
