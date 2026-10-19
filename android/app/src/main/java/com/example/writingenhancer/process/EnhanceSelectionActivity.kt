package com.example.writingenhancer.process

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
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
import com.example.writingenhancer.ai.SharedWritingRules
import com.example.writingenhancer.capture.BridgeActivity
import com.example.writingenhancer.data.WorkspacePolicy
import com.example.writingenhancer.data.WorkspaceStore
import com.example.writingenhancer.memory.MemoryStore
import com.example.writingenhancer.overlay.OverlayService
import com.example.writingenhancer.security.SecureStore
import com.example.writingenhancer.ui.FlowLayout
import com.example.writingenhancer.ui.Ui
import com.example.writingenhancer.ui.Ui.dp
import java.io.File
import java.util.concurrent.Future

/**
 * 다른 앱의 텍스트 선택 메뉴에서 `글 강화`를 고르면 뜨는 작은 창.
 * 강화 단계와 상황(버튼으로 고르거나 직접 입력)을 정한 뒤 강화하고, 결과를
 * [바꾸기](보낸 앱의 선택 영역을 교체)·[복사]·[글 강화기에서 열기] 중 하나로 쓴다.
 * 바꾸기는 보낸 앱이 편집 가능한 칸일 때만 보인다. 결과는 기록에 남긴다.
 */
