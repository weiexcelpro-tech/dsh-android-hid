# 汤圆蓝牙桥（TangyuanBridge）

独立的 Android 伴随 App：**替 dsh-go 的插件握住 BLE**，把 ESP32 的 HID 命令通道搬到手机本机 HTTP。

```
dsh-go 插件（proot 里，用不了蓝牙）
        │  HTTP  http://127.0.0.1:8893
        ▼
TangyuanBridge（前台服务，持有 GATT client）
        │  BLE  GATT（NUS 自定义服务）
        ▼
ESP32-S3（同时是系统眼里的蓝牙键盘/触摸屏）
        │  HID
        ▼
手机自己 ← 系统把板子当成真外设，输入直接注入
```

## 为什么需要它

dsh-go 的插件跑在 **proot** 里：没有 Binder、没有运行时权限、也没有 HCI 设备。
社区结论一致 —— **不 root 拿不到安卓蓝牙栈**。所以插件不可能自己连 BLE。

上游作者（dsh-go issue #1071）给的方向就是这条路：

> 自己单独做 app，然后用插件来桥接独立 app 和 agent 就行。

于是有了这个 App：它只用最普通的应用权限（`BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`），
对插件暴露一个**和 ESP32 固件完全同名同字段**的 HTTP 接口。

## 和固件的约定

| 项 | 值 |
|---|---|
| 设备名 | `Tangyuan HID N`（`BleClient.NAME_PREFIX` 按前缀匹配） |
| 服务 UUID | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| 命令写 RX | `6E400002-…`（Write / WriteNR，一条命令一次写，带 `\n`） |
| 回复通知 TX | `6E400003-…`（Notify；回包不带换行，按「括号配平的完整 JSON」切分） |
| 固件要求 | `setSecurityAuth(bond=true, sc=true)` → **必须先配对** |

> ⚠️ 最关键的硬约束：固件要求 bond + secure connections。
> 手机没在系统蓝牙里配过这块板子时，写 CCCD 会被拒（BlueZ 报 `0x0E Unlikely Error`，
> Android 上常见 `status=133`）。所以 App **不会在 CCCD 写完之前宣布 ready**，
> 失败时会直接提示「先去系统蓝牙配对」。
> 手机正常当 HID 用的时候 bond 早就有了，这条只在首次/解绑后才会撞上。

## HTTP 接口（127.0.0.1:8893）

路由与固件 `wifi_link.h` 一致，插件只换 base URL：

| 路由 | 说明 |
|---|---|
| `GET /health` | `svc/transport/ble/state/tip/need_screen/screen/info`，`transport:"app"` 让插件认出这是 App 桥 |
| `GET /device` | `id/name/fw/mac/ip/port/ble/rssi/mtu` |
| `GET /status` | 服务内部状态（state/detail/ready/mac/mtu/rssi） |
| `GET /screen` | 已登记的屏幕 `{known,w,h,rot,pw,ph,den}` |
| `GET /screen?w=&h=&rot=` | 登记屏幕：写固件 + 本地持久化 |
| `GET /scan` | 系统里已配对的 `Tangyuan HID*` 设备 |
| `GET /reconnect` | 手动重连 BLE（不等退避） |
| `GET|POST /cmd?j=<JSON>` | 透传固件命令；`ble` 没就绪回 503 `ble_not_ready`，超时回 504 |

## 构建

树莓派（aarch64）上直接构建，不用 Gradle、不用 x86 的 aapt2/zipalign：

```bash
cd ~/android-hid/bridge_app
bash build.sh          # → TangyuanBridge.apk（自签名，key: ~/.android/tangyuan.keystore）
```

工具链：Debian `aapt` → `javac` → `d8`（bash 脚本）→ `aapt add` → `apksigner`。
SDK 路径写死在 `build.sh` 顶部（`$HOME/android-sdk`）。

## 安装与被授权

```bash
adb install -r TangyuanBridge.apk
# 运行时权限直接给，省掉手点弹窗（Android 12+）
adb shell pm grant com.tangyuan.bridge android.permission.BLUETOOTH_SCAN
adb shell pm grant com.tangyuan.bridge android.permission.BLUETOOTH_CONNECT
adb shell pm grant com.tangyuan.bridge android.permission.POST_NOTIFICATIONS
```

首次使用顺序（很重要）：

1. 手机「设置 › 蓝牙」里配对 **Tangyuan HID N**（系统会把它当键盘/触摸屏，之后自动重连）；
2. 打开 App → 点「启动桥接」（前台服务 + 通知）；
3. App 状态变 `ready` 后，插件侧 `esp32_status` 应报「App桥 / BLE 已连接」；
4. 手机重启后服务会由 `BootReceiver` 自己拉起。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 状态 `subscribe_failed status=133` | 没配对或 bond 丢了 → 系统蓝牙里配对 `Tangyuan HID N`，再点「重连 BLE」 |
| 状态 `not_found` | 板子没上电，或不在附近；也确认没被别的 central 连走 |
| 状态 `no_service` | 固件太老（没有 NUS 自定义服务）→ 重新烧 `hid_ble_nimble` |
| `/cmd` 一直 503 | BLE 没 ready；先看 `/health` 的 `ble` 和 `state` |
| 插件报「连不上 ESP32」 | 服务没启动 / 端口被占：`adb shell "cat /proc/net/tcp | grep 22BD"`（8893 = 0x22BD） |
| 命令发出但手机没反应 | `ble` 虽然是 true，但固件的 HID 通道没被订阅（键盘+触摸都要订阅）；`esp32_status` 里的 `tip/need_screen` 能佐证 |

## 版本

| 版本 | 变更 |
|---|---|
| 1.1.0 | `/health` 补 `transport/ble/tip/need_screen/screen`；`/reconnect`；开机自启；CCCD 订阅失败不再误报 ready；丢弃旧连接回调；读 RSSI；界面加「重连 BLE」和状态提示 |
| 1.0 | 首个可用版：GATT 客户端 + 本机 HTTP + 前台服务 |
