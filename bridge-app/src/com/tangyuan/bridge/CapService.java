package com.tangyuan.bridge;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 汤圆蓝牙桥的「眼睛」：一个极小的无障碍服务，只干两件事。
 *
 *   · /shot —— 用 AccessibilityService.takeScreenshot()（Android 11+）拍一张 JPEG。
 *              不需要 MediaProjection 的每次授权弹窗，也不占摄像头。
 *   · /a11y —— 把前台窗口的控件树摊平成 JSON（文字 + 包围盒 + 可点/可输入），
 *              模型据此算坐标，比凭截图估位置准得多。
 *
 * 为什么不是 MediaProjection：那玩意儿每次进程重启都要用户点一次「开始录制」，
 * 无人值守场景直接废掉。a11y 截图只需要用户在设置里开一次开关。
 */
public class CapService extends AccessibilityService {

    private static final String TAG = "TYCap";
    private static volatile CapService I;

    public static CapService get() { return I; }

    public static boolean ready() { return I != null; }

    /** 跳到系统无障碍设置页（用户手动开开关时用）。 */
    public static void openSettings(Context ctx) {
        try {
            Intent it = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(it);
        } catch (Throwable t) {
            Log.w(TAG, "open settings failed: " + t);
        }
    }

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        I = this;
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info != null) {
                info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                        | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                        | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
                info.notificationTimeout = 50;
                setServiceInfo(info);
            }
        } catch (Throwable t) {
            Log.w(TAG, "setServiceInfo: " + t);
        }
        Log.i(TAG, "cap service connected");
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* 不需要事件流 */ }

    @Override public void onInterrupt() { }

    @Override public boolean onUnbind(Intent intent) {
        I = null;
        return super.onUnbind(intent);
    }

    @Override public void onDestroy() {
        I = null;
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 截图

    /**
     * a11y 截图 → JPEG 字节。失败返回 null（原因进日志）。
     * 系统对截图有节流（约 1 秒 1 张），太密集会返回 INTERVAL_TIME_SHORT，属正常。
     */
    public byte[] screenshotJpeg(final int quality) {
        if (Build.VERSION.SDK_INT < 30) return null;
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<Bitmap> bmp = new AtomicReference<>(null);
        final AtomicReference<String> err = new AtomicReference<>(null);
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult r) {
                    HardwareBuffer hb = r.getHardwareBuffer();
                    try {
                        Bitmap b = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                        if (b != null) bmp.set(b.copy(Bitmap.Config.ARGB_8888, false));
                    } catch (Throwable t) {
                        err.set("wrap:" + t);
                    } finally {
                        try { hb.close(); } catch (Throwable ignored) { }
                    }
                    latch.countDown();
                }
                @Override public void onFailure(int code) {
                    err.set("code=" + code);
                    latch.countDown();
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "takeScreenshot throw: " + t);
            return null;
        }
        try {
            if (!latch.await(8, TimeUnit.SECONDS)) {
                Log.w(TAG, "screenshot timeout");
                return null;
            }
        } catch (InterruptedException e) {
            return null;
        }
        Bitmap b = bmp.get();
        if (b == null) {
            Log.w(TAG, "screenshot failed " + err.get());
            return null;
        }
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(320 * 1024);
            b.compress(Bitmap.CompressFormat.JPEG, Math.max(20, Math.min(95, quality)), bo);
            b.recycle();
            return bo.toByteArray();
        } catch (Throwable t) {
            Log.w(TAG, "compress failed: " + t);
            return null;
        }
    }

    // ------------------------------------------------------------ 控件树

    /**
     * 前台窗口 → 扁平的控件列表 JSON。
     * 每个节点：t 文字 / d 描述 / c 类名 / id 资源名 / b 包围盒 [l,t,r,b] /
     *          clk 可点 / ed 可输入 / sc 可滚动 / chk 选中态 / p 父节点下标
     * 只报「有文字或能交互」的节点，省 token。
     */
    public String treeJson(int maxNodes) {
        AccessibilityNodeInfo root = null;
        try { root = getRootInActiveWindow(); } catch (Throwable t) { Log.w(TAG, "root: " + t); }
        if (root == null) {
            return "{\"ok\":false,\"err\":\"no_root\","
                    + "\"detail\":\"前台窗口读不到（锁屏、输入法、系统弹窗、或目标 App 禁止无障碍）\"}";
        }
        try {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("pkg", s(root.getPackageName()));
            out.put("win", s(root.getContentDescription()));
            JSONArray arr = new JSONArray();
            int[] budget = new int[]{Math.max(20, Math.min(maxNodes, 1500))};
            walk(root, arr, budget, -1);
            out.put("count", arr.length());
            out.put("nodes", arr);
            return out.toString();
        } catch (Throwable t) {
            Log.w(TAG, "tree failed: " + t);
            return "{\"ok\":false,\"err\":\"dump_failed\"}";
        }
    }

    private void walk(AccessibilityNodeInfo n, JSONArray out, int[] budget, int parentIdx) {
        if (n == null || budget[0] <= 0) return;
        budget[0]--;
        int myIdx = parentIdx;
        try {
            String t = s(n.getText());
            String d = s(n.getContentDescription());
            boolean clickable = n.isClickable();
            boolean editable = n.isEditable();
            boolean scrollable = n.isScrollable();
            boolean interesting = !t.isEmpty() || !d.isEmpty()
                    || clickable || editable || scrollable || n.isCheckable();
            if (interesting) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (r.width() > 0 && r.height() > 0) {
                    JSONObject o = new JSONObject();
                    if (!t.isEmpty()) o.put("t", clip(t, 120));
                    if (!d.isEmpty()) o.put("d", clip(d, 80));
                    o.put("c", shortCls(s(n.getClassName())));
                    String id = n.getViewIdResourceName();
                    if (id != null && !id.isEmpty()) o.put("id", id);
                    o.put("b", new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom));
                    if (clickable) o.put("clk", true);
                    if (editable) o.put("ed", true);
                    if (scrollable) o.put("sc", true);
                    if (n.isCheckable()) o.put("chk", n.isChecked());
                    if (parentIdx >= 0) o.put("p", parentIdx);
                    out.put(o);
                    myIdx = out.length() - 1;
                }
            }
            int kids = n.getChildCount();
            for (int i = 0; i < kids && budget[0] > 0; i++) {
                walk(n.getChild(i), out, budget, myIdx);
            }
        } catch (Throwable t2) {
            /* 单个节点读失败不影响整体 */
        }
    }

    private static String s(CharSequence cs) { return cs == null ? "" : cs.toString().trim(); }

    private static String clip(String v, int max) {
        return v.length() <= max ? v : v.substring(0, max) + "…";
    }

    private static String shortCls(String cls) {
        if (cls == null || cls.isEmpty()) return "";
        int i = cls.lastIndexOf('.');
        return i >= 0 ? cls.substring(i + 1) : cls;
    }
}
