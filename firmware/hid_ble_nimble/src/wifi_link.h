// wifi_link.h —— 让 ESP32 从「USB 从设备」变成「局域网里的节点」
//
// 为什么要有它：OTG 线是手机给它供电 + 传命令，手机电量顶不住。
// 拆开后 BLE 继续当 HID（键鼠），命令改走 Wi-Fi：手机只出蓝牙，
// 耗电落到 ESP32 自己的充电器上。
//
// 发现机制（**不锁 MAC**，任何刷了这套固件的板子都能被认出来）：
//   · UDP 8890 广播：手机发 {"q":"whois"}，本机回一份身份 JSON
//   · 身份靠 svc 字段握手：只有回答 "tangyuan-hid" + proto 的才算自己人
//   · mDNS 兜底：<hostname>.local + _tangyuan-hid._tcp
//
// 配置存 NVS，串口/USB 一次性写入，重启不忘：
//   {"t":"wifi","ssid":"...","pass":"...","token":"..."}
//   {"t":"wifi_status"}   {"t":"wifi_clear"}
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>

#include <esp_wifi.h>

#define WIFI_DISCOVER_PORT 8890
#define WIFI_HTTP_PORT 8892
#define SVC_NAME "tangyuan-hid"
#define SVC_PROTO 1

extern String *g_replySink;              // 非空时 reply() 会把结果同步写进去（HTTP 用）
bool hidReady();                         // 定义在 main.cpp
extern HardwareSerial logPort;           // 定义在 main.cpp
void handleCommand(const String &line);  // 定义在 main.cpp

namespace wifilink {

static Preferences prefs;
static WebServer http(WIFI_HTTP_PORT);
static WiFiUDP udp;
static String cfgSsid, cfgPass, cfgToken;
static bool started = false;
static bool mdnsUp = false;
static uint32_t lastAttempt = 0;
static String lastIp;

static String chipId() {
    uint64_t mac = ESP.getEfuseMac();
    char buf[16];
    snprintf(buf, sizeof(buf), "TY-%06X", (uint32_t)(mac & 0xFFFFFF));
    return String(buf);
}

static String hostname() {
    String h = "tangyuan-";
    uint64_t mac = ESP.getEfuseMac();
    char buf[8];
    snprintf(buf, sizeof(buf), "%06x", (uint32_t)(mac & 0xFFFFFF));
    h += buf;
    return h;
}

static String macStr() {
    uint8_t m[6];
    WiFi.macAddress(m);
    char buf[18];
    snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
             m[0], m[1], m[2], m[3], m[4], m[5]);
    return String(buf);
}

static bool authorized() {
    if (cfgToken.length() == 0) return true;   // 没设口令就不校验（方便首次调试）
    if (!http.hasArg("token")) return false;
    return http.arg("token") == cfgToken;
}

// ---------------- 身份描述 ----------------
static String identityJson() {
    JsonDocument d;
    d["ok"] = true;
    d["svc"] = SVC_NAME;
    d["proto"] = SVC_PROTO;
    d["id"] = chipId();
    d["name"] = WiFi.getHostname() ? WiFi.getHostname() : hostname().c_str();
    d["fw"] = FW_VERSION;
    d["mac"] = macStr();
    d["ip"] = WiFi.localIP().toString();
    d["port"] = WIFI_HTTP_PORT;
    d["ble"] = hidReady();
    d["auth"] = cfgToken.length() > 0;
    d["rssi"] = WiFi.RSSI();
    String out;
    serializeJson(d, out);
    return out;
}

// ---------------- HTTP ----------------
static void httpHealth() {
    JsonDocument d;
    d["ok"] = true;
    d["svc"] = SVC_NAME;
    d["proto"] = SVC_PROTO;
    d["info"] = String("wifi ssid=") + WiFi.SSID() + " rssi=" + String(WiFi.RSSI()) +
                " fw=" + FW_VERSION;
    String out;
    serializeJson(d, out);
    http.send(200, "application/json", out);
}

static void httpDevice() {
    String out = identityJson();       // ble 字段由 loop 里补，这里给当前值
    http.send(200, "application/json", out);
}

static void httpCmd() {
    if (!authorized()) { http.send(401, "application/json", "{\"ok\":false,\"err\":\"bad_token\"}"); return; }
    String j = http.hasArg("j") ? http.arg("j") : "";
    if (!j.length()) { http.send(400, "application/json", "{\"ok\":false,\"err\":\"missing_j\"}"); return; }
    String sink;
    g_replySink = &sink;
    handleCommand(j);
    g_replySink = nullptr;
    http.send(200, "application/json", sink.length() ? sink : "{\"ok\":false,\"err\":\"no_reply\"}");
}

