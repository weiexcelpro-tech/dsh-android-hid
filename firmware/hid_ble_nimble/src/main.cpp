// hid_ble_nimble —— NimBLE 版 ESP32-S3 蓝牙 HID 桥（键盘 + 绝对坐标触摸屏）
//
// 与 Bluedroid 版（../hid_ble）**协议完全一致**，只换 BLE 协议栈，用于对比：
//   * 配对/重连稳定性 * 命令往返延迟 * 固件体积/内存 * HID + 自定义服务共存能力
//
// 命令（串口或 BLE 自定义服务，一行一个 JSON）：
//   {"t":"ping"} / {"t":"screen","w":1080,"h":2340} / {"t":"tap","x":..,"y":..}
//   {"t":"long","x":..,"y":..,"ms":..} / {"t":"swipe","x1":..,"y1":..,"x2":..,"y2":..,"ms":..}
//   {"t":"text","s":"..."}（仅 ASCII）/ {"t":"key","k":"enter","mods":"ctrl"}
//   {"t":"paste"} {"t":"copy"} {"t":"cut"} {"t":"selectall"} {"t":"enter"} / {"t":"wait","ms":..}
#include <Arduino.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

// C3 SuperMini 没接 UART，日志只能走 USB CDC；S3 保持原样（UART0 走 CH343）
#if defined(CONFIG_IDF_TARGET_ESP32C3)
#define LOGF(...) do { logPort.printf(__VA_ARGS__); Serial.printf(__VA_ARGS__); } while (0)
#define LOGB(s)   do { logPort.println(s);             Serial.println(s);          } while (0)
#else
#define LOGF(...) logPort.printf(__VA_ARGS__)
#define LOGB(s)   logPort.println(s)
#endif

// 触摸屏集合开关：
//   0（默认）= 只出 键盘 + 消费控制 + 绝对鼠标。
//     BLE/uhid 触摸屏在 Android 上会被判成「外接且无 display viewport」，
//     坐标恒为 (0,0)，点哪都点不动；鼠标没有这个问题。
//   1 = 保留 Digitizer 触摸屏（部分机型可用，需要 `-DWITH_TOUCH=1` 重新编译）
#ifndef WITH_TOUCH
#define WITH_TOUCH 1
#endif

static const char *FW_VERSION = "0.6.6-swipedrain";
static const char *DEVICE_NAME = "Tangyuan HID N";
// 面板原生尺寸（竖屏固有分辨率），由 screen 命令下发；换任何机型都不用改固件
static uint16_t PANEL_W = 1080;
static uint16_t PANEL_H = 2340;
// 当前显示旋转：0=0° 1=90° 2=180° 3=270°（与 Android Surface.ROTATION_* 一致）
static uint8_t ROT = 0;
// 数字化仪的原始逻辑量程（Android dumpsys input 的 Motion Ranges max）。
// 多数机器等于面板长边，但并非所有机型如此，所以允许下发覆盖。
static uint16_t DEN = 0;   // 0 = 自动取长边
// 坐标缩放模式，见 denX()/denY()：0=分轴（默认） 1=方形（都按长边）
static uint8_t AXES = 0;
// 点击模式：0 = 绝对坐标鼠标（默认）；1 = 触摸屏。
// 触摸屏在 Android 上会被判成「外接触摸屏且无 display viewport」，坐标归零到 (0,0)；
// 鼠标没有这个问题，所以默认走鼠标。
static uint8_t MODE = 1;
// 本次上电后有没有收到过调用方现场推送的分辨率。
// NVS 里那套只能算「上次的记忆」，换了手机/改了分辨率就完全是错的，
// 所以每次启动都置 false，逼调用方重新登记一次。
static bool g_screenSynced = false;

static inline uint16_t logicalW() { return (ROT & 1) ? PANEL_H : PANEL_W; }
static inline uint16_t logicalH() { return (ROT & 1) ? PANEL_W : PANEL_H; }
// 触摸坐标缩放模式：
//   0 = 分轴（X 按逻辑宽、Y 按逻辑高）—— 默认。Android 的 Motion Range 是分轴的
//       （实测一加 6T：X max=1079、Y max=2339），两轴都用长边会把 X 压扁 2.17 倍。
//   1 = 方形（两轴都按长边 / DEN）—— 少数机型把 Motion Range 报成长边时的兼容模式。
static inline uint16_t denomLong() { return DEN ? DEN : (PANEL_W > PANEL_H ? PANEL_W : PANEL_H); }
static inline uint16_t denX() { return AXES ? denomLong() : logicalW(); }
static inline uint16_t denY() { return AXES ? denomLong() : logicalH(); }
static inline uint16_t denom() { return DEN ? DEN : (PANEL_W > PANEL_H ? PANEL_W : PANEL_H); }

#include "wifi_link.h"   // 依赖上面的 PANEL_*/ROT/logicalW，所以放这里

// ---------------- 屏幕参数持久化 ----------------
// 不落盘的话每次重启都退回编译期默认值（1080x2340），换机型/改分辨率后
// 第一次点击必然整体偏移，而且很难看出原因。
static void screenSave() {
    Preferences p;
    if (!p.begin("tangyuan", false)) return;
    p.putUShort("sw", PANEL_W);
    p.putUShort("sh", PANEL_H);
    p.putUChar("rot", ROT);
    p.putUShort("den", DEN);
    p.putUChar("ax", AXES);
    p.putUChar("md", MODE);
    p.end();
}

