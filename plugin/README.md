# dsh-esp32-hid

让 DSH 直接驱动手机 —— 用一颗 ESP32-S3 当**真实的蓝牙键盘鼠标**。

## 感知层（0.4.0+）：截图 + 控件树

动作有了还得有眼睛。桥 1.2.0 起提供两条感知路由（走无障碍，不用 MediaProjection 弹窗）：

| 路由 | 返回 | 用途 |
|---|---|---|
| `GET /shot?q=70` | `image/jpeg` | 当前屏幕截图 |
| `GET /a11y` | `{ok,ours_enabled,...}` | 无障碍状态 |
| `GET /a11y?tree=1&max=300` | `{ok,pkg,count,nodes:[...]}` | 前台控件树（文字+包围盒+可点） |

对应两个工具：

- **`esp32_shot`** — 截图落盘到 `$DSH_WORKSPACE/.esp32-shots/shot-<时间戳>.jpg`，返回绝对路径；
  模型随后用自己的「查看图片」工具打开即可看到屏幕。**别在返回值里塞 base64**（dsh 的 ImageBlock 需要附件引用，插件拿不到附件服务）。
- **`esp32_ui`** — 把控件树摊平成一行一节点，直接给中心坐标：
  `[3] Button "搜索" center=(540,755) box=(48,697,1032,813) click`

**推荐闭环**：`esp32_shot` 看一眼 → 用 `esp32_ui` 拿精确坐标（或直接看截图）→ `esp32_tap` 点 →
再 `esp32_shot` 确认变化。截图系统节流约 1 秒 1 张，连续调太快会失败，稍等即可。

### 前置条件（一次性）

手机上开无障碍：`设置 › 无障碍 › 已下载的服务 › 汤圆屏幕读取`。
命令行也可（adb 有 WRITE_SECURE_SETTINGS 时）：

```bash
VAL=$(adb shell settings get secure enabled_accessibility_services)
adb shell settings put secure enabled_accessibility_services "$VAL:com.tangyuan.bridge/com.tangyuan.bridge.CapService"
adb shell settings put secure accessibility_enabled 1
```

`/health` 里的 `"cap":true` 表示无障碍已就绪。

## 为什么需要它

DSH 自己的手机操作走无障碍 / ADB 权限，下面这些场景它够不着：

- 系统弹窗、「允许 USB 调试」「允许访问照片」这类**安全窗口**
- 银行、支付类 App 的**安全键盘**
- 别家 App 的**自绘界面**（Flutter / 游戏 / 画布类）
- 无障碍服务被系统或厂商杀掉之后

ESP32 在 Android 看来就是一个普通的蓝牙键盘，绕开以上全部限制。

## 通道

自动挑第一条能通的（顺序即优先级）：

| 通道 | 地址 | 前提 |
|---|---|---|
| **App 桥** ⭐ | `http://127.0.0.1:8893` | 手机上装「汤圆蓝牙桥」（`~/android-hid/bridge_app`）并点启动 |
| **OTG** | `http://127.0.0.1:8892` | 手机 Termux 里跑 `sh start_otg.sh`（老方案） |
| **无线** | `http://<esp32-ip>` | ESP32 已接入同一网络（UDP whois 自动发现） |

覆盖顺序：环境变量 `DSH_ESP32_URL`（逗号分隔多个）> 内置候选。

> **App 桥是什么**：插件跑在 proot 里拿不到安卓蓝牙栈，所以由一个独立的前台 App 握住 BLE GATT，
> 对插件暴露和 ESP32 固件**同名同字段**的本机 HTTP。上游作者的方向就是这条
> （dsh-go issue #1071：「自己单独做 app，然后用插件来桥接独立 app 和 agent」）。
> App 会在 `/health` 里报 `transport:"app"`，所以状态工具能说清是哪种通道。

> ⚠️ 固件开了 `setSecurityAuth(bond=true)`：手机**必须先配对**这块板子（系统 HID 用的时候本来就会配对），
> 否则 App 写 CCCD 会被拒（Android 常见 `status=133`）。这种情况下 `esp32_status` 会直接提示去配对。