static void httpScreen() {
    if (http.hasArg("w") && http.hasArg("h")) {
        JsonDocument d;
        d["t"] = "screen";
        d["w"] = http.arg("w").toInt();
        d["h"] = http.arg("h").toInt();
        d["rot"] = http.hasArg("rot") ? http.arg("rot").toInt() : 0;
        String cmd, sink;
        serializeJson(d, cmd);
        g_replySink = &sink;
        handleCommand(cmd);
        g_replySink = nullptr;
        http.send(200, "application/json", sink.length() ? sink : "{\"ok\":false}");
        return;
    }
    // 回当前登记状态，插件据此判断要不要重新登记（方向变了就得改 rot）
    JsonDocument d;
    d["ok"] = true;
    d["known"] = true;
    d["w"] = logicalW();
    d["h"] = logicalH();
    d["rot"] = ROT;
    d["den"] = denom();
    String out;
    serializeJson(d, out);
    http.send(200, "application/json", out);
}

static void httpNotFound() {
    http.send(404, "application/json", "{\"ok\":false,\"err\":\"not_found\"}");
}

// ---------------- UDP 发现 ----------------
static void pollDiscovery() {
    int sz = udp.parsePacket();
    if (sz <= 0) return;
    char buf[192] = {0};
    int n = udp.read(buf, sizeof(buf) - 1);
    if (n <= 0) return;
    buf[n] = 0;

    // 认「问是谁」，回身份；别的都忽略
    bool whois = strstr(buf, "whois") != nullptr || strstr(buf, SVC_NAME) != nullptr;
    if (!whois) return;

    String out = identityJson();
    udp.beginPacket(udp.remoteIP(), udp.remotePort());
    udp.write((const uint8_t *)out.c_str(), out.length());
    udp.endPacket();
    logPort.printf("[wifi] whois from %s -> replied\n", udp.remoteIP().toString().c_str());
}

// ---------------- 连接管理 ----------------
static void startServices() {
    if (started) return;
    started = true;

    http.on("/health", HTTP_GET, httpHealth);
    http.on("/device", HTTP_GET, httpDevice);
    http.on("/cmd", HTTP_GET, httpCmd);
    http.on("/cmd", HTTP_POST, httpCmd);
    http.on("/screen", HTTP_GET, httpScreen);
    http.onNotFound(httpNotFound);
    http.begin();
    udp.begin(WIFI_DISCOVER_PORT);

    String h = hostname();
    WiFi.setHostname(h.c_str());
    if (MDNS.begin(h.c_str())) {
        MDNS.addService("tangyuan-hid", "tcp", WIFI_HTTP_PORT);
        mdnsUp = true;
    }
    logPort.printf("[wifi] up: http://%s:%d/  id=%s  mdns=%s.local\n",
                   WiFi.localIP().toString().c_str(), WIFI_HTTP_PORT,
                   chipId().c_str(), h.c_str());
}

static void tryConnect() {
    if (!cfgSsid.length()) {
        if (started == false && millis() - lastAttempt > 5000) {
            lastAttempt = millis();
            logPort.println("[wifi] 未配置 Wi-Fi：串口发 {\"t\":\"wifi\",\"ssid\":..,\"pass\":..}");
        }
        return;
    }
    if (WiFi.status() == WL_CONNECTED) {
        if (!started) startServices();
        return;
    }
    if (started && WiFi.status() != WL_CONNECTED) {   // 掉线 → 等重连，服务保持
        return;
    }
    if (millis() - lastAttempt < 8000) return;
    lastAttempt = millis();
    logPort.printf("[wifi] connecting to %s ...\n", cfgSsid.c_str());
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(true);                       // 省电：调制解调器睡眠
    WiFi.setAutoReconnect(true);
    WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
}

inline void loadConfig() {
    prefs.begin("tangyuan", true);
    cfgSsid = prefs.getString("ssid", "");
    cfgPass = prefs.getString("pass", "");
    cfgToken = prefs.getString("token", "");
    prefs.end();
}

inline void begin() {
    loadConfig();
    tryConnect();
}

inline void loop() {
    tryConnect();
    if (WiFi.status() == WL_CONNECTED) {
        if (!started) startServices();
        http.handleClient();
        pollDiscovery();
        lastIp = WiFi.localIP().toString();
    }
    delay(0);
}

// ---------------- 串口配置命令 ----------------
inline void saveConfig(const String &ssid, const String &pass, const String &token) {
    prefs.begin("tangyuan", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    prefs.putString("token", token);
    prefs.end();
    cfgSsid = ssid;
    cfgPass = pass;
    cfgToken = token;
    started = false;
    WiFi.disconnect(true);
    lastAttempt = 0;
}

inline void clearConfig() {
    prefs.begin("tangyuan", false);
    prefs.clear();
    prefs.end();
    cfgSsid = cfgPass = cfgToken = "";
    WiFi.disconnect(true);
    started = false;
}

inline String statusJson() {
    JsonDocument d;
    d["ok"] = true;
    d["t"] = "wifi_status";
    d["configured"] = cfgSsid.length() > 0;
    d["connected"] = WiFi.status() == WL_CONNECTED;
    d["ssid"] = cfgSsid;
    d["ip"] = WiFi.localIP().toString();
    d["rssi"] = WiFi.RSSI();
    d["id"] = chipId();
    d["token"] = cfgToken.length() > 0;
    d["port"] = WIFI_HTTP_PORT;
    d["svc"] = SVC_NAME;
    String out;
    serializeJson(d, out);
    return out;
}

}  // namespace wifilink