static void screenLoad() {
    Preferences p;
    if (!p.begin("tangyuan", true)) return;
    const uint16_t w = p.getUShort("sw", PANEL_W);
    const uint16_t h = p.getUShort("sh", PANEL_H);
    const uint8_t  r = p.getUChar("rot", ROT);
    const uint16_t d = p.getUShort("den", DEN);
    const uint8_t  ax = p.getUChar("ax", AXES);
    // md 不再使用：本版固定走触摸屏
    p.end();
    if (w > 100 && h > 100) { PANEL_W = w; PANEL_H = h; ROT = r & 3; DEN = d; }
    AXES = 1;
    MODE = 1;   // 这一版专测单点触摸屏：不再让 NVS/调用方把它改回鼠标
    AXES = 1;   // Stylus 描述符下 Android 两轴量程都报长边 → 必须方形映射
    LOGF("[screen] restored %ux%u rot=%u den=%u axes=%s mode=%s\n",
                   PANEL_W, PANEL_H, ROT, denom(), AXES ? "square" : "split",
                   MODE == 0 ? "mouse" : "touch");
}

#define SVC_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID  "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define TX_UUID  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// Report 1 = 键盘；Report 2 = Digitizer 触摸屏（0..32767 绝对坐标）
static const uint8_t REPORT_MAP[] = {
    // ---- Report 4: 绝对坐标鼠标 ----
    // 为什么要有它：BLE/uhid 触摸屏在 Android 上被标成 isExternal 且没有 display
    // viewport（dumpsys input 里 displayId=''），坐标会被归零到 (0,0)，点哪都点不动。
    // 鼠标不受这个限制：绝对坐标 + 左键，等价于「移动光标到目标再点」。
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02,
    0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31,
    0x16, 0x00, 0x00, 0x26, 0xFF, 0x7F,
    0x75, 0x10, 0x95, 0x02, 0x81, 0x02,
    0xC0, 0xC0,
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,
    0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
    0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65,
    0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
    0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x95, 0x05, 0x75, 0x01, 0x91, 0x02,
    0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
    0xC0,
#if WITH_TOUCH
    // ---- Report 5: 单点触摸屏（Digitizer/Touch Screen + Stylus 单点）----
    // 为什么不是 Finger(0x22)+ContactID+ContactCount：那套会被 hid-multitouch 接管，
    // 而 uhid 触摸屏在 Android 上是 isExternal 且没有 display viewport，坐标被归零。
    // 这套（Stylus 0x20 + Pointer 集合 + 0..10000）参考 ESP32-BLE-Abs-Mouse 的实机可用写法：
    // 单点笔形态不进 hid-multitouch，走的是普通 HID 绝对指针映射。
    0x05, 0x0D, 0x09, 0x04, 0xA1, 0x01, 0x85, 0x05,   // Digitizer/Touch Screen, Report ID 5
    0x09, 0x20, 0xA1, 0x00,                            //   Usage(Stylus) Collection(Physical)
    0x09, 0x42, 0x09, 0x32,                            //     Tip Switch, In Range
    0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x02, 0x81, 0x02,
    0x75, 0x01, 0x95, 0x06, 0x81, 0x01,                //     6 bit padding
    0x05, 0x01, 0x09, 0x01, 0xA1, 0x00,                //     Generic Desktop/Pointer Collection(Physical)
    0x09, 0x30, 0x09, 0x31,                            //       X, Y
    0x16, 0x00, 0x00, 0x26, 0x10, 0x27,                //       Logical 0..10000
    0x36, 0x00, 0x00, 0x46, 0x10, 0x27,                //       Physical 0..10000
    0x66, 0x00, 0x00,                                  //       Unit None
    0x75, 0x10, 0x95, 0x02, 0x81, 0x02,                //       16bit X,Y
    0xC0, 0xC0, 0xC0,                                  //     End Collection ×3
#endif  // WITH_TOUCH
    // ---- Report 3: Consumer Control（Android 的 HOME/BACK/音量就靠这个）----
    0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x03,
    0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x2A, 0xFF, 0x03,
    0x75, 0x10, 0x95, 0x01, 0x81, 0x00,
    0xC0,

};

HardwareSerial logPort(0);

NimBLEHIDDevice *hid;
NimBLECharacteristic *kbdIn, *touchIn, *consIn, *mouseIn, *rxChar, *txChar;
volatile bool linkConnected = false, kbdSub = false, touchSub = false, consSub = false, mouseSub = false;
volatile bool txSub = false;   // NUS TX（回包通道）有没有被订阅
String serialLine, bleLine, usbLine;    // usbLine = OTG 口(CDC) 收到的命令


// 「能干活」= 链路在 && 至少有一个输入通道被订阅。
// 旧实现要求 touchSub 恒真，WITH_TOUCH=0 时会让 tap/text/key 全部回 no_hid —— 真机踩过：
// 键盘明明是通的，却因为没编触摸集合而被判成「没 HID」。
// 链路在不在，直接问协议栈。别再信 linkConnected 这个握手变量：
// 重连时旧连接的 onDisconnect 会晚到，把新连接刚置好的 true 又抹回 false，
// 于是订阅全是 1、命令却回 no_hid（真机实测）。
static inline bool linkUp() {
    NimBLEServer *srv = NimBLEDevice::getServer();
    return srv && srv->getConnectedCount() > 0;
}

bool hidReady() { return linkUp() && (kbdSub || touchSub || consSub || mouseSub); }
// 键盘类动作（text/key/enter/paste…）只认键盘通道，别被触摸/鼠标拖累
bool kbdReady() { return linkUp() && kbdSub; }

// ---------------- HID 发送 ----------------
// 通知重试：BLE 拥塞时 NimBLE 的 notify() 会返回 false。
// 丢一条「松开」报告 = Android 认为键一直按着 → 自动重复同一个字符（真机踩过：
// 打 "hello" 出来一长串 "ooooo"）；丢一条回包 = 调用方干等到超时。
static bool notifyRetry(NimBLECharacteristic *c, const uint8_t *d, size_t n, int tries = 6) {
    if (!c) return false;
    for (int i = 0; i < tries; ++i) {
        if (c->notify(d, n)) return true;
        delay(12);          // 等主机把 ATT 队列消化掉再试，6ms 太急
    }
    LOGF("[hid] notify failed after %d tries\n", tries);
    return false;
}

