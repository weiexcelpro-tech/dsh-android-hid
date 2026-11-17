package com.tangyuan.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 开机自启：手机重启后服务自己回来，不用先去点一次 App。
 *
 * 注意：Android 12+ 对「后台启动前台服务」管得严，BOOT_COMPLETED 属于豁免场景之一，
 * 但个别 ROM 仍会抛 ForegroundServiceStartNotAllowedException —— 吞掉即可，
 * 用户手动打开 App 也能起来，别因为自启失败就崩。
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "TYBoot";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            return;
        }
        try {
            Intent svc = new Intent(ctx, BridgeService.class).setAction(BridgeService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
            else ctx.startService(svc);
            Log.i(TAG, "开机自启：已请求启动桥接服务");
        } catch (Exception e) {
            Log.w(TAG, "开机自启被系统拒绝：" + e.getMessage());
        }
    }
}