## 工具

| 工具 | 用途 |
|---|---|
| `esp32_status` | 查通道与蓝牙连接状态（动作失败时先调它） |
| `esp32_tap {x,y}` | 按屏幕坐标点击 |
| `esp32_swipe {x1,y1,x2,y2,ms}` | 滑动/拖拽 |
| `esp32_long {x,y,ms}` | 长按（默认 900ms） |
| `esp32_text {s}` | 打字（**仅 ASCII**，中文请用 DSH 原生输入） |
| `esp32_key {k,mods}` | 物理按键，如 `k:"enter"`, `mods:"ctrl"` |
| `esp32_akey {k}` | 系统键：home / back / volup / voldown / power / wakeup … |

工具结果在 dsh-go 里渲染成原生卡片，并带一个「ESP32 状态」面板。

## 安装

完整步骤（含 **ESP32 烧录与配置**）见 **[docs/install-and-usage.md](docs/install-and-usage.md)**。

### 本地目录（开发期）

```sh
dsh plugin --profile web add /绝对路径/dsh-esp32-hid
```

装在手机本机引擎时，在 App 的「终端」里执行。

### npm（发布后）

```sh
dsh plugin --profile web add dsh-esp32-hid
```

装完按提示重启引擎；改代码后在「设置 › 插件 › 已安装 › 本插件」点**重启内核以重载**。

## 坐标

手机屏幕像素，左上角原点。1080×2340 的机器 X∈[0,1079]，Y∈[0,2339]。

取坐标的通用做法：先截图 + `uiautomator dump`，用控件 `bounds` 的中心；没有 UI 树时再看图估。

## 固件

ESP32 侧固件（USB CDC + BLE HID 双通道）在 `~/esp32-android-agent/hardware/hid_ble_nimble`，协议是 JSON 行：

```json
{"t":"tap","x":540,"y":1170}
{"t":"swipe","x1":540,"y1":2000,"x2":540,"y2":600,"ms":350}
{"t":"text","s":"hello"}
{"t":"akey","k":"home"}
```

回包：`{"ok":true,"t":"tap","ble":true}`

## 测试

```sh
node --test test/                     # 纯本地：假桥/假服务器，不碰真机
```

开发联调（不需要手机）：

```sh
node scripts/fake-bridge.mjs          # 假 App 桥，监听 127.0.0.1:8893
node scripts/live-check.mjs http://127.0.0.1:8893
node scripts/live-check.mjs http://192.168.43.22:8892   # 真板子（WiFi 直连）
```

`scripts/` 里是会真发命令的脚本，`test/` 只放无副作用的用例 —— `node --test test/` 不会误点手机。

## 许可

MIT

## 真机验收（OnePlus 6T / Android 15，2026-11-17）

App 桥（`transport:"app"`，BLE-only，手机侧 WiFi 已关）全链路实测：

| 能力 | 命令 | 结果 |
|---|---|---|
| 链路 | `esp32_status` | `transport:"App桥"`, `ble:true`, `screen:"1080x2340 rot=0"` |
| 点按 | `esp32_tap` | `ok:true`，屏幕上**真的点开了设置搜索页** |
| 滑动 | `swipe 下拉/收起通知栏` | `ok:true`，0.7~1.0s 返回，通知栏真的拉下/收起 |
| 打字 | `text "tangyuan"` | 搜索框出现前文字，并搜出 `Tangyuan HID N · 实体键盘` |
| 多媒体键 | `key home/back` | 生效 |

注意两点：

- **BLE-only 模式下 `esp32_scan` 返回 `count: 0` 是正常的** —— UDP whois 走 WiFi，板子 WiFi 关了就没有广播，但 App 桥不需要它。
- 需要固件 **0.6.6+**（单点触摸屏描述符 + 方形量程 + 手势排空）与 App **1.1.0+**（按命令长度自适应回包超时）。
