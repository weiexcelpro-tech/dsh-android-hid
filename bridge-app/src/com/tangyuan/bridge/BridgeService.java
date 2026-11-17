package com.tangyuan.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 前台服务：BLE ↔ 本机 HTTP 桥。
 *
 * 插件（跑在 proot 里）看不到安卓蓝牙栈，但能看到 127.0.0.1，
 * 所以由这个服务替它握住 GATT 连接。
 *
 * 对外 HTTP 路由刻意和 ESP32 固件（wifi_link.h）保持一致：
 *   /health  /device  /status  /screen  /scan  /cmd  /reconnect
 * 插件只要把 base URL 从 http://<板子IP>:8892 换成 http://127.0.0.1:8893，其余代码不动。
 */
public class BridgeService extends Service {

    private static final String TAG = "TYBridge";
    private static final String CH_ID = "tangyuan_bridge";
    private static final int NOTI_ID = 8901;

    public static final String ACTION_START = "com.tangyuan.bridge.START";
    public static final String ACTION_STOP  = "com.tangyuan.bridge.STOP";
    /** 用户是否希望桥在跑（false = 主动停的，复活 Job 不要擅自拉起） */
    public static final String PREF_SHOULD_RUN = "should_run";
    public static final String ACTION_RECONNECT = "com.tangyuan.bridge.RECONNECT";

    // 给 UI 读的状态
    public static volatile String state = "init";
    public static volatile String detail = "";
    public static volatile String lastLog = "";
    public static volatile boolean serviceRunning = false;

    private BleClient ble;
    private HttpServer http;
    private Watchdog wd;

    private final ArrayBlockingQueue<String> replies = new ArrayBlockingQueue<>(8);

    private int lastW = 1080, lastH = 2340, lastRot = 0;
    private boolean screenKnown = false;

