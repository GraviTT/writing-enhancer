package com.example.writingenhancer.process

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.example.writingenhancer.MainActivity
import com.example.writingenhancer.ai.AiClient
import com.example.writingenhancer.ai.EnhancementLevelPolicy
import com.example.writingenhancer.ai.EnhancementRequest
import com.example.writingenhancer.ai.EnhancementResult
import com.example.writingenhancer.ai.FollowUpMode
import com.example.writingenhancer.ai.MissingApiKeyException
import com.example.writingenhancer.capture.BridgeActivity
import com.example.writingenhancer.data.WorkspacePolicy
import com.example.writingenhancer.data.WorkspaceStore
import com.example.writingenhancer.memory.MemoryStore
import com.example.writingenhancer.overlay.OverlayService
import com.example.writingenhancer.security.SecureStore
import com.example.writingenhancer.ui.Ui
import com.example.writingenhancer.ui.Ui.dp
import java.io.File
import java.util.concurrent.Future

/**
 * 다른 앱의 텍스트 선택 메뉴에서 `글 강화`를 고르면 뜨는 작은 창.
 * 선택한 글을 바로 강화해 기록에 남기고, 결과를 [바꾸기](보낸 앱의 선택 영역을 교체)·[복사]·
 * [글 강화기에서 열기] 중 하나로 쓴다. 바꾸기는 보낸 앱이 편집 가능한 칸일 때만 보인다.
 */