void kbdReport(uint8_t key = 0, uint8_t mods = 0) {
    uint8_t d[8] = {mods, 0, key, 0, 0, 0, 0, 0};
    if (kbdSub) notifyRetry(kbdIn, d, sizeof(d));
}

// 逻辑坐标（当前显示方向，0..1）→ 面板像素
//
// ⚠️ 关键：Android 对「外部 HID 数字化仪」**自己会施加显示旋转**，而且用的偏移量是
// 面板固有尺寸（X 用 PANEL_W、Y 用 PANEL_H），不是旋转后的尺寸。实测四向变换：
//   ROT=0: 屏幕X=px        屏幕Y=py
//   ROT=1: 屏幕X=PANEL_W-py 屏幕Y=px        ← 90° 只能覆盖 X≤PANEL_W（Android 的取整方式决定）
//   ROT=2: 屏幕X=PANEL_W-px 屏幕Y=PANEL_H-py
//   ROT=3: 屏幕X=py         屏幕Y=PANEL_H-px  ← 270° 用 px 走 0..PANEL_H，全屏可达
// 所以这里做的是**反解**：给定目标屏幕坐标，反推该发的 px,py。
// 横屏请优先用 ROT=3（270°），ROT=1 有 54% 宽度不可达。
bool lastClipped = false;   // ROT=1 时目标超出可达带 → 被夹住，调用方要知道

void logicalToPanel(float u, float v, uint16_t &px, uint16_t &py) {
    u = constrain(u, 0.0f, 1.0f);
    v = constrain(v, 0.0f, 1.0f);
    lastClipped = false;
    const float du = u * (float)(logicalW() - 1);   // 目标：屏幕上的像素
    const float dv = v * (float)(logicalH() - 1);
    float rx, ry;
    switch (ROT & 3) {
        case 0:  rx = du;                    ry = dv;                    break;
        case 1:  rx = dv;                    ry = (float)PANEL_W - du;   break;
        case 2:  rx = (float)PANEL_W - du;   ry = (float)PANEL_H - dv;   break;
        default: rx = (float)PANEL_H - dv;   ry = du;                    break;
    }
    if (rx < 0 || ry < 0) lastClipped = true;       // ROT=1 的 du>PANEL_W 会走到这里
    // 横屏时 px 需要越过面板宽度（0..PANEL_H），所以上界用长边
    const float hi = (float)((PANEL_W > PANEL_H ? PANEL_W : PANEL_H) - 1);
    px = (uint16_t)constrain(rx, 0.0f, hi);
    py = (uint16_t)constrain(ry, 0.0f, hi);
}

// ---------------- 触摸状态机：杜绝「幽灵手指」 ----------------
// 只发 DOWN 不发 UP（BLE notify 丢包 / 链路中途断 / 固件重启），Android 会认为手指
// 一直按着，之后所有点击、滑动、返回手势全部失效，只能锁屏解锁才能救回来。
// 四道防线：
//   1) notify 返回值必须检查并重试（原来直接丢弃返回值，正是事故根因）
//   2) 抬起用最后坐标，失败就保留 g_tip，交给看门狗继续补发
//   3) 每条触摸动作开始前先补一次抬起（上一笔没收尾）
//   4) 主循环看门狗：按下超过 TIP_WATCHDOG_MS 无条件抬起
static bool g_tip = false;                  // 当前是否按下（Android 侧视角）
static uint32_t g_tipSince = 0;             // 按下时刻
static uint16_t g_tipX = 0, g_tipY = 0;     // 最后位置（抬起要用同一点）
static uint32_t g_tipDrops = 0;             // 抬起失败的累计次数（排查用）
static const uint32_t TIP_WATCHDOG_MS = 6000;

static const uint32_t TOUCH_MAX = 10000;   // 描述符里的 Logical Maximum

static bool touchRaw(uint16_t px, uint16_t py, bool tip) {
    // 分轴缩放（默认）：X 按逻辑宽、Y 按逻辑高。Android 的 Motion Range 通常就是分轴的，
    // 两轴共用长边会把 X 压扁（一加 6T 实测 1080/2340≈0.46，点屏幕右侧会跑到左边）。
    uint32_t dx = denX(), dy = denY();
    if (!dx) dx = 1000;
    if (!dy) dy = 1000;
    uint32_t lx = (uint32_t)min(px, (uint16_t)dx) * TOUCH_MAX / dx;
    uint32_t ly = (uint32_t)min(py, (uint16_t)dy) * TOUCH_MAX / dy;
    uint8_t d[5];
    d[0] = (tip ? 0x01 : 0x00) | 0x02;             // TipSwitch + InRange
    d[1] = lx & 0xFF;                              // X (0..10000)
    d[2] = (lx >> 8) & 0xFF;
    d[3] = ly & 0xFF;                              // Y
    d[4] = (ly >> 8) & 0xFF;
    if (!touchIn || !touchSub) return false;
    for (int i = 0; i < 3; ++i) {
        if (touchIn->notify(d, sizeof(d))) {
            LOGF("[touch] -> touchIn(%p) len=%d d0=%02X x=%u y=%u\n",
                           (void *)touchIn, (int)sizeof(d), d[0], (unsigned)lx, (unsigned)ly);
            return true;
        }
        delay(6);                            // BLE 拥塞时给内核一点时间
    }
    return false;
}

void touchReport(uint16_t px, uint16_t py, bool tip) {
    const bool ok = touchRaw(px, py, tip);
    if (tip) {
        g_tip = true;               // 保守：即使 notify 报错也当作已按下，后面一定会补抬起
        g_tipSince = millis();
        g_tipX = px; g_tipY = py;
    } else if (ok) {
        g_tip = false;
    } else {
        ++g_tipDrops;               // 抬起丢了：保持 g_tip，交给重试/看门狗
    }
}

