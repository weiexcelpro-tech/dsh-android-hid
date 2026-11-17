package com.tangyuan.bridge;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;

/**
 * BLE GATT 客户端：连 ESP32 的 NUS 自定义服务，把命令写 RX、从 TX 收结果。
 *
 * 关键点：ESP32 同时是系统的 HID 设备（键盘+触摸屏），已被系统连接时它**不广播**，
 * 所以优先从已配对设备里按名字找，找不到才扫描。
 */
@SuppressLint("MissingPermission")
public class BleClient {

    private static final String TAG = "TYBle";

    public static final UUID SVC_UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
    public static final UUID RX_UUID  = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    public static final UUID TX_UUID  = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    public static final String NAME_PREFIX = "Tangyuan HID";

    public interface Listener {
        void onState(String state, String detail);
        void onLine(String json);
    }

    private final Context ctx;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothManager bm;
    private final BluetoothAdapter adapter;

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic rxChar, txChar;
    private volatile boolean ready = false;
    private volatile int mtu = 23;
    private volatile String deviceName = "";
    private volatile String deviceMac = "";
    private volatile int rssi = 0;

    private int retry = 0;
    private boolean wantConnected = true;
    private boolean discovering = false;

    // 写-应答同步
    private final Object writeLock = new Object();
    private boolean writeOk = false;
    private boolean writeDone = false;

    // 行缓冲（通知可能分片）
    private final StringBuilder lineBuf = new StringBuilder(512);

    public BleClient(Context ctx, Listener l) {
        this.ctx = ctx.getApplicationContext();
        this.listener = l;
        this.bm = (BluetoothManager) this.ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = bm != null ? bm.getAdapter() : null;
    }

    public boolean isReady() { return ready; }
    public String stateText() {
        if (adapter == null) return "no_adapter";
        if (!adapter.isEnabled()) return "bt_off";
        if (ready) return "ready";
        return wantConnected ? "connecting" : "idle";
    }
    public String deviceName() { return deviceName; }
    public String deviceMac() { return deviceMac; }
    public int rssi() { return rssi; }
    public int mtu() { return mtu; }

    // ---------------- 连接 ----------------

    public void start() {
        wantConnected = true;
        retry = 0;
        connectNow();
    }

    public void stop() {
        wantConnected = false;
        main.removeCallbacksAndMessages(null);
        closeGatt();
        ready = false;
        listener.onState("idle", "");
    }

    /**
     * 手动重连（/reconnect 和界面按钮用）：不等退避计时，立刻断掉重来。
     * 换机、手机重启蓝牙、或「系统连着但我这边 GATT 掉了」时，比等自动重连快。
     */
    public void reconnect() {
        wantConnected = true;
        retry = 0;
        main.removeCallbacksAndMessages(null);
        closeGatt();
        main.postDelayed(this::connectNow, 150);
    }

