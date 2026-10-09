package com.example.writingenhancer.update

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.example.writingenhancer.ui.Ui
import com.example.writingenhancer.ui.Ui.dp
import kotlin.concurrent.thread

/**
 * 업데이트 알림을 누르면 열리는 화면. 설치 허용을 확인하고, 새 APK를 받아 검사한 뒤
 * 시스템 설치 확인 화면을 띄운다. 스토어 밖 설치라 시스템의 `업데이트` 확인은 한 번 눌러야 한다.
 */
class UpdateActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var primary: Button
    private var update: AvailableUpdate? = null
    private var busy = false
    @Volatile
    private var cancelled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContent())
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        // 설치 허용 화면에서 돌아오면 바로 이어서 받는다.
        if (!busy && update != null && packageManager.canRequestPackageInstalls() &&
            primary.tag == STEP_PERMISSION
        ) {
            start()
        }
    }

    override fun onDestroy() {
        cancelled = true
        super.onDestroy()
    }

    private fun buildContent(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(28), dp(28), dp(28), dp(28))
        setBackgroundColor(Ui.PANEL)
        addView(Ui.label(this@UpdateActivity, "글 강화기 업데이트", 20f, Ui.PANEL_TEXT, true))
        status = Ui.label(this@UpdateActivity, "", 15f, Ui.PANEL_MUTED).apply {
            setPadding(0, dp(12), 0, dp(16))
            setLineSpacing(0f, 1.2f)
        }
        addView(status)
        progress = ProgressBar(this@UpdateActivity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            isIndeterminate = true
            visibility = android.view.View.GONE
        }
        addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(24)))
        primary = Ui.primaryButton(this@UpdateActivity, "업데이트").apply {
            setOnClickListener { onPrimary() }
        }
        addView(
            primary,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)).apply { topMargin = dp(18) },
        )
        addView(
            Ui.quietButton(this@UpdateActivity, "닫기") { finish() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(8) },
        )
    }

    private fun handle(intent: Intent) {
        if (intent.action == ACTION_INSTALL_STATUS) {
            handleInstallStatus(intent)
            return
        }
        val found = AppUpdater.fromIntent(intent)
        if (found == null) {
            show("업데이트 정보를 읽지 못했어요.", STEP_DONE, "닫기")
            return
        }
        update = found
        AppUpdater.cancelNotification(this)
        if (!packageManager.canRequestPackageInstalls()) {
            show(
                "${found.version} 버전을 설치하려면, 이 앱의 '출처를 알 수 없는 앱 설치'를 한 번 허용해 주세요. " +
                    "허용한 뒤 돌아오면 바로 이어서 받아요.",
                STEP_PERMISSION,
                "설치 허용 열기",
            )
            return
        }
        start()
    }

    private fun onPrimary() {
        when (primary.tag) {
            STEP_PERMISSION -> runCatching {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")),
                )
            }.onFailure { show("설정 화면을 열지 못했어요.", STEP_DONE, "닫기") }
            STEP_RETRY -> start()
            else -> finish()
        }
    }

    private fun start() {
        val target = update ?: return
        if (busy) return
        busy = true
        cancelled = false
        show("${target.version} 버전을 받는 중…", STEP_BUSY, "받는 중…")
        primary.isEnabled = false
        progress.visibility = android.view.View.VISIBLE
        progress.isIndeterminate = true
        thread(name = "writing-enhancer-update-download", isDaemon = true) {
            val result = runCatching {
                AppUpdater.download(this, target, isCancelled = { cancelled }) { received, total ->
                    if (total > 0) {
                        runOnUiThread {
                            progress.isIndeterminate = false
                            progress.progress = (received * 1000 / total).toInt().coerceIn(0, 1000)
                        }
                    }
                }
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.fold(
                    onSuccess = { apk ->
                        show("설치 화면을 여는 중…", STEP_BUSY, "설치 중…")
                        runCatching { AppUpdater.install(this, apk, statusIntent()) }
                            .onFailure { failed(it.message) }
                    },
                    onFailure = { failed(it.message) },
                )
            }
        }
    }

    private fun statusIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        4,
        Intent(this, UpdateActivity::class.java).setAction(ACTION_INSTALL_STATUS),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    @Suppress("DEPRECATION")
    private fun handleInstallStatus(intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirm == null) {
                    failed("설치 확인 화면을 열지 못했어요.")
                } else {
                    show("시스템 화면에서 '업데이트'를 눌러 주세요.", STEP_BUSY, "설치 중…")
                    runCatching { startActivity(confirm) }.onFailure { failed(it.message) }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> show("업데이트했어요.", STEP_DONE, "닫기")
            PackageInstaller.STATUS_FAILURE_ABORTED -> failed("설치를 취소했어요.")
            else -> failed(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }

    private fun failed(message: String?) {
        busy = false
        progress.visibility = android.view.View.GONE
        show(
            "업데이트하지 못했어요. ${message.orEmpty().take(160)}".trim(),
            if (update != null) STEP_RETRY else STEP_DONE,
            if (update != null) "다시 시도" else "닫기",
        )
    }

    private fun show(message: String, step: String, button: String) {
        status.text = message
        primary.text = button
        primary.tag = step
        primary.isEnabled = step != STEP_BUSY
        if (step != STEP_BUSY) busy = false
    }

    companion object {
        const val ACTION_INSTALL_STATUS = "com.example.writingenhancer.action.UPDATE_INSTALL_STATUS"
        private const val STEP_PERMISSION = "permission"
        private const val STEP_BUSY = "busy"
        private const val STEP_RETRY = "retry"
        private const val STEP_DONE = "done"
    }
}