// 出界报告：InRange=0 + TipSwitch=0。
// 抬起后必须补发一次：只发 tip=0 而不出界，Android 会认为这支笔一直悬停在屏上
// （dumpsys input 里 isHovering=true），手指触摸会被笔压制 → 整屏点不动。
static bool touchRawOOR(uint16_t px, uint16_t py) {
    uint32_t dx = denX(), dy = denY();
    if (!dx) dx = 1000;
    if (!dy) dy = 1000;
    uint32_t lx = (uint32_t)min(px, (uint16_t)dx) * TOUCH_MAX / dx;
    uint32_t ly = (uint32_t)min(py, (uint16_t)dy) * TOUCH_MAX / dy;
    uint8_t d[5];
    d[0] = 0x00;                                  // TipSwitch=0, InRange=0（出界）
    d[1] = lx & 0xFF; d[2] = (lx >> 8) & 0xFF;
    d[3] = ly & 0xFF; d[4] = (ly >> 8) & 0xFF;
    if (!touchIn || !touchSub) return false;
    for (int i = 0; i < 3; ++i) {
        if (touchIn->notify(d, sizeof(d))) return true;
        delay(6);
    }
    return false;
}

// 抬起：用最后坐标、带重试；成功后补发出界。返回是否真正发出
bool touchUp() {
    if (!g_tip) { touchRawOOR(g_tipX, g_tipY); return true; }   // 即使没按下也退一次悬停
    for (int i = 0; i < 4; ++i) {
        if (touchRaw(g_tipX, g_tipY, false)) {
            g_tip = false;
            delay(6);
            touchRawOOR(g_tipX, g_tipY);           // 关键：离开悬停，否则手指被压制
            return true;
        }
        delay(10);
    }
    ++g_tipDrops;
    return false;
}

bool touchIsDown() { return g_tip; }

// ---------------- 绝对坐标鼠标通道（Report 4）----------------
// 报文：[buttons][xL][xH][yL][yH]，X/Y 与触摸同量程（0..32767）
static bool mouseRaw(uint16_t px, uint16_t py, uint8_t buttons) {
    if (!mouseIn || !mouseSub) return false;
    uint32_t dx = denX(), dy = denY();
    if (!dx) dx = 1000;
    if (!dy) dy = 1000;
    uint32_t lx = (uint32_t)min(px, (uint16_t)dx) * 32767u / dx;
    uint32_t ly = (uint32_t)min(py, (uint16_t)dy) * 32767u / dy;
    uint8_t d[5];
    d[0] = buttons;
    d[1] = lx & 0xFF; d[2] = (lx >> 8) & 0xFF;
    d[3] = ly & 0xFF; d[4] = (ly >> 8) & 0xFF;
    for (int i = 0; i < 3; ++i) {
        if (mouseIn->notify(d, sizeof(d))) return true;
        delay(6);
    }
    return false;
}

void doTapMouse(uint16_t x, uint16_t y, uint16_t holdMs) {
    mouseRaw(x, y, 0x00);        // 先把光标挪过去（Android 需要一次纯移动）
    delay(12);
    mouseRaw(x, y, 0x01);        // 左键按下
    delay(holdMs);
    mouseRaw(x, y, 0x00);        // 松开
    g_tipX = x; g_tipY = y; g_tip = false;
}

void doSwipeMouse(uint16_t x1, uint16_t y1, uint16_t x2, uint16_t y2, uint16_t ms) {
    mouseRaw(x1, y1, 0x00);
    delay(12);
    mouseRaw(x1, y1, 0x01);
    int steps = max(6, (int)(ms / 20));
    for (int i = 1; i <= steps; ++i) {
        float k = (float)i / (float)steps;
        uint16_t cx = (uint16_t)(x1 + ((int)x2 - (int)x1) * k);
        uint16_t cy = (uint16_t)(y1 + ((int)y2 - (int)y1) * k);
        mouseRaw(cx, cy, 0x01);
        delay(max(4, (int)(ms / steps)));
    }
    mouseRaw(x2, y2, 0x00);
    g_tipX = x2; g_tipY = y2; g_tip = false;
}

// ---------------- ASCII → HID 键码 ----------------
bool asciiHid(char c, uint8_t &key, uint8_t &mods) {
    mods = 0;
    if (c >= 'a' && c <= 'z') { key = c - 'a' + 4; return true; }
    if (c >= 'A' && c <= 'Z') { key = c - 'A' + 4; mods = 0x02; return true; }
    if (c >= '1' && c <= '9') { key = c - '1' + 30; return true; }
    if (c == '0') { key = 39; return true; }
    const char *plain = " -=[]\\;'`,./";
    const char *shifted = " _+{}|:\"~<>?";
    const uint8_t codes[] = {44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56};
    for (size_t i = 0; i < 12; ++i) {
        if (c == plain[i]) { key = codes[i]; return true; }
        if (c == shifted[i]) { key = codes[i]; mods = 0x02; return true; }
    }
    const char *symbols = "!@#$%^&*()";
    for (size_t i = 0; i < 10; ++i)
        if (c == symbols[i]) { key = (i == 9) ? 39 : 30 + i; mods = 0x02; return true; }
    return false;
}

uint8_t keyCode(const String &n) {
    if (n == "enter" || n == "return") return 40;
    if (n == "esc" || n == "back") return 41;
    if (n == "backspace") return 42;
    if (n == "tab") return 43;
    if (n == "space") return 44;
    if (n == "delete" || n == "del") return 76;
    if (n == "home") return 74;
    if (n == "end") return 77;
    if (n == "pageup") return 75;
    if (n == "pagedown") return 78;
    if (n == "right") return 79;
    if (n == "left") return 80;
    if (n == "down") return 81;
    if (n == "up") return 82;
    return 0;
}

uint8_t parseMods(const String &m) {
    uint8_t v = 0;
    if (m.indexOf("ctrl") >= 0) v |= 0x01;
    if (m.indexOf("shift") >= 0) v |= 0x02;
    if (m.indexOf("alt") >= 0) v |= 0x04;
    if (m.indexOf("gui") >= 0 || m.indexOf("win") >= 0 || m.indexOf("cmd") >= 0) v |= 0x08;
    return v;
}

