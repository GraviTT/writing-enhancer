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
import android.text.InputType
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
 * 선택한 글을 필요하면 고친 뒤, 강화 단계와 상황(접어 둔 칸에서 버튼으로 고르거나 직접 입력)을
 * 정해 강화하고, 결과를 [바꾸기](보낸 앱의 선택 영역을 교체)·[복사]·[앱에서 열기] 중 하나로 쓴다.
 * 상황 버튼은 사용자가 저장·삭제할 수 있다. 바꾸기는 보낸 앱이 편집 가능한 칸일 때만 보인다.
 */
class EnhanceSelectionActivity : Activity() {
    private lateinit var aiClient: AiClient
    private lateinit var workspaceStore: WorkspaceStore
    private lateinit var memoryStore: MemoryStore
    private lateinit var status: TextView
    private lateinit var originalLabel: TextView
    private lateinit var original: EditText
    private lateinit var options: LinearLayout
    private lateinit var levelButtons: List<Button>
    private lateinit var levelHint: TextView
    private lateinit var situationToggle: Button
    private lateinit var situationSection: LinearLayout
    private lateinit var situationChips: FlowLayout
    private lateinit var situationInput: EditText
    private lateinit var saveSituationButton: Button
    private lateinit var editSituationButton: Button
    private lateinit var resetSituationButton: Button
    private lateinit var editHint: TextView
    private lateinit var progress: ProgressBar
    private lateinit var resultBox: LinearLayout
    private lateinit var summary: TextView
    private lateinit var result: TextView
    private lateinit var actions: LinearLayout
    private lateinit var secondary: LinearLayout
    private var input = ""
    private var canReplace = false
    private var level = EnhancementLevelPolicy.DEFAULT
    private var presets: List<SituationPresetPolicy.Preset> = SituationPresetPolicy.defaults()
    private var customizedPresets = false
    private var editingPresets = false
    private var completed: String? = null
    private var historyId: String? = null
    private var request: Future<*>? = null

    private val preferences by lazy { getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val secureStore = SecureStore(this)
        aiClient = AiClient(secureStore)
        memoryStore = MemoryStore(secureStore)
        workspaceStore = WorkspaceStore(secureStore, File(filesDir, BridgeActivity.ATTACHMENT_DIRECTORY))
        canReplace = SelectionTextPolicy.canReplace(
            intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false),
        )
        level = SelectionTextPolicy.initialLevel(
            saved = if (preferences.contains(KEY_LEVEL)) preferences.getInt(KEY_LEVEL, EnhancementLevelPolicy.DEFAULT) else null,
            draftLevel = workspaceStore.loadDraft().enhancementLevel,
        )
        loadPresets()
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
        original.setText(text)
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
        originalLabel = Ui.label(this@EnhanceSelectionActivity, "", 12f, Ui.PANEL_MUTED).apply {
            setPadding(dp(2), 0, 0, dp(6))
        }
        body.addView(originalLabel)
        original = textField("강화할 글", minLines = 2, maxLines = ORIGINAL_MAX_LINES).apply {
            contentDescription = "선택한 글. 강화하기 전에 고쳐 써도 돼요."
            onChanged { syncOriginal() }
        }
        body.addView(original, matchWidth())
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

    private fun sectionTitle(title: String): TextView =
        Ui.label(this, title, 14f, Ui.PANEL_TEXT, true).apply {
            setPadding(0, dp(4), 0, dp(8))
        }

    private fun textField(hint: String, minLines: Int, maxLines: Int): EditText = EditText(this).apply {
        this.hint = hint
        setHintTextColor(0xFF7E7F8F.toInt())
        setTextColor(Ui.PANEL_TEXT)
        textSize = 14f
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        this.minLines = minLines
        this.maxLines = maxLines
        isVerticalScrollBarEnabled = true
        setPadding(dp(12), dp(10), dp(12), dp(10))
        background = Ui.inputBackground(this@EnhanceSelectionActivity)
    }

