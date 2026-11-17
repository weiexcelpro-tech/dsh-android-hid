package com.tangyuan.bridge;

import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 本机 HTTP 桥：127.0.0.1:8893
 *
 * 路由**刻意和 ESP32 的 wifi_link.h 一模一样**（/health /device /cmd /screen + 404），
 * 这样插件只要把 base URL 从 http://<板子IP>:8892 换成 http://127.0.0.1:8893，
 * 其余代码一行都不用改。
 */
public class HttpServer {

    private static final String TAG = "TYHttp";
    public static final int PORT = 8893;

    public interface Handler {
        boolean send(String json);
        String waitReply(long timeoutMs);
        String healthJson();
        String deviceJson();
        String statusJson();
        String scanJson();
        String screenJson();
        String setScreen(int w, int h, int rot);
        String reconnectJson();
        /** a11y 截图 → JPEG；null = 无障碍服务没开或系统拒绝 */
        byte[] screenshotJpeg(int quality);
        /** 无障碍状态；tree=true 时附带前台控件树 */
        String a11yJson(boolean enable, boolean tree, int maxNodes);
        /** 无障碍看门狗：状态 / 开关 / 立刻修复 / 增删目标 */
        String watch(Map<String, String> q);
        void log(String s);
    }

    private final Handler h;
    private ServerSocket server;
    private volatile boolean running = false;
    private Thread acceptThread;

    public HttpServer(Handler h) { this.h = h; }

    public void start() {
        if (running) return;
        try {
            server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
            running = true;
        } catch (IOException e) {
            h.log("HTTP 端口绑定失败: " + e.getMessage());
            return;
        }
        acceptThread = new Thread(() -> {
            while (running) {
                try {
                    Socket s = server.accept();
                    new Thread(() -> handle(s), "ty-http-conn").start();
                } catch (IOException e) {
                    if (running) Log.w(TAG, "accept: " + e.getMessage());
                }
            }
        }, "ty-http-accept");
        acceptThread.start();
        h.log("HTTP 监听 127.0.0.1:" + PORT);
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        server = null;
    }

    // ---------------- 单个连接 ----------------

    private void handle(Socket sock) {
        try {
            sock.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();

            String reqLine = readLine(in);
            if (reqLine == null) { sock.close(); return; }
            String[] parts = reqLine.split(" ");
            if (parts.length < 2) { sock.close(); return; }
            String method = parts[0];
            String target = parts[1];

            // 读头
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(),
                        line.substring(c + 1).trim());
            }
            // 读体（POST）
            String body = "";
            String cl = headers.get("content-length");
            if (cl != null) {
                int n = Integer.parseInt(cl.trim());
                byte[] buf = new byte[Math.min(n, 65536)];
                int off = 0;
                while (off < buf.length) {
                    int r = in.read(buf, off, buf.length - off);
                    if (r < 0) break;
                    off += r;
                }
                body = new String(buf, 0, off, StandardCharsets.UTF_8);
            }

            String path = target;
            Map<String, String> q = new HashMap<>();
            int qi = target.indexOf('?');
            if (qi >= 0) {
                path = target.substring(0, qi);
                for (String kv : target.substring(qi + 1).split("&")) {
                    if (kv.isEmpty()) continue;
                    int e = kv.indexOf('=');
                    String k = e >= 0 ? kv.substring(0, e) : kv;
                    String v = e >= 0 ? kv.substring(e + 1) : "";
                    try { q.put(k, URLDecoder.decode(v, "UTF-8")); }
                    catch (Exception ex) { q.put(k, v); }
                }
            }

            String resp;
            int code = 200;