void doChar(char c, uint8_t extraMods) {
    uint8_t key = 0, mods = 0;
    if (!asciiHid(c, key, mods)) return;
    kbdReport(key, mods | extraMods);
    delay(15);
    kbdReport(0, 0);          // 松开必须发出去，否则字符会一直重复
    delay(60);                // 60ms 让主机的 ATT 队列排空，连发会堆积
}

uint16_t consumerUsage(const String &n) {
    if (n == "home") return 0x0223;      // AC Home  → Android HOME
    if (n == "back") return 0x0224;      // AC Back  → Android BACK
    if (n == "forward") return 0x0225;
    if (n == "search") return 0x0221;
    if (n == "menu") return 0x0040;
    if (n == "volup") return 0x00E9;
    if (n == "voldown") return 0x00EA;
    if (n == "mute") return 0x00E2;
    if (n == "playpause") return 0x00CD;
    if (n == "next") return 0x00B5;
    if (n == "prev") return 0x00B6;
    if (n == "wakeup") return 0x0069;
    if (n == "sleep") return 0x0032;
    if (n == "power") return 0x0030;
    return 0;
}

void consumerKey(uint16_t usage) {
    uint8_t d[2] = {(uint8_t)(usage & 0xFF), (uint8_t)(usage >> 8)};
    if (consSub && consIn) notifyRetry(consIn, d, 2);
    delay(25);
    uint8_t z[2] = {0, 0};
    if (consSub && consIn) notifyRetry(consIn, z, 2);
    delay(25);
}

void doKey(const String &name, uint8_t mods = 0) {
    uint8_t k = keyCode(name);
    if (!k) return;
    kbdReport(k, mods);
    delay(10);
    kbdReport(0, 0);
    delay(20);
}

void doTap(uint16_t x, uint16_t y, uint16_t holdMs) {
    touchReport(x, y, true);
    delay(holdMs);
    touchUp();
}

void doSwipe(uint16_t x1, uint16_t y1, uint16_t x2, uint16_t y2, uint16_t ms) {
    int steps = max(6, (int)(ms / 20));
    touchReport(x1, y1, true);
    delay(16);
    for (int i = 1; i <= steps; ++i) {
        float k = (float)i / steps;
        touchReport(x1 + (int)((x2 - (int)x1) * k), y1 + (int)((y2 - (int)y1) * k), true);
        delay(max(4, (int)(ms / steps)));
    }
    touchUp();
}

void doText(const String &s) {
    for (size_t i = 0; i < s.length(); ++i) {
        char c = s[i];
        if (c == '\n' || c == '\r') { kbdReport(40); delay(15); kbdReport(0); delay(60); continue; }
        doChar(c, 0);
    }
    // 收尾保险：连发两次空报告，确保没有任何键卡住
    kbdReport(0, 0);
    delay(20);
    kbdReport(0, 0);
}

static bool rateOk() {
    static uint32_t winStart = 0;
    static uint16_t count = 0;
    const uint16_t RATE_LIMIT = 40;
    uint32_t now = millis();
    if (now - winStart > 1000) { winStart = now; count = 0; }
    return ++count <= RATE_LIMIT;
}

static bool textAllowed(const String &t) {
    for (size_t i = 0; i < t.length(); ++i) {
        char c = t[i];
        if (c == '\n' || c == '\r') continue;
        if (c < 0x20 || c > 0x7E) return false;
    }
    return true;
}

// ---------------- 回复 ----------------
String *g_replySink = nullptr;   // HTTP 通道要把同一份 JSON 拿回去
// 点位类命令的附加回显（reply() 会 clear 掉 doc，只能走全局）
bool g_replyClipped = false;
uint16_t g_replyPx = 0, g_replyPy = 0;
int g_replyRot = -1;

void reply(JsonDocument &doc, bool ok, const char *t, const char *err = nullptr) {
    doc.clear();
    doc["ok"] = ok;
    if (t) doc["t"] = t;
    if (err) doc["err"] = err;
    doc["ble"] = hidReady();
    // 诊断字段：连上没 / 四条输出通道订阅没 / 回包通道订阅没
    doc["link"] = linkUp() ? 1 : 0;
    doc["kbd"] = kbdSub ? 1 : 0;
    doc["cons"] = consSub ? 1 : 0;
    doc["mouse"] = mouseSub ? 1 : 0;
    doc["touch"] = touchSub ? 1 : 0;
    doc["tx"] = txSub ? 1 : 0;
    doc["tip"] = g_tip;              // true = 还按着没收尾（幽灵手指风险）
    doc["need_screen"] = !g_screenSynced;   // true = 必须先推一次 w/h，别用记忆值
    if (g_replyRot >= 0) {
        doc["rot"] = g_replyRot;
        doc["px"] = g_replyPx;
        doc["py"] = g_replyPy;
        if (g_replyClipped) doc["clipped"] = true;
    }
    g_replyRot = -1;
    g_replyClipped = false;
    String out;
    serializeJson(doc, out);
    LOGB(out);                                    // CH343 → 树莓派
    if (Serial) Serial.println(out);                          // 原生 USB(OTG) → 手机
    if (g_replySink) *g_replySink = out;                      // HTTP → 插件
    if (txChar) {
        // 不再用 linkConnected 当门闩：它可能在重连后没置位，而回包照样该试一发。
        bool sent = notifyRetry(txChar, (const uint8_t *)out.c_str(), out.length());
        if (!sent) LOGB("[ble] reply notify FAILED (nobody subscribed?)");
    }
}