    // 固件每条回包都带 tip / need_screen，缓存最后一次真值（null = 还没问过，别瞎猜）
    private volatile Boolean lastTip = null;
    private volatile Boolean lastNeedScreen = null;

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        ReviveJob.schedule(this);   // 15 分钟一次的复活闹钟，Job 自己会防重入
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            getSharedPreferences("bridge", Context.MODE_PRIVATE).edit()
                    .putBoolean(PREF_SHOULD_RUN, false).apply();
            shutdown();
            stopForeground(true);
            stopSelf();
            serviceRunning = false;
            state = "stopped";
            return START_NOT_STICKY;
        }

        startForegroundCompat();
        getSharedPreferences("bridge", Context.MODE_PRIVATE).edit()
                .putBoolean(PREF_SHOULD_RUN, true).apply();

        if (ble == null) {
            // 恢复上次登记的屏幕参数
            SharedPreferences sp = getSharedPreferences("bridge", Context.MODE_PRIVATE);
            lastW = sp.getInt("w", 1080);
            lastH = sp.getInt("h", 2340);
            lastRot = sp.getInt("rot", 0);
            screenKnown = sp.getBoolean("screenKnown", false);

            ble = new BleClient(this, new BleClient.Listener() {
                @Override public void onState(String s, String d) {
                    state = s;
                    detail = d;
                    log("state=" + s + " " + d);
                    updateNotification();
                }
                @Override public void onLine(String json) {
                    log("<- " + json);
                    rememberFlags(json);
                    replies.offer(json);
                }
            });

            http = new HttpServer(new Gateway());
            http.start();
            ble.start();
            // 看门狗：盯住无障碍开关，被系统关掉就补回来
            if (wd == null) {
                wd = new Watchdog(this);
                wd.start();
            }
        } else if (ACTION_RECONNECT.equals(action)) {
            // 用户/插件主动要求重连：先断再连，不用等退避
            ble.stop();
            ble.start();
        }
        return START_STICKY;
    }

    /** 从固件回包里记住 tip / need_screen（两条都是「状态类」字段，必须取真值）。 */
    private void rememberFlags(String json) {
        if (json == null) return;
        if (json.contains("\"tip\":true")) lastTip = Boolean.TRUE;
        else if (json.contains("\"tip\":false")) lastTip = Boolean.FALSE;
        if (json.contains("\"need_screen\":true")) lastNeedScreen = Boolean.TRUE;
        else if (json.contains("\"need_screen\":false")) lastNeedScreen = Boolean.FALSE;
    }

    // ---------------- HTTP 网关 ----------------

    private class Gateway implements HttpServer.Handler {
        @Override public boolean send(String json) {
            replies.clear();                 // 丢掉上一条的迟到回复
            boolean ok = ble != null && ble.send(json);
            log("-> " + json + "  (" + (ok ? "ok" : "fail") + ")");
            return ok;
        }
        @Override public String waitReply(long timeoutMs) {
            try {
                return replies.poll(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                return null;
            }
        }
        @Override public String healthJson() {
            boolean ready = ble != null && ble.isReady();
            StringBuilder sb = new StringBuilder(320);
            sb.append("{\"ok\":true,\"svc\":\"tangyuan-hid\",\"proto\":1,\"transport\":\"app\",")
              .append("\"ble\":").append(ready).append(',')
              .append("\"state\":\"").append(esc(state)).append("\",")
              .append("\"tip\":").append(lastTip == null ? "null" : lastTip.toString()).append(',')
              .append("\"need_screen\":").append(needScreenJson()).append(',')
              .append("\"cap\":").append(CapService.ready()).append(',')
              .append("\"watch\":").append(wd == null ? "null" : wd.shortJson()).append(',')
              .append("\"screen\":{\"known\":").append(screenKnown)
              .append(",\"w\":").append(lastW).append(",\"h\":").append(lastH)
              .append(",\"rot\":").append(lastRot).append("},")
              .append("\"info\":\"TangyuanBridge ").append(BuildConfig.VERSION_NAME)
              .append(" · BLE ").append(state);
            if (ble != null && !ble.deviceMac().isEmpty()) {
                sb.append(" · ").append(esc(ble.deviceMac()));
            }
            sb.append(" mtu=").append(ble != null ? ble.mtu() : 0).append("\"}");
            return sb.toString();
        }
        @Override public String deviceJson() {
            boolean ready = ble != null && ble.isReady();
            return "{\"ok\":true,\"svc\":\"tangyuan-hid\",\"proto\":1,\"app\":\"tangyuan-bridge\","
                    + "\"transport\":\"app\","
                    + "\"id\":\"" + (ble == null || ble.deviceMac().isEmpty() ? "unknown" : ble.deviceMac()) + "\","
                    + "\"name\":\"" + esc(ble == null ? "" : ble.deviceName()) + "\","
                    + "\"fw\":\"bridge-" + BuildConfig.VERSION_NAME + "\","
                    + "\"mac\":\"" + (ble == null ? "" : ble.deviceMac()) + "\","
                    + "\"ip\":\"127.0.0.1\",\"port\":" + HttpServer.PORT + ","
                    + "\"ble\":" + ready + ",\"auth\":false,"
                    + "\"rssi\":" + (ble == null ? 0 : ble.rssi()) + ",\"mtu\":" + (ble == null ? 0 : ble.mtu()) + "}";
        }
        @Override public String statusJson() {
            return "{\"ok\":true,\"t\":\"bridge_status\",\"state\":\"" + esc(state) + "\","
                    + "\"detail\":\"" + esc(detail) + "\",\"ready\":" + (ble != null && ble.isReady()) + ","
                    + "\"mac\":\"" + (ble == null ? "" : ble.deviceMac()) + "\","
                    + "\"mtu\":" + (ble == null ? 0 : ble.mtu()) + "," 
                    + "\"rssi\":" + (ble == null ? 0 : ble.rssi()) + "}";
        }
        @Override public String scanJson() {
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"devices\":[");
            BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter a = bm != null ? bm.getAdapter() : null;
            boolean first = true;
            if (a != null) {
                Set<BluetoothDevice> bonded = a.getBondedDevices();
                if (bonded != null) {
                    for (BluetoothDevice d : bonded) {
                        String n = d.getName();
                        if (n == null || !n.startsWith(BleClient.NAME_PREFIX)) continue;
                        if (!first) sb.append(',');
                        first = false;
                        sb.append("{\"name\":\"").append(esc(n)).append("\",\"mac\":\"")
                                .append(d.getAddress()).append("\",\"bonded\":true}");
                    }
                }
            }
            sb.append("]}");
            return sb.toString();
        }
        @Override public String screenJson() {
            return "{\"ok\":true,\"known\":" + screenKnown + ",\"w\":" + lastW
                    + ",\"h\":" + lastH + ",\"rot\":" + lastRot
                    + ",\"pw\":" + Math.min(lastW, lastH) + ",\"ph\":" + Math.max(lastW, lastH)
                    + ",\"den\":" + Math.max(lastW, lastH) + "}";
        }
        @Override public String setScreen(int w, int h, int rot) {
            String cmd = "{\"t\":\"screen\",\"w\":" + w + ",\"h\":" + h + ",\"rot\":" + rot + "}";
            replies.clear();
            boolean ok = ble != null && ble.send(cmd);
            String r = null;
            if (ok) {
                try { r = replies.poll(3000, TimeUnit.MILLISECONDS); }
                catch (InterruptedException ignored) { }
            }
            if (ok) {
                lastW = w; lastH = h; lastRot = rot; screenKnown = true;
                getSharedPreferences("bridge", Context.MODE_PRIVATE).edit()
                        .putInt("w", w).putInt("h", h).putInt("rot", rot)
                        .putBoolean("screenKnown", true).apply();
            }
            return r != null ? r : "{\"ok\":false,\"err\":\"ble_not_ready\"}";
        }
        @Override public String reconnectJson() {
            if (ble == null) return "{\"ok\":false,\"err\":\"service_not_started\"}";
            ble.stop();
            ble.start();
            return "{\"ok\":true,\"t\":\"reconnect\",\"state\":\"" + esc(state) + "\"}";
        }
        // ---- 感知层 ----
        @Override public byte[] screenshotJpeg(int quality) {
            CapService cap = CapService.get();
            return cap == null ? null : cap.screenshotJpeg(quality);
        }
        @Override public String a11yJson(boolean enable, boolean tree, int maxNodes) {
            CapService cap = CapService.get();
            if (cap == null) {
                if (enable) CapService.openSettings(BridgeService.this);
                return "{\"ok\":false,\"known\":true,\"ours_enabled\":false,\"system_enabled\":false,"
                        + "\"need_user\":" + enable + ","
                        + "\"err\":\"cap_off\","
                        + "\"detail\":\"无障碍服务没开。设置 › 无障碍 › 已下载的服务 › 汤圆蓝牙桥/汤圆屏幕读取 打开开关\"}";
            }
            if (!tree) {
                return "{\"ok\":true,\"known\":true,\"ours_enabled\":true,\"system_enabled\":true,"
                        + "\"need_user\":false,\"service\":\"com.tangyuan.bridge/.CapService\","
                        + "\"detail\":\"无障碍已开启（截图 + 控件树可用）\"}";
            }
            return cap.treeJson(maxNodes);
        }
        // ---- 看门狗 ----
        @Override public String watch(java.util.Map<String, String> q) {
            if (wd == null) return "{\"ok\":false,\"err\":\"not_started\"}";
            String op = q.getOrDefault("op", "status");
            String arg = q.getOrDefault("arg", "");
            try {
                switch (op) {
                    case "on":  wd.setEnabled(true); break;
                    case "off": wd.setEnabled(false); break;
                    case "fix": return wd.checkNow("manual").toString();
                    case "probe": return wd.probePackage(arg).toString();
                    case "stopself": {
                        // 仅供测试：自愿停服务（不走 force-stop），验证复活 Job 这条链路
                        new Thread(() -> {
                            try { Thread.sleep(400); } catch (InterruptedException ignored) { }
                            shutdown();
                            stopForeground(true);
                            stopSelf();
                        }).start();
                        return "{\"ok\":true,\"action\":\"stopping\"}";
                    }
                    case "revive": {
                        // 给外部（插件/用户）一个把桥服务叫回来的入口
                        Intent i = new Intent(BridgeService.this, BridgeService.class)
                                .setAction(ACTION_START);
                        startForegroundService(i);
                        return "{\"ok\":true,\"action\":\"start_requested\"}";
                    }
                    case "add": if (!arg.isEmpty()) wd.addTarget(arg); break;
                    case "del": if (!arg.isEmpty()) wd.removeTarget(arg); break;
                    default: break;
                }
            } catch (Throwable t) {
                return "{\"ok\":false,\"err\":\"" + esc(String.valueOf(t)) + "\"}";
            }
            return wd.statusJson();
        }
        @Override public void log(String s) { BridgeService.this.log(s); }
    }

    private String needScreenJson() {
        if (lastNeedScreen != null) return lastNeedScreen.toString();
        // 没问过固件时，用「本地有没有登记过」保守判断：没登记过就当需要登记
        return String.valueOf(!screenKnown);
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    // ---------------- 通知 ----------------

    private void startForegroundCompat() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH_ID, "ESP32 蓝牙桥",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("保持与 ESP32 的 BLE 连接");
            nm.createNotificationChannel(ch);
        }
        Notification n = buildNotification("正在连接…");
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTI_ID, n);
        }
    }

    private Notification buildNotification(String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        b.setContentTitle("汤圆蓝牙桥")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true);
        return b.build();
    }

    private void updateNotification() {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.notify(NOTI_ID, buildNotification("BLE: " + state + (detail.isEmpty() ? "" : " · " + detail)));
        } catch (Exception ignored) { }
    }

    private void log(String s) {
        lastLog = s;
        Log.d(TAG, s);
    }

    private void shutdown() {
        if (wd != null) { wd.stop(); wd = null; }
        if (http != null) http.stop();
        if (ble != null) ble.stop();
        http = null;
        ble = null;
    }

    @Override
    public void onDestroy() {
        shutdown();
        serviceRunning = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