            switch (path) {
                case "/health":
                    resp = h.healthJson();
                    break;
                case "/device":
                    resp = h.deviceJson();
                    break;
                case "/status":
                    resp = h.statusJson();
                    break;
                case "/screen":
                    if (q.containsKey("w") && q.containsKey("h")) {
                        int w = parseInt(q.get("w"), 0);
                        int hh = parseInt(q.get("h"), 0);
                        int rot = parseInt(q.getOrDefault("rot", "0"), 0);
                        resp = h.setScreen(w, hh, rot);
                    } else {
                        resp = h.screenJson();
                    }
                    break;
                case "/scan":
                    resp = h.scanJson();
                    break;
                case "/reconnect":
                    resp = h.reconnectJson();
                    break;
                // ---- 感知层：截图（image/jpeg 二进制）----
                case "/shot": {
                    int qq = parseInt(q.getOrDefault("q", "80"), 80);
                    byte[] jpg = h.screenshotJpeg(qq);
                    if (jpg == null) {
                        code = 503;
                        resp = "{\"ok\":false,\"err\":\"screenshot_failed\","
                                + "\"detail\":\"无障碍服务没开，或系统拒绝（节流/安全窗口）。"
                                + "到 设置 › 无障碍 › 已下载的服务 里打开「汤圆屏幕读取」\"}";
                        break;
                    }
                    writeBytes(out, 200, "image/jpeg", jpg);
                    sock.close();
                    return;
                }
                // ---- 看门狗：/watch?op=status|on|off|fix|add|del&arg=... ----
                case "/watch":
                    resp = h.watch(q);
                    break;
                // ---- 感知层：无障碍状态（tree=1 时带前台控件树）----
                case "/a11y":
                    resp = h.a11yJson("1".equals(q.get("enable")), "1".equals(q.get("tree")),
                            parseInt(q.getOrDefault("max", "300"), 300));
                    break;
                case "/cmd": {
                    String j = q.getOrDefault("j", "");
                    if (j.isEmpty() && !body.isEmpty()) j = body.trim();
                    if (j.isEmpty()) {
                        code = 400;
                        resp = "{\"ok\":false,\"err\":\"missing_j\"}";
                        break;
                    }
                    String reply = exec(j);
                    if (reply == null) { code = 503; resp = "{\"ok\":false,\"err\":\"ble_not_ready\"}"; }
                    else if (reply.isEmpty()) { code = 504; resp = "{\"ok\":false,\"err\":\"timeout\"}"; }
                    else resp = reply;
                    break;
                }
                default:
                    code = 404;
                    resp = "{\"ok\":false,\"err\":\"not_found\"}";
            }

            writeJson(out, code, resp);
            sock.close();
        } catch (Exception e) {
            try { sock.close(); } catch (Exception ignored) { }
        }
    }

    /** 发命令 → 等回复。返回 null=链路没就绪；""=超时 */
    private String exec(String json) {
        if (!h.send(json)) return null;
        String r = h.waitReply(timeoutFor(json));
        return r == null ? "" : r;
    }

    /**
     * 按命令本身估超时：BLE 是「主机说了算」的连接间隔，打字时每个字符要等
     * 两帧（按下/松开）排空。固定 3s 会让长一点的 text 必然超时（真机踩过：
     * 打 8 个字母就 504，固件其实已经打完了）。
     */
    private static long timeoutFor(String json) {
        long extra = 0;
        String s = json.replace(" ", "");
        int i = s.indexOf("\"s\":\"");
        if (i >= 0) {
            int end = s.lastIndexOf('"');
            int len = Math.max(0, end - (i + 5));
            extra += len * 80L;          // 每字符约 75ms（15ms 按下 + 60ms 间隔）
        }
        if (s.contains("\"t\":\"swipe\"") || s.contains("\"t\":\"long\"")) {
            extra += 2000;               // 手势要逐帧发报文，实测比 text 慢一截
        }
        int m = s.indexOf("\"ms\":");
        if (m >= 0) {
            int j = m + 5, k = j;
            while (k < s.length() && Character.isDigit(s.charAt(k))) k++;
            try { extra += Long.parseLong(s.substring(j, k)); } catch (Exception ignored) { }
        }
        return 3000 + Math.min(extra, 20000);
    }

    private static int parseInt(String s, int def) {
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) break;
        }
        if (c == -1 && b.size() == 0) return null;
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void writeJson(OutputStream out, int code, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        writeBytes(out, code, "application/json; charset=utf-8", b);
    }

    /** 二进制响应（截图用）。 */
    private static void writeBytes(OutputStream out, int code, String contentType, byte[] b) throws IOException {
        String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "ERR") + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + b.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }
}