    private void connectNow() {
        if (adapter == null || !adapter.isEnabled()) {
            listener.onState("bt_off", "蓝牙未开启");
            scheduleRetry(3000);
            return;
        }
        // 1) 上次成功的 MAC
        SharedPreferences sp = ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE);
        String saved = sp.getString("mac", null);
        if (saved != null) {
            try {
                BluetoothDevice d = adapter.getRemoteDevice(saved);
                open(d);
                return;
            } catch (Exception ignored) { }
        }
        // 2) 已配对设备里按名字找（ESP32 被系统当 HID 连着时不会广播）
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice d : bonded) {
                String n = d.getName();
                String a = d.getAddress();
                if ((n != null && n.startsWith(NAME_PREFIX)) || a.equals(saved)) {
                    open(d);
                    return;
                }
            }
        }
        // 3) 扫描
        listener.onState("scanning", "未找到已配对设备，开始扫描");
        scanThenConnect();
    }

    private void scanThenConnect() {
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { scheduleRetry(3000); return; }

        ScanCallback cb = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                String n = d.getName();
                if (n != null && n.startsWith(NAME_PREFIX)) {
                    try { scanner.stopScan(this); } catch (Exception ignored) { }
                    rssi = result.getRssi();
                    open(d);
                }
            }
            @Override public void onScanFailed(int errorCode) {
                listener.onState("scan_failed", "err=" + errorCode);
                scheduleRetry(3000);
            }
        };
        try {
            scanner.startScan(cb);
        } catch (Exception e) {
            listener.onState("scan_failed", String.valueOf(e.getMessage()));
            scheduleRetry(3000);
            return;
        }
        main.postDelayed(() -> {
            try { scanner.stopScan(cb); } catch (Exception ignored) { }
            if (!ready && gatt == null) {
                listener.onState("not_found", "扫描超时：板子没上电，或没配对过");
                scheduleRetry(5000);
            }
        }, 10000);
    }

    private void open(BluetoothDevice d) {
        closeGatt();
        discovering = false;
        deviceName = d.getName() != null ? d.getName() : "";
        deviceMac = d.getAddress();
        listener.onState("connecting", deviceName + " " + deviceMac);
        try {
            gatt = d.connectGatt(ctx, false, gattCb, BluetoothDevice.TRANSPORT_LE);
        } catch (Exception e) {
            listener.onState("connect_failed", String.valueOf(e.getMessage()));
            scheduleRetry(3000);
        }
    }

    private void closeGatt() {
        ready = false;
        rxChar = null;
        txChar = null;
        if (gatt != null) {
            try { gatt.disconnect(); } catch (Exception ignored) { }
            try { gatt.close(); } catch (Exception ignored) { }
            gatt = null;
        }
    }

    private void scheduleRetry(long ms) {
        if (!wantConnected) return;
        retry++;
        long wait = Math.min(ms + retry * 500L, 8000);
        main.postDelayed(() -> { if (wantConnected) connectNow(); }, wait);
    }

    // ---------------- GATT 回调 ----------------

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (g != gatt) return;   // 旧连接的回调，丢掉（否则会把新连接状态写乱）
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                retry = 0;
                listener.onState("connected", "GATT 已连接，协商 MTU");
                try { g.requestMtu(517); } catch (Exception ignored) { }
                // 兜底：有些机型不回 onMtuChanged
                main.postDelayed(() -> { if (gatt != null && !discovering) discover(); }, 1200);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                ready = false;
                rxChar = null;
                txChar = null;
                listener.onState("disconnected", ("status=" + status + " " + describeGattError(status)).trim());
                // 关键：不要立刻 close，先重连；连续失败才彻底释放
                scheduleRetry(1000);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int m, int status) {
            if (g != gatt) return;
            mtu = m;
            discover();
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (g != gatt) return;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                listener.onState("discover_failed", "status=" + status);
                scheduleRetry(2000);
                return;
            }
            BluetoothGattService svc = g.getService(SVC_UUID);
            if (svc == null) {
                listener.onState("no_service",
                        "找到 GATT 但没找到自定义服务 —— 固件版本太老？");
                return;
            }
            rxChar = svc.getCharacteristic(RX_UUID);
            txChar = svc.getCharacteristic(TX_UUID);
            if (rxChar == null || txChar == null) {
                listener.onState("no_chars", "服务在，特征缺");
                return;
            }
            boolean notifySet = g.setCharacteristicNotification(txChar, true);
            BluetoothGattDescriptor d = txChar.getDescriptor(CCCD);
            if (d == null) {
                // 老固件没有 CCCD：通知开不了，但写命令一般还能用，先当可用
                finishReady(g, "mtu=" + mtu + " （无 CCCD）");
                return;
            }
            boolean issued;
            if (Build.VERSION.SDK_INT >= 33) {
                issued = g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == 0;
            } else {
                d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                issued = g.writeDescriptor(d);
            }
            if (!issued) {
                listener.onState("subscribe_failed",
                        "写 CCCD 未被受理（setNotification=" + notifySet + "）");
                scheduleRetry(2000);
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            if (g != gatt) return;
            if (status == BluetoothGatt.GATT_SUCCESS) {
                finishReady(g, "订阅完成 mtu=" + mtu);
            } else {
                // 固件开了 setSecurityAuth(bond=true)：未配对/未加密的 central 写 CCCD 会被拒
                listener.onState("subscribe_failed",
                        "订阅失败 status=" + status + " " + describeGattError(status)
                                + " → 先在系统蓝牙里配对 " + NAME_PREFIX + " N");
                scheduleRetry(3000);
            }
        }

        @Override
        public void onReadRemoteRssi(BluetoothGatt g, int r, int status) {
            if (g != gatt) return;
            if (status == BluetoothGatt.GATT_SUCCESS) rssi = r;
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (g != gatt) return;
            byte[] v = c.getValue();
            if (v != null) onBytes(v);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (g != gatt) return;
            synchronized (writeLock) {
                writeOk = (status == BluetoothGatt.GATT_SUCCESS);
                writeDone = true;
                writeLock.notifyAll();
            }
        }
    };

    /** 真正可用（订阅成功）后才置位，并记住 MAC 供下次直连。 */
    private void finishReady(BluetoothGatt g, String why) {
        ready = true;
        ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE)
                .edit().putString("mac", deviceMac).apply();
        try { g.readRemoteRssi(); } catch (Exception ignored) { }
        listener.onState("ready", deviceName + " " + why);
    }

    /** 常见 GATT 状态码 → 能照着做的提示（空串表示没有额外信息）。 */
    static String describeGattError(int status) {
        switch (status) {
            case BluetoothGatt.GATT_SUCCESS: return "";
            case 8: return "连接超时";
            case 19: return "对端主动断开";
            case 22: return "对端终止（多半是配对/加密被拒）";
            case 133: return "GATT 133：常见于未配对就订阅，或系统缓存了旧服务（解绑重配可清）";
            case 137: return "GATT 137：服务缓存过期，解绑重配";
            default: return "";
        }
    }

    private void discover() {
        if (gatt == null || discovering) return;
        discovering = true;
        try { gatt.discoverServices(); } catch (Exception ignored) { }
    }

    /** 通知可能分片：按行拼装（固件 reply 不带换行，一次 notify 就是一整条） */
    private void onBytes(byte[] v) {
        String s = new String(v, StandardCharsets.UTF_8);
        synchronized (lineBuf) {
            lineBuf.append(s);
            int nl;
            while ((nl = lineBuf.indexOf("\n")) >= 0) {
                String line = lineBuf.substring(0, nl).trim();
                lineBuf.delete(0, nl + 1);
                if (!line.isEmpty()) listener.onLine(line);
            }
            // 固件的 reply() 不带换行 —— 见到完整 JSON 就直接派发
            String cur = lineBuf.toString().trim();
            if (cur.length() > 1 && cur.startsWith("{") && balanced(cur)) {
                lineBuf.setLength(0);
                listener.onLine(cur);
            }
        }
    }

    private static boolean balanced(String s) {
        int depth = 0;
        boolean inStr = false, esc = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
            } else {
                if (c == '"') inStr = true;
                else if (c == '{') depth++;
                else if (c == '}') { depth--; if (depth == 0) return true; }
            }
        }
        return false;
    }

    // ---------------- 写命令 ----------------

    /** 发一条命令（自动补换行、等写完成）。返回是否写成功。 */
    public boolean send(String json) {
        BluetoothGattCharacteristic rx = rxChar;
        BluetoothGatt g = gatt;
        if (!ready || rx == null || g == null) return false;

        byte[] data = (json + "\n").getBytes(StandardCharsets.UTF_8);
        synchronized (writeLock) { writeDone = false; writeOk = false; }

        boolean issued;
        if (Build.VERSION.SDK_INT >= 33) {
            int rc = g.writeCharacteristic(rx, data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            issued = rc == 0;   // BluetoothStatusCodes.SUCCESS == 0
        } else {
            rx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            rx.setValue(data);
            issued = g.writeCharacteristic(rx);
        }
        if (!issued) {
            Log.w(TAG, "writeCharacteristic 未受理");
            return false;
        }
        synchronized (writeLock) {
            long dl = System.currentTimeMillis() + 2000;
            while (!writeDone) {
                long left = dl - System.currentTimeMillis();
                if (left <= 0) break;
                try { writeLock.wait(left); } catch (InterruptedException e) { break; }
            }
            return writeOk;
        }
    }
}
