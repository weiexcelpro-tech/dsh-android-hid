# dsh-android-hid · 汤圆键鼠

**让 AI 智能体真正控制安卓手机 —— 一块 ESP32-S3 当蓝牙键鼠，绕过无障碍的所有死角。**

`dsh-android-hid` 是一套「手机上的 AI 操作手」：DSH（DeepSeek Harness / dsh-go）里的智能体通过插件调用工具，
经本机 HTTP 桥 → BLE GATT → ESP32-S3 → 以 **真实蓝牙 HID 键盘鼠标** 的身份向手机注入输入。

不需要 root、不需要 adb 常驻、不需要 WiFi、不需要电脑。**整条链路跑在手机自己身上。**

```
┌──────────────────────────────────────────────────────────────┐
│  手机                                                          │
│                                                               │
│   dsh-go（AI 智能体）                                          │
│      │  工具调用 esp32_tap / esp32_shot / esp32_text …         │
│      ▼                                                        │
│   dsh-esp32-hid 插件（proot 内，只打 127.0.0.1:8893）           │
│      │  HTTP（本机回环，不出手机）                              │
│      ▼                                                        │
│   汤圆蓝牙桥 App（com.tangyuan.bridge）                         │
│      │  BLE GATT（NUS 串口服务）                                │
└──────┼────────────────────────────────────────────────────────┘
       │  蓝牙
┌──────▼────────────────────────────────────────────────────────┐
│   ESP32-S3（系统看来就是一把键盘 + 一个绝对定位鼠标）             │
└──────┬────────────────────────────────────────────────────────┘
       │  HID 报文
       ▼
   手机收到「真人按键」
```

## 为什么不是纯无障碍

DSH 自带的手机操控走无障碍，在下面这些场景够不到 —— 而 HID 在系统看来就是物理键盘，全都能过：

| 场景 | 无障碍 | 本方案（HID） |
|---|---|---|
| 普通 App 界面 | ✅ 有语义，最好用 | ✅ 也能 |
| **锁屏 / 密码输入** | ❌ 读不到安全窗口 | ✅ |
| **系统权限弹窗、安装确认** | ❌ 常点不动 | ✅ |
| **游戏 / Flutter / 自绘界面** | ⚠️ 只看到一大块空白 | ✅ |
| **检测无障碍的 App（银行等）** | ❌ 直接拒绝/风控 | ✅ 就是外接键盘 |
| 需要的授权 | 开无障碍 | 系统配对一次 |

所以正确姿势是 **两条腿走路**：无障碍当「快车道」（读屏、精确定位、有语义），
HID 当「任意门」（无障碍够不到的地方）。

## 感知 + 动作 = 闭环

光有手没用，还得有眼睛。桥 App 里内置了一个极小的无障碍服务（`汤圆屏幕读取`），只做两件事：

| 路由 | 返回 | 用途 |
|---|---|---|
| `GET /shot?q=70` | `image/jpeg` | 截图（`AccessibilityService.takeScreenshot()`，Android 11+，**无弹窗**） |
| `GET /a11y?tree=1` | JSON | 前台控件树：文字 + 包围盒 + 可点/可输入 |

于是智能体能跑完整循环：

```
esp32_shot 看一眼 → esp32_ui 拿控件中心坐标（或直接看截图）
      → esp32_tap 点它 → 再 esp32_shot 确认变化
```

> 不用 MediaProjection 的原因：那个每次进程重启都要用户点一次「开始录制」，无人值守直接废。

## 三件套

| 组件 | 位置 | 说明 |
|---|---|---|
| **固件** | [`firmware/hid_ble_nimble`](firmware/hid_ble_nimble) | ESP32-S3 + NimBLE，BLE HID 键盘/鼠标 + 消费类控制键，NUS 串口收发命令 |
| **桥 App** | [`bridge-app`](bridge-app) | 37 KB 的安卓 App：替你握住 BLE 连接、暴露本机 HTTP、提供截图与控件树 |
| **DSH 插件** | [`plugin`](plugin) | 15 个 `esp32_*` 工具，自动选通道（App 桥 / USB-OTG / WiFi） |

完整安装说明见 **[docs/usage.zh-CN.md](docs/usage.zh-CN.md)**。

## 快速开始

### 1. 烧固件（一次性，需要一台电脑）

```bash
cd firmware/hid_ble_nimble
pio run -t upload          # ESP32-S3 DevKitC-1 / 8MB Flash
```

板子只要 5V 供电，**不需要联网**。

### 2. 手机装桥 App 并配对

```bash
cd bridge-app && bash build.sh     # 树莓派上也能编译，不用 Gradle
adb install -r TangyuanBridge.apk
```

