package com.tangyuan.bridge;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.ContentObserver;
import android.os.Handler;
import android.os.HandlerThread;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 无障碍看门狗。
 *
 * 为什么需要：dsh-go 的「手机操控」无障碍服务会被系统莫名其妙关掉 —— App 更新、
 * 权限审查、系统省电清理、甚至某些厂商的「安全中心」都会动这个开关。表现就是
 * 智能体突然「瞎了 / 点不动」，用户得手动跑去设置里重开。
 *
 * 做法：监听 Settings.Secure 的两个 key（事件驱动，不轮询），一旦发现目标服务
 * 从「已启用列表」里消失，立刻把它补回去。
 *
 * 前置权限：WRITE_SECURE_SETTINGS（signature|privileged|development），
 * 一条 adb 命令即可授予，之后永久有效：
 *
 *   adb shell pm grant com.tangyuan.bridge android.permission.WRITE_SECURE_SETTINGS
 *
 * 没有这个权限时不写设置，只在状态里报 no_perm（并让 App 界面提示怎么开）。
 */
public class Watchdog {

    private static final String TAG = "TYWatch";

    static final String PREF_ON = "watchdog_on";
    static final String PREF_LIST = "watchdog_list";

    /** 默认盯这两个：dsh-go 的手机操控 + 本 App 自己的眼睛 */
    static final String TARGET_DSH =
            "io.github.ccch1mneyyy.dsh_app/io.github.ccch1mneyyy.dsh_app.phone.a11y.PhoneA11yService";
    static final String TARGET_SELF = "com.tangyuan.bridge/com.tangyuan.bridge.CapService";
    static final String DEFAULT_LIST = TARGET_DSH + "," + TARGET_SELF;

    /** 写入后冷却，避免观察者回调自己把自己绕进死循环 */
    private static final long WRITE_COOLDOWN_MS = 2500;
    /** 兜底巡检间隔（观察者偶发丢事件时用；正常路径不靠它） */
    private static final long SAFETY_TICK_MS = 5 * 60 * 1000L;

    private final Context ctx;
    private final SharedPreferences sp;
    private HandlerThread thread;
    private Handler handler;
    private ContentObserver observer;
    private Runnable safety;

    private volatile long lastWriteAt = 0;
    private volatile String lastEvent = "";
    private volatile long lastEventAt = 0;
    private volatile int fixCount = 0;
    private volatile boolean running = false;