    private fun EditText.onChanged(action: () -> Unit) {
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(text: Editable?) = action()
        })
    }

    private fun smallButton(text: String, onClick: () -> Unit): Button =
        Ui.quietButton(this, text) { onClick() }.apply {
            textSize = 12f
            minHeight = dp(36)
            setPadding(dp(12), dp(4), dp(12), dp(4))
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
        // 상황은 기본으로 접어 둔다. 고르면 접힌 버튼에 고른 상황이 보인다.
        situationToggle = Ui.quietButton(this@EnhanceSelectionActivity, "") { setSituationOpen(situationSection.visibility != View.VISIBLE) }.apply {
            textSize = 13f
            minHeight = dp(42)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        addView(situationToggle, matchWidth())
        situationSection = LinearLayout(this@EnhanceSelectionActivity).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, dp(10), 0, 0)
        }
        situationChips = FlowLayout(this@EnhanceSelectionActivity).apply {
            horizontalGap = dp(6)
            verticalGap = dp(6)
        }
        situationSection.addView(situationChips, matchWidth())
        situationInput = textField("직접 입력 · 예: 친구에게 보내는 생일 축하", minLines = 1, maxLines = 3).apply {
            contentDescription = "상황 직접 입력"
            onChanged { syncSituation() }
        }
        situationSection.addView(situationInput, matchWidth().apply { topMargin = dp(10) })
        val tools = FlowLayout(this@EnhanceSelectionActivity).apply {
            horizontalGap = dp(6)
            verticalGap = dp(6)
        }
        saveSituationButton = smallButton("＋ 버튼으로 저장") { saveCurrentSituation() }.apply {
            contentDescription = "지금 쓴 상황을 다음에도 누를 수 있게 버튼으로 저장"
        }
        editSituationButton = smallButton("버튼 편집") { setEditing(!editingPresets) }.apply {
            contentDescription = "필요 없는 상황 버튼 지우기"
        }
        resetSituationButton = smallButton("기본값으로") { resetPresets() }.apply {
            contentDescription = "상황 버튼을 처음 목록으로 되돌리기"
        }
        for (button in listOf(saveSituationButton, editSituationButton, resetSituationButton)) {
            tools.addView(button, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)))
        }
        situationSection.addView(tools, matchWidth().apply { topMargin = dp(8) })
        editHint = Ui.label(this@EnhanceSelectionActivity, "지울 버튼을 누르세요. 새 버튼은 위 칸에 상황을 쓰고 [＋ 버튼으로 저장]을 눌러요.", 12f, Ui.PANEL_MUTED).apply {
            setPadding(dp(2), dp(8), 0, 0)
            visibility = View.GONE
        }
        situationSection.addView(editHint)
        addView(situationSection, matchWidth())
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

    // ── 선택한 글 ───────────────────────────────────────────

    private fun currentInput(): String = SelectionTextPolicy.enhanceInput(original.text).orEmpty()

    private fun syncOriginal() {
        originalLabel.text = SelectionTextPolicy.originalLabel(currentInput().length)
        if (::actions.isInitialized && options.visibility == View.VISIBLE && actions.childCount > 0) {
            actions.getChildAt(0).isEnabled = currentInput().isNotEmpty()
        }
    }

    // ── 강화 단계 ───────────────────────────────────────────

    private fun setLevel(value: Int) {
        level = EnhancementLevelPolicy.normalize(value)
        levelButtons.forEachIndexed { index, button ->
            val selected = index + EnhancementLevelPolicy.MIN == level
            button.background = Ui.interactive(this, if (selected) Ui.ACCENT else Ui.PANEL_FIELD, 12)
            button.setTextColor(if (selected) Color.WHITE else Ui.PANEL_TEXT)
            button.isSelected = selected
        }
        levelHint.text = SelectionTextPolicy.levelHint(level)
        preferences.edit().putInt(KEY_LEVEL, level).apply()
    }

    // ── 상황(접어 두고, 버튼은 사용자가 고친다) ─────────────

    private fun currentSituation(): String =
        SituationPresetPolicy.clean(situationInput.text.toString(), SharedWritingRules.MAX_SITUATION_TEXT)

    private fun loadPresets() {
        val stored = SituationPresetPolicy.decode(preferences.getString(KEY_SITUATIONS, null))
        customizedPresets = stored != null
        presets = stored ?: SituationPresetPolicy.defaults()
    }

    private fun savePresets(list: List<SituationPresetPolicy.Preset>?) {
        if (list == null) {
            preferences.edit().remove(KEY_SITUATIONS).apply()
        } else {
            preferences.edit().putString(KEY_SITUATIONS, SituationPresetPolicy.encode(SituationPresetPolicy.normalize(list))).apply()
        }
        loadPresets()
        renderChips()
    }

    private fun setSituationOpen(open: Boolean) {
        situationSection.visibility = if (open) View.VISIBLE else View.GONE
        if (!open && editingPresets) setEditing(false)
        renderSituationToggle()
    }

    private fun renderSituationToggle() {
        val open = situationSection.visibility == View.VISIBLE
        val value = currentSituation()
        situationToggle.text = SelectionTextPolicy.situationToggleLabel(open, value)
        situationToggle.contentDescription = if (value.isEmpty()) "상황 고르기" else "상황: $value"
        situationToggle.setTextColor(if (open || value.isNotEmpty()) Ui.ACCENT_TEXT else Ui.PANEL_TEXT)
    }

    private fun renderChips() {
        situationChips.removeAllViews()
        val value = currentSituation()
        for (preset in presets) {
            val chosen = !editingPresets && preset.text == value
            val chip = Ui.quietButton(this, if (editingPresets) "${preset.label} ×" else preset.label) {
                if (editingPresets) {
                    removePreset(preset)
                } else {
                    situationInput.setText(SelectionTextPolicy.toggleSituation(situationInput.text.toString(), preset.text))
                    situationInput.setSelection(situationInput.text.length)
                }
            }.apply {
                textSize = 13f
                minHeight = dp(38)
                setPadding(dp(13), dp(6), dp(13), dp(6))
                contentDescription = if (editingPresets) "${preset.text} 버튼 지우기" else "상황: ${preset.text}"
                background = Ui.interactive(
                    this@EnhanceSelectionActivity,
                    if (chosen) Ui.ACCENT_SURFACE else Ui.PANEL_FIELD,
                    19,
                )
                setTextColor(
                    when {
                        editingPresets -> 0xFFFF9DAE.toInt()
                        chosen -> Ui.ACCENT_TEXT
                        else -> Ui.PANEL_TEXT
                    },
                )
                isSelected = chosen
            }
            situationChips.addView(chip, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)))
        }
        if (presets.isEmpty()) {
            situationChips.addView(
                Ui.label(this, "저장한 상황 버튼이 없어요. 아래 칸에 상황을 쓰고 저장해 보세요.", 12f, Ui.PANEL_MUTED),
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
        }
        renderSituationTools()
    }

    private fun renderSituationTools() {
        val value = currentSituation()
        val saved = presets.any { it.text == value }
        val full = presets.size >= SharedWritingRules.MAX_SITUATIONS
        saveSituationButton.isEnabled = value.isNotEmpty() && !saved && !full
        saveSituationButton.alpha = if (saveSituationButton.isEnabled) 1f else 0.45f
        editSituationButton.text = if (editingPresets) "편집 끝내기" else "버튼 편집"
        editSituationButton.setTextColor(if (editingPresets) Ui.ACCENT_TEXT else Ui.PANEL_TEXT)
        resetSituationButton.visibility = if (editingPresets && customizedPresets) View.VISIBLE else View.GONE
        editHint.visibility = if (editingPresets) View.VISIBLE else View.GONE
    }

    private fun syncSituation() {
        renderChips()
        renderSituationToggle()
    }

    private fun setEditing(editing: Boolean) {
        editingPresets = editing
        renderChips()
    }

    private fun saveCurrentSituation() {
        val outcome = SituationPresetPolicy.add(presets, currentSituation())
        if (!outcome.added) {
            toast(
                when (outcome.reason) {
                    "empty" -> "버튼으로 저장할 상황을 먼저 써 주세요."
                    "duplicate" -> "이미 버튼으로 있는 상황이에요."
                    "full" -> "상황 버튼은 ${SharedWritingRules.MAX_SITUATIONS}개까지 둘 수 있어요. 편집에서 하나를 지워 주세요."
                    else -> "버튼으로 저장하지 못했어요."
                },
            )
            return
        }
        savePresets(outcome.list)
        toast("'${SituationPresetPolicy.labelFor(currentSituation())}' 상황 버튼을 저장했어요.")
    }

    private fun removePreset(preset: SituationPresetPolicy.Preset) {
        savePresets(SituationPresetPolicy.remove(presets, preset.text))
        toast("'${preset.label}' 버튼을 지웠어요.")
    }

    private fun resetPresets() {
        savePresets(null)
        toast("상황 버튼을 처음 목록으로 되돌렸어요.")
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    // ── 상태 ────────────────────────────────────────────────

    private fun showOptions() {
        request?.cancel(true)
        setStatus("강화 단계와 상황(선택)을 고른 뒤 강화하세요.")
        original.isEnabled = true
        options.visibility = View.VISIBLE
        progress.visibility = View.GONE
        resultBox.visibility = View.GONE
        setLevel(level)
        renderChips()
        renderSituationToggle()
        setButtons(actions, listOf(button("강화하기", primary = true) { start() }))
        setButtons(
            secondary,
            buildList {
                if (completed != null) add(button("결과로 돌아가기", primary = false) { showResult() })
                add(button("닫기", primary = false) { finish() })
            },
        )
        syncOriginal()
    }

    private fun start() {
        val text = currentInput()
        if (text.isEmpty()) {
            toast("강화할 글이 비어 있어요.")
            return
        }
        // 고친 글로 바꿨다면 앞 결과와 다른 기록으로 남긴다.
        if (text != input) {
            input = text
            historyId = null
            completed = null
        }
        val situation = currentSituation()
        val requestLevel = level
        setStatus("글 ${input.length}자를 강화하는 중…")
        original.isEnabled = false
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
        original.isEnabled = true
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
        toast("강화한 글을 복사했어요.")
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
        originalLabel.visibility = View.GONE
        original.visibility = View.GONE
        setStatus(message)
        setButtons(actions, emptyList())
        setButtons(secondary, listOf(button("닫기", primary = false) { finish() }))
    }

    private companion object {
        const val PREFERENCES = "selection_enhance"
        const val KEY_LEVEL = "level"
        const val KEY_SITUATIONS = "situations"
        const val ORIGINAL_MAX_LINES = 6
    }
}
