package com.example.writingenhancer.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.example.writingenhancer.overlay.OverlayService

/** 업데이트로 앱이 바뀌면 서비스가 끝나므로, 버블을 켜 두었던 경우 다시 띄운다. */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!OverlayService.isMarkedRunning(context) || !Settings.canDrawOverlays(context)) return
        runCatching {
            context.startForegroundService(
                Intent(context, OverlayService::class.java).setAction(OverlayService.ACTION_START),
            )
        }
    }
}