    public Watchdog(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.sp = this.ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE);
    }

    /** 仅当这条 adb 授权做过之后，才可能静默修复。 */
    public boolean permitted() {
        try {
            return ctx.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    public boolean enabled() {
        return sp.getBoolean(PREF_ON, true);
    }

    public void setEnabled(boolean on) {
        sp.edit().putBoolean(PREF_ON, on).apply();
        if (on) checkNow("manual_enable");
    }

    public List<String> targets() {
        String raw = sp.getString(PREF_LIST, DEFAULT_LIST);
        List<String> out = new ArrayList<>();
        for (String s : raw.split(",")) {
            String v = s.trim();
            if (!v.isEmpty()) out.add(v);
        }
        return out;
    }

    private void saveTargets(List<String> list) {
        sp.edit().putString(PREF_LIST, String.join(",", list)).apply();
    }

    public void addTarget(String component) {
        List<String> l = targets();
        if (!l.contains(component)) {
            l.add(component);
            saveTargets(l);
        }
        checkNow("add_target");
    }

    public void removeTarget(String component) {
        List<String> l = targets();
        l.remove(component);
        saveTargets(l);
    }

    // ------------------------------------------------------------ 生命周期

    public synchronized void start() {
        if (running) return;
        running = true;
        thread = new HandlerThread("ty-watchdog");
        thread.start();
        handler = new Handler(thread.getLooper());

        observer = new ContentObserver(handler) {
            @Override public void onChange(boolean selfChange) {
                checkNow("settings_changed");
            }
        };
        try {
            ContentResolver cr = ctx.getContentResolver();
            cr.registerContentObserver(
                    Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
                    false, observer);
            cr.registerContentObserver(
                    Settings.Secure.getUriFor(Settings.Secure.ACCESSIBILITY_ENABLED),
                    false, observer);
        } catch (Throwable t) {
            Log.w(TAG, "register observer failed: " + t);
        }

        // 兜底巡检：只防「观察者丢事件」，不是主路径
        safety = new Runnable() {
            @Override public void run() {
                checkNow("tick");
                if (running && handler != null) handler.postDelayed(this, SAFETY_TICK_MS);
            }
        };
        handler.postDelayed(safety, 3000);

        Log.i(TAG, "started, targets=" + targets() + ", permitted=" + permitted());
    }

    public synchronized void stop() {
        running = false;
        try {
            if (observer != null) ctx.getContentResolver().unregisterContentObserver(observer);
        } catch (Throwable ignored) { }
        observer = null;
        if (handler != null && safety != null) handler.removeCallbacks(safety);
        if (thread != null) {
            thread.quitSafely();
            thread = null;
            handler = null;
        }
    }

    // ------------------------------------------------------------ 核心逻辑

    private static String readList(ContentResolver cr) {
        try {
            String v = Settings.Secure.getString(cr,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return v == null ? "" : v;
        } catch (Throwable t) {
            return "";
        }
    }

    private static Set<String> split(String raw) {
        Set<String> s = new LinkedHashSet<>();
        for (String p : raw.split(":")) {
            String v = p.trim();
            if (!v.isEmpty()) s.add(v);
        }
        return s;
    }

    /** 总开关（accessibility_enabled）是否为 1。 */
    public boolean masterOn() {
        try {
            return Settings.Secure.getInt(ctx.getContentResolver(),
                    Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 现在缺哪几个（也用于状态展示）。 */
    public List<String> missing() {
        Set<String> cur = split(readList(ctx.getContentResolver()));
        List<String> out = new ArrayList<>();
        for (String t : targets()) if (!cur.contains(t)) out.add(t);
        return out;
    }

    /** 立刻检查一次；force=true 时不看开关（用于手动"现在修一下"）。 */
    public JSONObject checkNow(String reason) {
        JSONObject r = new JSONObject();
        try {
            List<String> miss = missing();
            boolean on = enabled();
            boolean master = masterOn();
            r.put("reason", reason);
            r.put("on", on);
            r.put("master", master);
            r.put("missing", new JSONArray(miss));
            // 两种故障都算故障：服务从列表里消失，或者总开关被关掉。
            // 后者更阴险 —— 服务还在列表里、也还绑着，但 AccessibilityManager.isEnabled()
            // 返回 false，智能体自己就以为「我被关了」，于是什么都不肯干。
            if (miss.isEmpty() && master) {
                r.put("action", "none");
                return r;
            }
            if (!on) {
                r.put("action", "skipped_off");
                return r;
            }
            if (!permitted()) {
                r.put("action", "no_perm");
                note(miss.isEmpty() ? "master_off_but_no_perm" : ("missing_but_no_perm:" + miss));
                return r;
            }
            long now = System.currentTimeMillis();
            if (now - lastWriteAt < WRITE_COOLDOWN_MS) {
                // 不能在冷却期把事件丢掉：真实场景里"列表被摘"和"总开关被关"
                // 往往是前后脚发生的（系统一次操作写两个 key）。丢掉第二个事件
                // 就会留下一个"服务都在、总开关是 0"的僵尸状态。
                r.put("action", "cooldown");
                long wait = WRITE_COOLDOWN_MS - (now - lastWriteAt) + 60;
                final Handler hh = handler;
                if (hh != null) hh.postDelayed(() -> checkNow("retry_after_cooldown"), wait);
                return r;
            }

            ContentResolver cr = ctx.getContentResolver();
            boolean ok = true;
            if (!miss.isEmpty()) {
                Set<String> cur = split(readList(cr));
                cur.addAll(miss);
                ok = Settings.Secure.putString(cr,
                        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, String.join(":", cur));
            }
            // 总开关必须跟着打开：系统在处理列表清空的瞬间会把它写成 0，
            // 只把列表补回来是不够的 —— 服务虽然绑上了，总开关一关，
            // 下次任何设置变动就会全部掉线。写不稳就重试几次。
            boolean masterOk = false;
            for (int i = 0; i < 4 && !masterOk; i++) {
                Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1);
                try { Thread.sleep(120); } catch (InterruptedException ignored) { }
                masterOk = Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1;
            }
            lastWriteAt = now;
            if (ok) fixCount++;
            note((ok ? (miss.isEmpty() ? "master_on" : "restored:") : "write_failed:") + miss
                    + (masterOk ? "" : " (主开关未复位)"));
            r.put("action", !ok ? "write_failed" : (miss.isEmpty() ? "master_on" : "restored"));
            r.put("added", new JSONArray(miss));
            r.put("accessibility_enabled", masterOk ? 1 : 0);
            Log.i(TAG, (ok ? "restored " : "write failed ") + miss + " master=" + masterOk);
            final Handler hv = handler;
            if (hv != null) hv.postDelayed(() -> checkNow("verify"), 1500);
        } catch (Throwable t) {
            try { r.put("action", "error"); r.put("err", String.valueOf(t)); } catch (Exception ignored) { }
            Log.w(TAG, "checkNow failed: " + t);
        }
        return r;
    }

    private void note(String ev) {
        lastEvent = ev;
        lastEventAt = System.currentTimeMillis();
    }

    // ------------------------------------------------------------ 状态输出

    public String statusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("on", enabled());
            o.put("permitted", permitted());
            o.put("running", running);
            o.put("targets", new JSONArray(targets()));
            o.put("master", masterOn());
            o.put("missing", new JSONArray(missing()));
            o.put("fixes", fixCount);
            o.put("last", lastEvent);
            o.put("last_at", lastEventAt);
            if (!permitted()) {
                o.put("hint",
                        "看门狗需要一次性授权（电脑执行一次即可）：adb shell pm grant com.tangyuan.bridge android.permission.WRITE_SECURE_SETTINGS");
            }
            return o.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"status_failed\"}";
        }
    }

    /** health 里用的精简版 */
    public String shortJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("on", enabled());
            o.put("perm", permitted());
            o.put("master", masterOn());
            o.put("miss", missing().size());
            o.put("fix", fixCount);
            return o.toString();
        } catch (Throwable t) {
            return "{\"on\":false}";
        }
    }
}
