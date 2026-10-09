package com.example.writingenhancer

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.example.writingenhancer.memory.MemoryStore
import com.example.writingenhancer.overlay.OverlayService
import com.example.writingenhancer.update.AppUpdater
import com.example.writingenhancer.security.SecureStore
import com.example.writingenhancer.ui.SettingsPanel
import com.example.writingenhancer.ui.Ui
import com.example.writingenhancer.ui.Ui.dp
import com.example.writingenhancer.ui.UiIcon
import android.view.WindowInsets

class MainActivity : Activity() {
    private lateinit var secureStore: SecureStore
    private lateinit var memoryStore: MemoryStore
    private lateinit var status: TextView
    private lateinit var mainButton: TextView
    private var startAfterPermission = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = window.decorView.systemUiVisibility and
                android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
        }
        secureStore = SecureStore(this)
        memoryStore = MemoryStore(secureStore)
        setContentView(buildContent())
        requestNotificationPermissionIfNeeded()
    }

    override fun onResume() {
        super.onResume()
        if (startAfterPermission && Settings.canDrawOverlays(this)) {
            startAfterPermission = false
            startBubble()
        } else if (
            OverlayService.isMarkedRunning(this) && !OverlayService.isAlive &&
            Settings.canDrawOverlays(this)
        ) {
            // 업데이트 등으로 서비스가 끝났는데 켜 둔 표시만 남은 경우, 사용자가 켜 둔 버블을 다시 띄운다.
            startForegroundService(
                Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_START),
            )
        }
        AppUpdater.checkInBackground(this)
        updateState()
    }

    private fun buildContent(): ScrollView {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(18), dp(24), dp(28))
            setBackgroundColor(Ui.PANEL)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(
            Ui.label(this, "글 강화기", 22f, Ui.PANEL_TEXT, true),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        val settings = Ui.iconButton(this, UiIcon.SETTINGS, "설정") { showSettings() }
        header.addView(settings, LinearLayout.LayoutParams(dp(44), dp(44)))
        content.addView(header)

        content.addView(
            Ui.label(
                this,
                "생각은 편하게.\n글은 단정하게.",
                30f,
                Ui.PANEL_TEXT,
                true,
            ).apply {
                setPadding(0, dp(38), 0, dp(14))
                setLineSpacing(0f, 1.16f)
            },
        )
        content.addView(
            Ui.label(
                this,
                "정리되지 않은 말도 괜찮아요.\n먼저 완성하고, 대화하며 다듬어요.",
                15f,
                Ui.PANEL_MUTED,
            ).apply {
                setLineSpacing(0f, 1.25f)
            },
        )

        val sample = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(20))
            background = Ui.rounded(Ui.PANEL_RAISED, 20, this@MainActivity, Ui.PANEL_STROKE)
        }
        sample.addView(Ui.label(this, "이렇게 달라져요", 12f, Ui.ACCENT_TEXT, true))
        sample.addView(Ui.label(this, "자료 확인했어 고생 많았다고 전하고 싶어", 14f, Ui.PANEL_MUTED).apply {
            setPadding(0, dp(14), 0, dp(14))
        })
        sample.addView(Ui.label(this, "자료 확인했습니다.\n준비하시느라 고생 많으셨어요.", 17f, Ui.PANEL_TEXT).apply {
            setLineSpacing(0f, 1.25f)
        })
        content.addView(sample, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(28) })

        val permissionCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(17), dp(18), dp(17))
            background = Ui.rounded(Ui.PANEL_RAISED, 16, this@MainActivity)
        }
        permissionCard.addView(Ui.label(this, "다른 앱을 쓰는 동안에도", 14f, Ui.PANEL_TEXT, true))
        permissionCard.addView(
            Ui.label(
                this,
                "작은 버블을 눌러 바로 글을 쓰세요.\n화면 위 표시 권한으로 버블을 띄울 수 있어요.",
                13f,
                Ui.PANEL_MUTED,
            ).apply {
                setPadding(0, dp(7), 0, 0)
                setLineSpacing(0f, 1.2f)
            },
        )
        status = Ui.label(this, "", 13f, Ui.ACCENT_TEXT).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(24), 0, dp(10))
        }
        content.addView(status)

        mainButton = Ui.primaryButton(this, "버블 시작").apply {
            setOnClickListener {
                if (OverlayService.isMarkedRunning(this@MainActivity)) {
                    stopBubble()
                } else {
                    ensureOverlayPermissionAndStart()
                }
            }
        }
        content.addView(
            mainButton,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)),
        )
        content.addView(permissionCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(24) })

        content.addView(
            Ui.label(
                this,
                "작성 내용과 기억은 이 기기에 안전하게 보관돼요.",
                12f,
                Ui.PANEL_MUTED,
            ).apply {
                gravity = Gravity.CENTER
                setPadding(dp(8), dp(18), dp(8), 0)
            },
        )

        return ScrollView(this).apply {
            setBackgroundColor(Ui.PANEL)
            isVerticalScrollBarEnabled = false
            setOnApplyWindowInsetsListener { view, insets ->
                val top: Int
                val bottom: Int
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val bars = insets.getInsets(WindowInsets.Type.systemBars())
                    top = bars.top
                    bottom = bars.bottom
                } else {
                    @Suppress("DEPRECATION")
                    top = insets.systemWindowInsetTop
                    @Suppress("DEPRECATION")
                    bottom = insets.systemWindowInsetBottom
                }
                view.setPadding(0, top, 0, bottom)
                insets
            }
            isFillViewport = true
            addView(
                content,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
    }

    private fun ensureOverlayPermissionAndStart() {
        if (Settings.canDrawOverlays(this)) {
            startBubble()
            return
        }

        startAfterPermission = true
        Toast.makeText(
            this,
            "목록에서 ‘글 강화기’의 화면 위 표시를 허용해 주세요.",
            Toast.LENGTH_LONG,
        ).show()
        startActivity(
            Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            ),
        )
    }

    private fun startBubble() {
        val intent = Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_START)
        startForegroundService(intent)
        updateState()
        Toast.makeText(this, "버블이 준비됐어요.", Toast.LENGTH_SHORT).show()
        moveTaskToBack(true)
    }

    private fun stopBubble() {
        startService(Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_STOP))
        updateState()
    }

    private fun showSettings() {
        SettingsPanel.showDialog(
            activity = this,
            secureStore = secureStore,
            memoryStore = memoryStore,
            onStopBubble = { stopBubble() },
            onChanged = { updateState() },
            onBubbleSizeChanged = {
                if (OverlayService.isMarkedRunning(this)) {
                    startService(
                        Intent(this, OverlayService::class.java)
                            .setAction(OverlayService.ACTION_RESIZE_BUBBLE),
                    )
                }
            },
        )
    }

    private fun updateState() {
        if (!::status.isInitialized) return
        val running = OverlayService.isMarkedRunning(this)
        val keyReady = secureStore.contains(SecureStore.OPENAI_KEY) ||
            secureStore.contains(SecureStore.GEMINI_KEY)
        status.text = when {
            running -> "버블이 화면 위에서 대기 중이에요."
            !Settings.canDrawOverlays(this) -> "화면 위 표시 권한이 필요해요."
            !keyReady -> "준비됨 · ⚙에서 API 키를 넣어 주세요."
            else -> "준비됨"
        }
        mainButton.text = if (running) "버블 끄기" else "버블 시작"
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 200)
        }
    }
}