// ---------------- 命令解析 ----------------
// 解析命令里的一个点：优先 u/v（0..1 逻辑坐标），否则 x/y（面板像素）
void resolvePoint(JsonDocument &doc, const char *uk, const char *vk,
                  const char *xk, const char *yk, uint16_t &px, uint16_t &py) {
    if (!doc[uk].isNull() && !doc[vk].isNull()) {
        float u = doc[uk] | 0.0f;
        float v = doc[vk] | 0.0f;
        logicalToPanel(u, v, px, py);
        return;
    }
    px = (uint16_t)(doc[xk] | 0);
    py = (uint16_t)(doc[yk] | 0);
}

void handleCommand(const String &line) {
    JsonDocument doc;
    if (deserializeJson(doc, line) || !doc.is<JsonObject>()) {
        JsonDocument r; reply(r, false, nullptr, "invalid_json"); return;
    }
    String t = doc["t"] | "";
    JsonDocument r;

    static const char *ALLOWED[] = {"ping", "screen", "tap", "long", "swipe", "up", "release", "leave", "text",
                                    "key", "wait", "paste", "copy", "cut", "selectall", "enter", "akey",
                                    "wifi", "wifi_status", "wifi_clear", "ble_clear_bonds"};
    bool allowed = false;
    for (const char *a : ALLOWED) if (t == a) { allowed = true; break; }
    if (!allowed) { reply(r, false, t.c_str(), "op_not_allowed"); return; }
    if (!rateOk() && t != "ping") { reply(r, false, t.c_str(), "rate_limited"); return; }

    if (t == "ping") { reply(r, true, "ping"); return; }

    // 清掉板子侧的所有 bond（手机侧请同步「取消保存」再重新配对）。
    // 为什么要它：手机删了绑定、板子还留着旧 key 时，重连会立刻被 ATT
    // 「Insufficient Authentication(517)」打断 —— 表现为连上就断、回包全丢。
    if (t == "ble_clear_bonds") {
        reply(r, true, "ble_clear_bonds");     // 先回，免得调用方干等（马上要断链）
        delay(120);
        NimBLEDevice::deleteAllBonds();
        LOGB("[ble] all bonds erased, re-advertising");
        if (Serial) Serial.println("[ble] all bonds erased");
        NimBLEDevice::getAdvertising()->start();
        return;
    }

    // ---- Wi-Fi 配置（只在串口/USB 上写才安全；HTTP 需要 token）----
    if (t == "wifi") {
        wifilink::saveConfig(doc["ssid"] | "", doc["pass"] | "", doc["token"] | "");
        r["t"] = "wifi";
        r["ssid"] = String(doc["ssid"] | "");
        r["saved"] = true;
        reply(r, true, "wifi");
        return;
    }
    if (t == "wifi_status") {
        String st = wifilink::statusJson();          // 已是完整 JSON
        LOGB(st);
        if (Serial) Serial.println(st);
        if (g_replySink) *g_replySink = st;
        return;
    }
    if (t == "wifi_clear") {
        wifilink::clearConfig();
        reply(r, true, "wifi_clear");
        return;
    }

    if (t == "screen") {
        if (!doc["w"].isNull()) PANEL_W = (uint16_t)(doc["w"] | PANEL_W);
        if (!doc["h"].isNull()) PANEL_H = (uint16_t)(doc["h"] | PANEL_H);
        if (PANEL_W > PANEL_H) { uint16_t tmp = PANEL_W; PANEL_W = PANEL_H; PANEL_H = tmp; }  // 统一成竖屏原生（宽<高）
        if (!doc["rot"].isNull()) ROT = (uint8_t)(doc["rot"] | 0) & 3;
        if (!doc["den"].isNull()) DEN = (uint16_t)(doc["den"] | 0);
        if (!doc["sq"].isNull()) AXES = (doc["sq"] | 0) ? 1 : 0;   // 方形量程兼容开关
        if (!doc["mode"].isNull()) {
            String m = doc["mode"] | "mouse";
            MODE = (m == "touch") ? 1 : 0;                          // 默认鼠标
        }
        g_screenSynced = (PANEL_W > 100 && PANEL_H > 100);
        screenSave();                    // 落 NVS：掉电/重启后坐标依然正确
        reply(r, true, "screen");
        LOGF("screen=%ux%u rot=%u den=%u axes=%s logical=%ux%u scale=%ux%u\n",
                       PANEL_W, PANEL_H, ROT, denom(), AXES ? "square" : "split",
                       logicalW(), logicalH(), denX(), denY());
        return;
    }

    if (t == "up" || t == "release") {
        const bool was = touchIsDown();
        bool ok;
        if (MODE == 0) ok = mouseRaw(g_tipX, g_tipY, 0x00);   // 鼠标模式：松开左键
        else           ok = touchUp();
        g_replyRot = ROT; g_replyPx = g_tipX; g_replyPy = g_tipY;
        g_replyClipped = !ok;
        LOGF("[touch] %s was_down=%d ok=%d drops=%u\n", t.c_str(), was, ok, g_tipDrops);
        reply(r, true, t.c_str());
        return;
    }

    if (t == "leave") {                          // 急救：强制笔出界，解除悬停对手指的压制
        g_tip = false;
        const bool ok = (MODE == 0) ? mouseRaw(g_tipX, g_tipY, 0x00)
                                    : touchRawOOR(g_tipX, g_tipY);
        LOGF("[touch] leave ok=%d mode=%s\n", ok, MODE == 0 ? "mouse" : "touch");
        g_replyRot = ROT; g_replyPx = g_tipX; g_replyPy = g_tipY;
        reply(r, ok, "leave", ok ? nullptr : "notify_failed");
        return;
    }

    if (t == "tap" || t == "long") {
        if (!linkUp()) { reply(r, false, t.c_str(), "no_hid"); return; }
        if (touchIsDown()) touchUp();          // 上一笔没收尾，先补一次抬起
        uint16_t px = 0, py = 0;
        resolvePoint(doc, "u", "v", "x", "y", px, py);
        const uint16_t holdMs = (uint16_t)(doc["ms"] | (t == "long" ? 800 : 60));
        if (touchSub) {
            doTap(px, py, holdMs);               // 有触摸通道就走触摸（本版目标）
        } else if (mouseSub) {
            doTapMouse(px, py, holdMs);          // 退化到鼠标
        } else {
            reply(r, false, t.c_str(), "no_touch_sub"); return;
        }
        delay(120);            // 同上：点按也是连发多帧
        g_replyRot = ROT; g_replyPx = px; g_replyPy = py; g_replyClipped = lastClipped;
        reply(r, true, t.c_str());
        return;
    }

    if (t == "swipe") {
        if (!linkUp()) { reply(r, false, "swipe", "no_hid"); return; }
        if (touchIsDown()) touchUp();          // 同上
        uint16_t ax = 0, ay = 0, bx = 0, by = 0;
        resolvePoint(doc, "u1", "v1", "x1", "y1", ax, ay);
        resolvePoint(doc, "u2", "v2", "x2", "y2", bx, by);
        const uint16_t swMs = (uint16_t)(doc["ms"] | 300);
        if (touchSub) {
            doSwipe(ax, ay, bx, by, swMs);
        } else if (mouseSub) {
            doSwipeMouse(ax, ay, bx, by, swMs);
        } else {
            reply(r, false, "swipe", "no_touch_sub"); return;
        }
        delay(200);            // 手势帧刚灌满 ATT 队列，等它排空再回包
        g_replyRot = ROT; g_replyPx = ax; g_replyPy = ay; g_replyClipped = lastClipped;
        reply(r, true, "swipe");
        return;
    }

    if (t == "text") {
        if (!kbdReady()) { reply(r, false, "text", "no_kbd"); return; }
        String s = doc["s"] | "";
        if (!textAllowed(s)) { reply(r, false, "text", "charset_rejected"); return; }
        doText(s);
        reply(r, true, "text");
        return;
    }

    if (t == "key") {
        if (!kbdReady()) { reply(r, false, "key", "no_kbd"); return; }
        String k = doc["k"] | "";
        uint8_t mods = parseMods(doc["mods"] | "");
        if (k.length() == 1) doChar(k[0], mods); else doKey(k, mods);
        reply(r, true, "key");
        return;
    }

    if (t == "akey") {
        uint16_t u = consumerUsage(doc["k"] | "");
        if (!u) { reply(r, false, "akey", "unknown_key"); return; }
        if (!consSub) { reply(r, false, "akey", "no_consumer_sub"); return; }
        consumerKey(u);
        reply(r, true, "akey");
        return;
    }

    if (t == "paste")     { if (!kbdReady()) { reply(r, false, "paste", "no_kbd"); return; } doChar('v', 0x01); reply(r, true, "paste"); return; }
    if (t == "copy")      { if (!kbdReady()) { reply(r, false, "copy", "no_kbd"); return; } doChar('c', 0x01); reply(r, true, "copy"); return; }
    if (t == "cut")       { if (!kbdReady()) { reply(r, false, "cut", "no_kbd"); return; } doChar('x', 0x01); reply(r, true, "cut"); return; }
    if (t == "selectall") { if (!kbdReady()) { reply(r, false, "selectall", "no_kbd"); return; } doChar('a', 0x01); reply(r, true, "selectall"); return; }
    if (t == "enter")     { if (!kbdReady()) { reply(r, false, "enter", "no_kbd"); return; } doKey("enter"); reply(r, true, "enter"); return; }
    if (t == "wait")      { delay(doc["ms"] | 100); reply(r, true, "wait"); return; }

    reply(r, false, t.c_str(), "unknown_command");
}