class EnhanceSelectionActivity : Activity() {
    private lateinit var aiClient: AiClient
    private lateinit var workspaceStore: WorkspaceStore
    private lateinit var memoryStore: MemoryStore
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var result: TextView
    private lateinit var resultScroll: ScrollView
    private lateinit var actions: LinearLayout
    private lateinit var secondary: LinearLayout
    private var input = ""
    private var canReplace = false
    private var completed: String? = null
    private var historyId: String? = null
    private var request: Future<*>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val secureStore = SecureStore(this)
        aiClient = AiClient(secureStore)
        memoryStore = MemoryStore(secureStore)
        workspaceStore = WorkspaceStore(secureStore, File(filesDir, BridgeActivity.ATTACHMENT_DIRECTORY))
        canReplace = SelectionTextPolicy.canReplace(
            intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false),
        )
        setContentView(buildContent())
        window?.setLayout(
            minOf(resources.displayMetrics.widthPixels - dp(24), dp(520)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        val text = SelectionTextPolicy.enhanceInput(intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT))
        if (text == null) {
            showMessage("선택한 글이 없어요.")
            return
        }
        input = text
        start()
    }

    override fun onDestroy() {
        request?.cancel(true)
        aiClient.close()
        super.onDestroy()
    }

    private fun buildContent(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(18), dp(20), dp(14))
        background = Ui.rounded(Ui.PANEL, 22, this@EnhanceSelectionActivity, Ui.PANEL_STROKE)
        addView(Ui.label(this@EnhanceSelectionActivity, "글 강화", 18f, Ui.PANEL_TEXT, true))
        status = Ui.label(this@EnhanceSelectionActivity, "", 13f, Ui.PANEL_MUTED).apply {
            setPadding(0, dp(6), 0, dp(10))
        }
        addView(status)
        progress = ProgressBar(this@EnhanceSelectionActivity, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
        }
        addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(18)))
        result = Ui.label(this@EnhanceSelectionActivity, "", 15f, Ui.PANEL_TEXT).apply {
            setPadding(dp(14), dp(12), dp(14), dp(12))
            setLineSpacing(dp(2).toFloat(), 1.2f)
            setTextIsSelectable(true)
            background = Ui.rounded(Ui.PANEL_RAISED, 14, this@EnhanceSelectionActivity)
        }
        resultScroll = ScrollView(this@EnhanceSelectionActivity).apply {
            visibility = View.GONE
            addView(result)
        }
        addView(
            resultScroll,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(4) },
        )
        actions = LinearLayout(this@EnhanceSelectionActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        addView(
            actions,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(12) },
        )
        secondary = LinearLayout(this@EnhanceSelectionActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        addView(
            secondary,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(8) },
        )
    }

    private fun button(text: String, primary: Boolean, onClick: () -> Unit): Button =
        if (primary) {
            Ui.primaryButton(this, text).apply {
                minHeight = 0
                setPadding(dp(8), 0, dp(8), 0)
                textSize = 15f
                setOnClickListener { onClick() }
            }
        } else {
            Ui.quietButton(this, text) { onClick() }.apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            }
        }

    private fun setButtons(row: LinearLayout, buttons: List<Button>) {
        row.removeAllViews()
        buttons.forEachIndexed { index, button ->
            row.addView(
                button,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                    if (index > 0) marginStart = dp(8)
                },
            )
        }
        row.visibility = if (buttons.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun start() {
        completed = null
        historyId = null
        setStatus("선택한 글 ${input.length}자를 강화하는 중…")
        progress.visibility = View.VISIBLE
        resultScroll.visibility = View.GONE
        setButtons(actions, emptyList())
        setButtons(secondary, listOf(button("취소", primary = false) { finish() }))
        val level = EnhancementLevelPolicy.normalize(workspaceStore.loadDraft().enhancementLevel)
        val memories = memoryStore.relevantFor(input)
            .map { "${it.sourceKind} | ${it.type} | ${it.scope} | ${it.value}" }
        request = aiClient.enhance(
            EnhancementRequest(
                rawInput = input,
                memories = memories,
                followUpMode = FollowUpMode.FIRST,
                enhancementLevel = level,
            ),
        ) { outcome ->
            if (isFinishing || isDestroyed) return@enhance
            outcome.fold(
                onSuccess = { show(it, level) },
                onFailure = { failure ->
                    progress.visibility = View.GONE
                    if (failure is MissingApiKeyException) {
                        setStatus("설정에서 OpenAI 또는 Gemini API 키를 먼저 넣어 주세요.")
                        setButtons(actions, listOf(button("설정 열기", primary = true) { openApp() }))
                    } else {
                        setStatus(failure.message?.take(160) ?: "잠시 연결하지 못했어요.")
                        setButtons(actions, listOf(button("다시 시도", primary = true) { start() }))
                    }
                    setButtons(secondary, listOf(button("닫기", primary = false) { finish() }))
                },
            )
        }
    }

    private fun show(enhancement: EnhancementResult, level: Int) {
        val text = enhancement.completedText
        completed = text
        // 버블 창에서 보던 결과처럼 기록에 남겨, 나중에 기록에서 다시 찾거나 이어서 다듬을 수 있게 한다.
        historyId = runCatching {
            workspaceStore.addVersion(
                historyId = null,
                situation = "",
                rawInput = input,
                attachments = emptyList(),
                version = WorkspacePolicy.resultVersionForRequest(
                    text = text,
                    question = enhancement.followUp,
                    provider = enhancement.provider,
                    createdAt = System.currentTimeMillis(),
                    assumption = enhancement.assumption,
                    capturedRequestLevel = level,
                ),
            ).id
        }.getOrNull()
        progress.visibility = View.GONE
        setStatus(
            if (canReplace) {
                "바꾸기를 누르면 선택한 글이 이 글로 바뀌어요."
            } else {
                "이 글은 바꿀 수 없는 곳에서 왔어요. 복사해서 쓰세요."
            },
        )
        result.text = text
        resultScroll.visibility = View.VISIBLE
        resultScroll.layoutParams = resultScroll.layoutParams.apply {
            height = if (text.length > 400) dp(320) else ViewGroup.LayoutParams.WRAP_CONTENT
        }
        val main = mutableListOf<Button>()
        if (canReplace) main += button("바꾸기", primary = true) { replace() }
        main += button("복사", primary = !canReplace) { copy() }
        setButtons(actions, main)
        setButtons(
            secondary,
            listOf(
                button("다시 강화", primary = false) { start() },
                button("글 강화기에서 열기", primary = false) { openInPanel() },
                button("닫기", primary = false) { finish() },
            ),
        )
    }

    private fun replace() {
        val text = completed ?: return
        setResult(RESULT_OK, Intent().putExtra(Intent.EXTRA_PROCESS_TEXT, text))
        finish()
    }

    private fun copy() {
        val text = completed ?: return
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("강화한 글", text))
        Toast.makeText(this, "강화한 글을 복사했어요.", Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun openInPanel() {
        val id = historyId
        if (id == null || !Settings.canDrawOverlays(this)) {
            openApp()
            return
        }
        startForegroundService(
            Intent(this, OverlayService::class.java)
                .setAction(OverlayService.ACTION_OPEN_HISTORY)
                .putExtra(OverlayService.EXTRA_HISTORY_ID, id),
        )
        finish()
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    private fun setStatus(message: String) {
        status.text = message
    }

    private fun showMessage(message: String) {
        progress.visibility = View.GONE
        setStatus(message)
        setButtons(actions, emptyList())
        setButtons(secondary, listOf(button("닫기", primary = false) { finish() }))
    }
}