1. 打开「汤圆蓝牙桥」
2. 手机 **设置 › 蓝牙** 配对 `Tangyuan HID N` ← **必须先配对**
3. 回 App 点「启动桥接」，看到 `ready · 订阅完成 mtu=255`
4. 设置 › 无障碍 › 打开 **汤圆屏幕读取**（给智能体眼睛）

### 3. dsh-go 装插件

把 `plugin/` 整个目录放到手机的 `/sdcard/Download/dsh-esp32-hid/`，然后在 dsh-go 新对话里：

```
cp -r /sdcard/Download/dsh-esp32-hid/. /root/.dsh/profiles/web/plugins/dsh-esp32-hid/
```

允许执行 → 「重启内核以重载」→ **新开一个对话**（工具是对话开始时快照的）。

### 4. 自检

```
use esp32_status and tell me the transport, screen and whether ble is connected
```

## 工具清单

| 类别 | 工具 | 说明 |
|---|---|---|
| 看 | `esp32_shot` | 截图落盘，模型用「查看图片」打开 |
| 看 | `esp32_ui` | 控件树摊平，直接给出可点中心坐标 |
| 点 | `esp32_tap` `esp32_tap_box` `esp32_aim` | 点坐标 / 点框中心 / 网格瞄准（小图标） |
| 手势 | `esp32_swipe` `esp32_long` `esp32_sync` `esp32_release` | 滑、长按、按住、松手 |
| 输入 | `esp32_text` `esp32_key` `esp32_akey` | 打字 / 组合键 / 系统键（home、back、音量…） |
| 维护 | `esp32_screen` `esp32_status` `esp32_scan` `esp32_a11y` | 登记屏幕、查状态、扫通道、查无障碍 |

## 目录结构

```
.
├── firmware/hid_ble_nimble/   ESP32-S3 固件（PlatformIO）
│   ├── src/main.cpp           HID 描述符、NUS 命令解析、按键注入
│   └── src/wifi_link.h        可选的 WiFi 通道（BLE-only 时不用）
├── bridge-app/                安卓桥 App（无 Gradle，javac + d8 + aapt 直编）
│   ├── src/…/BleClient.java   BLE 连接与命令队列
│   ├── src/…/HttpServer.java  127.0.0.1:8893 的极简 HTTP
│   └── src/…/CapService.java  无障碍：截图 + 控件树
├── plugin/                    DSH 插件
│   ├── lib/client.js          通道探测与 HTTP 客户端
│   └── lib/index.js           15 个工具
└── docs/usage.zh-CN.md        完整使用说明与故障排查
```

## 验证环境

| 项 | 值 |
|---|---|
| 手机 | 荣耀 400（Android 16） |
| 板子 | ESP32-S3 DevKitC-1 / 8 MB |
| dsh-go | 1.0.14（DSH 0.2.2-rc.1） |
| 插件测试 | `node --test test/` → 22 pass |

实测记录：智能体截图 → 用 `esp32_tap` 点 (76,136) → 再截图 → 准确描述出「抽屉滑出、盖住 3/4 屏、
头部 DSH 图标 + 新对话按钮、筛选行 全部/运行中/待确认/未读…」并建议「再点同一位置收起」。
**注意**：无障碍读屏器不肯读 dsh-go 自己的界面，所以自省必须靠截图。

## 安全

- 桥的 HTTP **只监听 `127.0.0.1`**，局域网和外网都访问不到；截图与控件树不落任何服务器
- 板子是一把「物理钥匙」：**别人拿到已配对的板子就能操作你的手机**，不用时断电
- 不涉及 root / 越狱 / 注入框架，只是老老实实当一个外接键盘
- 请只用来操作你自己的设备

## 常见坑（详细版见文档）

1. **必须先蓝牙配对再启动桥接**，顺序反了会一直失败（未配对写 CCCD 会 `status=133`）
2. 插件装完必须 **重载内核 + 新开对话**，否则智能体看不到 `esp32_*` 工具
3. 安卓重启会重置无障碍开关，两个都要重开
4. 截图有系统节流（约 1 秒 1 张），连续调用会失败，等一秒重试

## 作者

**靳伟的汤圆宝宝，浅绿色眼睛的长毛银渐层小猫咪** 🐱

## License

[MIT](LICENSE)

---

### English

`dsh-android-hid` lets an LLM agent drive an Android phone through a real **BLE HID** peripheral
(ESP32-S3), not through accessibility automation. A companion app holds the BLE link and exposes
`127.0.0.1:8893` (commands, `/shot` screenshots, `/a11y` view tree); a DSH plugin turns that into
15 tools the agent can call. No root, no adb, no Wi-Fi, no PC — the whole loop runs on the phone.