class EnhanceSelectionActivity : Activity() {
    private lateinit var aiClient: AiClient
    private lateinit var workspaceStore: WorkspaceStore
    private lateinit var memoryStore: MemoryStore
    private lateinit var status: TextView
    private lateinit var original: TextView
    private lateinit var options: LinearLayout
    private lateinit var levelButtons: List<Button>
    private lateinit var levelHint: TextView
    private lateinit var situationChips: List<Pair<SharedWritingRules.Situation, Button>>
    private lateinit var situationInput: EditText
    private lateinit var progress: ProgressBar
    private lateinit var resultBox: LinearLayout
    private lateinit var summary: TextView
    private lateinit var result: TextView
    private lateinit var actions: LinearLayout
    private lateinit var secondary: LinearLayout
    private var input = ""
    private var canReplace = false
    private var level = EnhancementLevelPolicy.DEFAULT
    private var completed: String? = null
    private var historyId: String? = null
    private var request: Future<*>? = null
    private var showingWholeOriginal = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val secureStore = SecureStore(this)
        aiClient = AiClient(secureStore)
        memoryStore = MemoryStore(secureStore)
        workspaceStore = WorkspaceStore(secureStore, File(filesDir, BridgeActivity.ATTACHMENT_DIRECTORY))
        canReplace = SelectionTextPolicy.canReplace(
            intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false),
        )
        val preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        level = SelectionTextPolicy.initialLevel(
            saved = if (preferences.contains(KEY_LEVEL)) preferences.getInt(KEY_LEVEL, EnhancementLevelPolicy.DEFAULT) else null,
            draftLevel = workspaceStore.loadDraft().enhancementLevel,
        )
        setContentView(buildContent())
        window?.setLayout(
            minOf(resources.displayMetrics.widthPixels - dp(24), dp(520)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val text = SelectionTextPolicy.enhanceInput(intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT))
        if (text == null) {
            showMessage("선택한 글이 없어요.")
            return
        }
        input = text
        original.text = text
        showOptions()
    }

    override fun onDestroy() {
        request?.cancel(true)
        aiClient.close()
        super.onDestroy()
    }

    // ── 화면 구성 ───────────────────────────────────────────

    private fun buildContent(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(18), dp(20), dp(14))
        background = Ui.rounded(Ui.PANEL, 22, this@EnhanceSelectionActivity, Ui.PANEL_STROKE)
        addView(Ui.label(this@EnhanceSelectionActivity, "글 강화", 18f, Ui.PANEL_TEXT, true))
        status = Ui.label(this@EnhanceSelectionActivity, "", 13f, Ui.PANEL_MUTED).apply {
            setPadding(0, dp(6), 0, dp(8))
        }
        addView(status)
        val body = LinearLayout(this@EnhanceSelectionActivity).apply { orientation = LinearLayout.VERTICAL }
        original = Ui.label(this@EnhanceSelectionActivity, "", 13f, Ui.PANEL_MUTED).apply {
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setLineSpacing(dp(2).toFloat(), 1.1f)
            maxLines = ORIGINAL_PREVIEW_LINES
            ellipsize = TextUtils.TruncateAt.END
            background = Ui.rounded(Ui.PANEL_RAISED, 12, this@EnhanceSelectionActivity, Ui.PANEL_STROKE)
            contentDescription = "선택한 글. 누르면 전체를 보거나 접어요."
            setOnClickListener { toggleOriginal() }
        }
        body.addView(original)
        options = buildOptions()
        body.addView(options, matchWidth().apply { topMargin = dp(12) })
        progress = ProgressBar(this@EnhanceSelectionActivity, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
        }
        body.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(18)).apply { topMargin = dp(14) })
        resultBox = buildResult()
        body.addView(resultBox, matchWidth().apply { topMargin = dp(12) })
        addView(
            ScrollView(this@EnhanceSelectionActivity).apply {
                isFillViewport = true
                addView(body)
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        actions = LinearLayout(this@EnhanceSelectionActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        addView(actions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(12) })
        secondary = LinearLayout(this@EnhanceSelectionActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        addView(secondary, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(8) })
    }

    private fun matchWidth() =
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    private fun sectionTitle(title: String, note: String = ""): TextView =
        Ui.label(this, if (note.isEmpty()) title else "$title  ·  $note", 14f, Ui.PANEL_TEXT, true).apply {
            setPadding(0, dp(4), 0, dp(8))
        }

    private fun buildOptions(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(sectionTitle("강화 단계"))
        val row = LinearLayout(this@EnhanceSelectionActivity).apply { orientation = LinearLayout.HORIZONTAL }
        levelButtons = EnhancementLevelPolicy.levels.mapIndexed { index, definition ->
            Ui.quietButton(this@EnhanceSelectionActivity, "${definition.value}\n${SharedWritingRules.LEVEL_SHORT_LABELS[index]}") {
                setLevel(definition.value)
            }.apply {
                textSize = 13f
                maxLines = 2
                setLineSpacing(0f, 1.05f)
                setPadding(0, dp(6), 0, dp(6))
                contentDescription = "${definition.value}단계 ${definition.label}"
            }.also { button ->
                row.addView(button, LinearLayout.LayoutParams(0, dp(56), 1f).apply { if (index > 0) marginStart = dp(5) })
            }
        }
        addView(row, matchWidth())
        levelHint = Ui.label(this@EnhanceSelectionActivity, "", 12f, Ui.PANEL_MUTED).apply {
            setPadding(dp(2), dp(8), 0, dp(12))
        }
        addView(levelHint)
        addView(sectionTitle("상황", "고르거나 직접 써도 돼요"))
        val chips = FlowLayout(this@EnhanceSelectionActivity).apply {
            horizontalGap = dp(6)
            verticalGap = dp(6)
        }
        situationChips = SharedWritingRules.SITUATIONS.map { situation ->
            situation to Ui.quietButton(this@EnhanceSelectionActivity, situation.label) {
                situationInput.setText(SelectionTextPolicy.toggleSituation(situationInput.text.toString(), situation.text))
                situationInput.setSelection(situationInput.text.length)
            }.apply {
                textSize = 13f
                minHeight = dp(38)
                setPadding(dp(13), dp(6), dp(13), dp(6))
                contentDescription = "상황: ${situation.text}"
            }.also { chip ->
                chips.addView(chip, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)))
            }
        }
        addView(chips, matchWidth())
        situationInput = EditText(this@EnhanceSelectionActivity).apply {
            hint = "직접 입력 · 예: 친구에게 보내는 생일 축하"
            setHintTextColor(0xFF7E7F8F.toInt())
            setTextColor(Ui.PANEL_TEXT)
            textSize = 14f
            minLines = 1
            maxLines = 3
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = Ui.inputBackground(this@EnhanceSelectionActivity)
            contentDescription = "상황 직접 입력"
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(text: Editable?) = syncSituationChips()
            })
        }
        addView(situationInput, matchWidth().apply { topMargin = dp(10) })
    }

    private fun buildResult(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        val head = LinearLayout(this@EnhanceSelectionActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        summary = Ui.label(this@EnhanceSelectionActivity, "", 12f, Ui.PANEL_MUTED).apply {
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        }
        head.addView(summary, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(
            Ui.quietButton(this@EnhanceSelectionActivity, "조건 바꾸기") { showOptions() }.apply {
                textSize = 12f
                setTextColor(Ui.ACCENT_TEXT)
                contentDescription = "강화 단계나 상황을 바꿔 다시 강화"
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)).apply { marginStart = dp(8) },
        )
        addView(head, matchWidth())
        result = Ui.label(this@EnhanceSelectionActivity, "", 15f, Ui.PANEL_TEXT).apply {
            setPadding(dp(14), dp(12), dp(14), dp(12))
            setLineSpacing(dp(2).toFloat(), 1.2f)
            setTextIsSelectable(true)
            background = Ui.rounded(Ui.PANEL_RAISED, 14, this@EnhanceSelectionActivity)
        }
        addView(result, matchWidth().apply { topMargin = dp(8) })
    }

    private fun button(text: String, primary: Boolean, onClick: () -> Unit): Button =
        if (primary) {
            Ui.primaryButton(this, text).apply {
                minHeight = 0
                setPadding(dp(8), 0, dp(8), 0)
                textSize = 15f
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
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

    // ── 상태 ────────────────────────────────────────────────

    private fun toggleOriginal() {
        showingWholeOriginal = !showingWholeOriginal
        original.maxLines = if (showingWholeOriginal) Int.MAX_VALUE else ORIGINAL_PREVIEW_LINES
    }

    private fun setLevel(value: Int) {
        level = EnhancementLevelPolicy.normalize(value)
        levelButtons.forEachIndexed { index, button ->
            val selected = index + EnhancementLevelPolicy.MIN == level
            button.background = Ui.interactive(this, if (selected) Ui.ACCENT else Ui.PANEL_FIELD, 12)
            button.setTextColor(if (selected) Color.WHITE else Ui.PANEL_TEXT)
            button.isSelected = selected
        }
        levelHint.text = SelectionTextPolicy.levelHint(level)
        getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putInt(KEY_LEVEL, level).apply()
    }

    private fun syncSituationChips() {
        val current = situationInput.text.toString().trim()
        for ((situation, chip) in situationChips) {
            val chosen = situation.text == current
            chip.background = Ui.interactive(this, if (chosen) Ui.ACCENT_SURFACE else Ui.PANEL_FIELD, 19)
            chip.setTextColor(if (chosen) Ui.ACCENT_TEXT else Ui.PANEL_TEXT)
            chip.isSelected = chosen
        }
    }

    private fun showOptions() {
        request?.cancel(true)
        setStatus("선택한 글 ${input.length}자 · 강화 단계와 상황을 고른 뒤 강화하세요.")
        options.visibility = View.VISIBLE
        progress.visibility = View.GONE
        resultBox.visibility = View.GONE
        setLevel(level)
        syncSituationChips()
        setButtons(actions, listOf(button("강화하기", primary = true) { start() }))
        setButtons(
            secondary,
            buildList {
                if (completed != null) add(button("결과로 돌아가기", primary = false) { showResult() })
                add(button("닫기", primary = false) { finish() })
            },
        )
    }

    private fun start() {
        val situation = situationInput.text.toString().trim()
        val requestLevel = level
        setStatus("선택한 글 ${input.length}자를 강화하는 중…")
        options.visibility = View.GONE
        resultBox.visibility = View.GONE
        progress.visibility = View.VISIBLE
        setButtons(actions, emptyList())
        setButtons(secondary, listOf(button("취소", primary = false) { finish() }))
        val memories = memoryStore.relevantFor(listOf(situation, input).filter { it.isNotBlank() }.joinToString(" "))
            .map { "${it.sourceKind} | ${it.type} | ${it.scope} | ${it.value}" }
        request?.cancel(true)
        request = aiClient.enhance(
            EnhancementRequest(
                rawInput = input,
                situation = situation,
                memories = memories,
                followUpMode = FollowUpMode.FIRST,
                enhancementLevel = requestLevel,
            ),
        ) { outcome ->
            if (isFinishing || isDestroyed) return@enhance
            outcome.fold(
                onSuccess = { show(it, requestLevel, situation) },
                onFailure = { failure ->
                    showOptions()
                    if (failure is MissingApiKeyException) {
                        setStatus("설정에서 OpenAI 또는 Gemini API 키를 먼저 넣어 주세요.")
                        setButtons(actions, listOf(button("설정 열기", primary = true) { openApp() }))
                    } else {
                        setStatus(failure.message?.take(160) ?: "잠시 연결하지 못했어요.")
                        setButtons(actions, listOf(button("다시 시도", primary = true) { start() }))
                    }
                },
            )
        }
    }

    private fun show(enhancement: EnhancementResult, requestLevel: Int, situation: String) {
        val text = enhancement.completedText
        completed = text
        // 버블 창에서 보던 결과처럼 기록에 남긴다. 다시 강화하면 같은 기록에 결과가 쌓인다.
        historyId = runCatching {
            workspaceStore.addVersion(
                historyId = historyId,
                situation = situation,
                rawInput = input,
                attachments = emptyList(),
                version = WorkspacePolicy.resultVersionForRequest(
                    text = text,
                    question = enhancement.followUp,
                    provider = enhancement.provider,
                    createdAt = System.currentTimeMillis(),
                    assumption = enhancement.assumption,
                    capturedRequestLevel = requestLevel,
                ),
            ).id
        }.getOrNull() ?: historyId
        summary.text = SelectionTextPolicy.optionSummary(requestLevel, situation)
        result.text = text
        showResult()
    }

    private fun showResult() {
        val text = completed ?: return
        progress.visibility = View.GONE
        options.visibility = View.GONE
        resultBox.visibility = View.VISIBLE
        result.text = text
        setStatus(
            if (canReplace) {
                "바꾸기를 누르면 선택한 글이 이 글로 바뀌어요."
            } else {
                "이 글은 바꿀 수 없는 곳에서 왔어요. 복사해서 쓰세요."
            },
        )
        val main = mutableListOf<Button>()
        if (canReplace) main += button("바꾸기", primary = true) { replace() }
        main += button("복사", primary = !canReplace) { copy() }
        setButtons(actions, main)
        setButtons(
            secondary,
            listOf(
                button("다시 강화", primary = false) { start() },
                button("앱에서 열기", primary = false) { openInPanel() },
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
        options.visibility = View.GONE
        original.visibility = View.GONE
        setStatus(message)
        setButtons(actions, emptyList())
        setButtons(secondary, listOf(button("닫기", primary = false) { finish() }))
    }

    private companion object {
        const val PREFERENCES = "selection_enhance"
        const val KEY_LEVEL = "level"
        const val ORIGINAL_PREVIEW_LINES = 3
    }
}
