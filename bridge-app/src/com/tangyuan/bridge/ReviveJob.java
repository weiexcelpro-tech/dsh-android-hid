package com.tangyuan.bridge;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 定时复活桥服务。
 *
 * 看门狗活在 BridgeService 里，服务一停它就跟着消失 —— 所以需要有人从「服务之外」
 * 定期来敲门。JobScheduler 正好干这个：即使进程被回收，系统也会把 App 唤醒跑这个 Job。
 *
 * 唯一救不了的是 force-stop（系统会把 App 标成 stopped，任何 Job/广播都不再送达），
 * 那是 Android 的设计，没有 App 能绕过；只能等用户点一下图标。
 */
public class ReviveJob extends JobService {

    private static final String TAG = "TYRevive";
    static final int JOB_ID = 8801;
    private static final long PERIOD_MS = 15 * 60 * 1000L;

    public static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo.Builder b = new JobInfo.Builder(JOB_ID, new ComponentName(c, ReviveJob.class))
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(true);
            int r = js.schedule(b.build());
            Log.i(TAG, "schedule -> " + (r == JobScheduler.RESULT_SUCCESS ? "ok" : "fail"));
        } catch (Throwable t) {
            Log.w(TAG, "schedule failed: " + t);
        }
    }

    public static void cancel(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_ID);
        } catch (Throwable ignored) { }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        Context c = getApplicationContext();
        boolean should = c.getSharedPreferences("bridge", Context.MODE_PRIVATE)
                .getBoolean(BridgeService.PREF_SHOULD_RUN, true);
        if (should && !BridgeService.serviceRunning) {
            try {
                Intent i = new Intent(c, BridgeService.class).setAction(BridgeService.ACTION_START);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
                else c.startService(i);
                Log.i(TAG, "revived bridge service");
            } catch (Throwable t) {
                Log.w(TAG, "revive failed: " + t);
            }
        }
        return false; // 已经同步做完
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // 被中断就重排
    }
}
