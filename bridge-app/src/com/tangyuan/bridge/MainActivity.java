package com.tangyuan.bridge;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 极简界面：状态面板 + 四个按钮。
 * 不用 XML 资源，纯代码布局 —— 这样 aapt2 不需要编译 res，构建链最简。
 */
public class MainActivity extends Activity {

    private TextView status, hint, log;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final List<String> logs = new ArrayList<>();

    private static final int REQ = 100;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 64, 48, 32);
        root.setBackgroundColor(Color.parseColor("#101418"));

        TextView title = new TextView(this);
        title.setText("汤圆蓝牙桥");
        title.setTextSize(26);
        title.setTextColor(Color.parseColor("#7FE3C0"));
        title.setGravity(Gravity.START);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("v" + BuildConfig.VERSION_NAME + " · ESP32 ⇄ BLE ⇄ 127.0.0.1:" + HttpServer.PORT);
        sub.setTextSize(13);
        sub.setTextColor(Color.parseColor("#8A97A6"));
        sub.setPadding(0, 8, 0, 22);
        root.addView(sub);

        status = new TextView(this);
        status.setTextSize(15);
        status.setTextColor(Color.WHITE);
        status.setPadding(0, 0, 0, 14);
        root.addView(status);

        hint = new TextView(this);
        hint.setTextSize(13);
        hint.setTextColor(Color.parseColor("#E8C47A"));
        hint.setPadding(0, 0, 0, 20);
        root.addView(hint);

        root.addView(btn("启动桥接", "#2E7D5B", v -> startBridge()));
        root.addView(btn("重连 BLE", "#2C5D7A", v -> {
            Intent i = new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_RECONNECT);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
            appendLog("已请求重连");
        }));
        root.addView(btn("停止", "#7A3030", v -> {
            Intent i = new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_STOP);
            startService(i);
            appendLog("已请求停止");
        }));
        root.addView(btn("复制 HTTP 地址", "#2C3E50", v -> {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(android.content.ClipData.newPlainText(
                    "url", "http://127.0.0.1:" + HttpServer.PORT));
            appendLog("已复制 http://127.0.0.1:" + HttpServer.PORT);
        }));

        ScrollView sc = new ScrollView(this);
        log = new TextView(this);
        log.setTextSize(12);
        log.setTextColor(Color.parseColor("#9FB0C0"));
        log.setPadding(0, 20, 0, 0);
        log.setTypeface(Typeface.MONOSPACE);
        sc.addView(log);
        root.addView(sc);

        setContentView(root);

        requestPerms();
        startBridge();
        ui.postDelayed(tick, 500);
    }

    private Button btn(String text, String color, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(Color.parseColor(color));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 116);
        lp.setMargins(0, 0, 0, 16);
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    private void startBridge() {
        Intent i = new Intent(this, BridgeService.class).setAction(BridgeService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
        appendLog("服务已启动");
    }

    private void requestPerms() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.BLUETOOTH_SCAN);
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ);
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            String s = BridgeService.state;
            String d = BridgeService.detail;
            boolean ready = "ready".equals(s);

            StringBuilder sb = new StringBuilder();
            sb.append("服务：").append(BridgeService.serviceRunning ? "运行中" : "未运行").append('\n');
            sb.append("状态：").append(s).append(d == null || d.isEmpty() ? "" : " · " + d).append('\n');
            sb.append("HTTP：http://127.0.0.1:").append(HttpServer.PORT);
            status.setText(sb.toString());

            if (ready) {
                hint.setText("");
            } else if ("subscribe_failed".equals(s)) {
                hint.setText("命令通道订阅失败（多半没配对/没加密）→ 到「设置 › 蓝牙」配对 "
                        + BleClient.NAME_PREFIX + " N，然后点「重连 BLE」。");
            } else if ("bt_off".equals(s)) {
                hint.setText("蓝牙没开 → 打开系统蓝牙后会自动重连。");
            } else if ("scan_failed".equals(s) || "not_found".equals(s) || "no_service".equals(s)) {
                hint.setText("没找到板子 → 确认 ESP32 已上电；首次使用请到「设置 › 蓝牙」配对 "
                        + BleClient.NAME_PREFIX + " N。");
            } else {
                hint.setText("等待 BLE 连接… 若一直连不上：系统蓝牙里把 "
                        + BleClient.NAME_PREFIX + " N 连一次，或点「重连 BLE」。");
            }

            String lg = BridgeService.lastLog;
            if (lg != null && !lg.isEmpty() && (logs.isEmpty() || !logs.get(logs.size() - 1).equals(lg))) {
                appendLog(lg);
            }
            ui.postDelayed(this, 700);
        }
    };

    private void appendLog(String s) {
        logs.add(s);
        while (logs.size() > 80) logs.remove(0);
        StringBuilder sb = new StringBuilder();
        for (String x : logs) sb.append(x).append('\n');
        log.setText(sb.toString());
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