void feed(String &buf, char c, size_t limit = 1024) {
    if (c == '\n') {
        if (buf.endsWith("\r")) buf.remove(buf.length() - 1);
        if (!buf.isEmpty()) handleCommand(buf);
        buf = "";
    } else if (buf.length() < limit) buf += c;
    else buf = "";
}

// ---------------- BLE 回调 ----------------
class ServerCB : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer *s, NimBLEConnInfo &info) override {
        linkConnected = true;
        // 请求 7.5~15ms 连接间隔（NimBLE 单位 1.25ms）
        s->updateConnParams(info.getConnHandle(), 6, 12, 0, 400);
        LOGB("[ble] connected (7.5~15ms)");
        // 关键：连接后继续广播，允许第二个中心（树莓派）同时接入发命令。
        // 否则手机一连上就停止广播 → Pi 扫不到、无法下发命令（实测撞到）。
        NimBLEDevice::startAdvertising();
    }
    void onDisconnect(NimBLEServer *s, NimBLEConnInfo &info, int reason) override {
        linkConnected = false;
        // 关掉这一行之前踩过的坑：重连时「旧连接」的 onDisconnect 会晚到，
        // 它无条件把 kbdSub/touchSub 抹成 0，而新连接其实已经订阅好了 ——
        // 表现就是 kbd:0 touch:0 但 cons:1 mouse:1，点按退化成鼠标/无效。
        // 只有确认一条连接都不剩，才清订阅标志。
        if (!linkUp()) { kbdSub = touchSub = consSub = mouseSub = false; txSub = false; }
        // 设备都掉了，Android 侧会自行取消触摸；这里同步清状态，免得看门狗空转。
        if (touchIsDown()) {
            LOGF("[touch] link lost while pressed (drops=%u) -> 手机端需锁屏解锁清幽灵手指\n", g_tipDrops);
            g_tip = false;
        }
        LOGF("[ble] disconnected reason=%d, re-advertising\n", reason);
        NimBLEDevice::startAdvertising();
    }
};

class RepCB : public NimBLECharacteristicCallbacks {
    void onSubscribe(NimBLECharacteristic *c, NimBLEConnInfo &info, uint16_t subValue) override {
        if (c == kbdIn) kbdSub = (subValue > 0);
        if (c == touchIn) {
            touchSub = (subValue > 0);
            // 刚订阅（含重连）时先补一发抬起：清掉上一轮可能残留的按下状态。
            if (touchSub) { g_tip = false; touchRaw(0, 0, false); }
        }
        if (c == consIn) consSub = (subValue > 0);
        if (c == mouseIn) mouseSub = (subValue > 0);
        if (c == txChar) txSub = (subValue > 0);
        LOGF("[ble] subscribe %s -> %d\n",
                       c == kbdIn ? "kbd" : (c == touchIn ? "touch"
                       : (c == consIn ? "consumer" : (c == mouseIn ? "mouse" : "?"))), subValue);
    }
};

class RxCB : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
        NimBLEAttValue v = c->getValue();
        const char *p = v.c_str();
        for (size_t i = 0; i < v.length(); ++i) feed(bleLine, p[i]);
        if (!bleLine.isEmpty()) { handleCommand(bleLine); bleLine = ""; }
    }
};

// ---------------- setup / loop ----------------
// 日志串口引脚随芯片走：S3 是 44/43（板载 CH343），C3 是 UART0 默认 20/21
#if defined(CONFIG_IDF_TARGET_ESP32C3)
#define LOG_RX 20
#define LOG_TX 21
#else
#define LOG_RX 44
#define LOG_TX 43
#endif

void setup() {
    logPort.begin(115200, SERIAL_8N1, LOG_RX, LOG_TX);
    delay(200);
    LOGB();
    LOGF("=== hid_ble_nimble %s ===\n", FW_VERSION);
#if defined(CONFIG_IDF_TARGET_ESP32C3)
    LOGF("[sys] target=ESP32-C3  flash=%uMB  free=%uKB\n",
                   (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)), (unsigned)(ESP.getFreeHeap() / 1024));
#else
    LOGF("[sys] target=ESP32-S3  flash=%uMB  free=%uKB\n",
                   (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)), (unsigned)(ESP.getFreeHeap() / 1024));
#endif
    screenLoad();                     // 先恢复上次登记的屏幕，再开 BLE
    serialLine.reserve(1024);
    bleLine.reserve(1024);
    usbLine.reserve(1024);

    // 原生 USB(OTG) 作为第二个命令通道（手机 OTG 直连时用）。
    // 注意：UART0 仍由 logPort 独立占用，COM 口日志不受影响。
    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);      // 主机没连时写入不阻塞
    // C3 SuperMini 没有接到树莓派的 UART，日志只能走 USB，所以横幅两边都打一份
    Serial.printf("\n=== hid_ble_nimble %s (USB/CDC) ===\n", FW_VERSION);
    Serial.printf("[sys] flash=%uMB heap=%uKB\n",
                  (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)),
                  (unsigned)(ESP.getFreeHeap() / 1024));

    wifilink::begin();          // Wi-Fi 在后台连，连不上也不挡 BLE

    NimBLEDevice::init(DEVICE_NAME);
    NimBLEDevice::setSecurityAuth(true, false, true);   // bonding + secure connections
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

    auto server = NimBLEDevice::createServer();
    server->setCallbacks(new ServerCB());

    hid = new NimBLEHIDDevice(server);
    hid->setManufacturer("Tangyuan");
    hid->setPnp(0x02, 0x303A, 0x4001, 0x0100);
    hid->setHidInfo(0, 1);
    hid->setReportMap(const_cast<uint8_t *>(REPORT_MAP), sizeof(REPORT_MAP));
    LOGB("[hid] ---- input report chars ----");
    kbdIn = hid->getInputReport(1);
#if WITH_TOUCH
    touchIn = hid->getInputReport(5);   // 单点触摸屏用 Report ID 5（2 是鼠标）
#endif
    consIn = hid->getInputReport(3);
    mouseIn = hid->getInputReport(2);
    LOGF("[hid] kbd=%p touch=%p cons=%p mouse=%p mode=%u (touch==mouse? %s)\n",
                   (void *)kbdIn, (void *)touchIn, (void *)consIn, (void *)mouseIn, MODE,
                   (touchIn == mouseIn) ? "YES!!" : "no");
    kbdIn->setCallbacks(new RepCB());
#if WITH_TOUCH
    touchIn->setCallbacks(new RepCB());
#endif
    consIn->setCallbacks(new RepCB());
    mouseIn->setCallbacks(new RepCB());

    // 自定义命令服务（命令下行 + 结果上行）
    auto svc = server->createService(SVC_UUID);
    rxChar = svc->createCharacteristic(RX_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    txChar = svc->createCharacteristic(TX_UUID, NIMBLE_PROPERTY::NOTIFY);
    rxChar->setCallbacks(new RxCB());

    server->start();

    auto adv = NimBLEDevice::getAdvertising();
    adv->setAppearance(HID_KEYBOARD);
    adv->addServiceUUID(hid->getHidService()->getUUID());
    adv->setName(DEVICE_NAME);
    adv->enableScanResponse(true);
    NimBLEDevice::startAdvertising();

    hid->setBatteryLevel(100);
    kbdReport(0, 0);
    touchUp();
    LOGB("ready: BLE advertising (NimBLE)");
    LOGF("screen default %ux%u rot=%u den=%u\n", PANEL_W, PANEL_H, ROT, denom());

}

void loop() {
    for (int n = 0; n < 128 && logPort.available(); ++n) feed(serialLine, logPort.read());
    for (int n = 0; n < 128 && Serial.available(); ++n) feed(usbLine, Serial.read());
    wifilink::loop();
    // 看门狗：手指按下超过 6s 还没抬起 → 一定有事件丢了，强制收尾。
    // 没有这道保险，丢一次 UP 就会让手机所有手势失效（只能锁屏解锁救）。
    if (touchIsDown() && (millis() - g_tipSince) > TIP_WATCHDOG_MS) {
        LOGF("[touch] WATCHDOG release (held %lums, drops=%u)\n",
                       (unsigned long)(millis() - g_tipSince), g_tipDrops);
        touchUp();
    }
    delay(2);
}
