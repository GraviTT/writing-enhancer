package com.example.writingenhancer.overlay

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.text.Editable
import android.text.Selection
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.TextUtils
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.SuperscriptSpan
import android.text.style.TypefaceSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.example.writingenhancer.ai.AiClient
import com.example.writingenhancer.ai.AnswerStyle
import com.example.writingenhancer.ai.AttachmentRef
import com.example.writingenhancer.ai.ChatAnswer
import com.example.writingenhancer.ai.SearchFollowUpPolicy
import com.example.writingenhancer.ai.SharedSideChatRules
import com.example.writingenhancer.ai.SideChatAction
import com.example.writingenhancer.ai.SideChatCall
import com.example.writingenhancer.ai.SideChatDisplayPolicy
import com.example.writingenhancer.ai.SideChatMessage
import com.example.writingenhancer.ai.SideChatProgress
import com.example.writingenhancer.ai.SideChatRequest
import com.example.writingenhancer.ai.SideChatSearchPolicy
import com.example.writingenhancer.ai.SideChatWritingContext
import com.example.writingenhancer.ai.WebSource
import com.example.writingenhancer.data.SideChatPolicy
import com.example.writingenhancer.data.SideChatReplyDetails
import com.example.writingenhancer.data.SideChatStore
import com.example.writingenhancer.ui.ChatTextFormatter
import com.example.writingenhancer.ui.MobileLayoutProfile
import com.example.writingenhancer.ui.MobileUiPolicy
import com.example.writingenhancer.ui.PasteFriendlyEditText
import com.example.writingenhancer.ui.SideChatMessageAction
import com.example.writingenhancer.ui.Ui
import com.example.writingenhancer.ui.Ui.dp
import com.example.writingenhancer.ui.UiIcon
import com.example.writingenhancer.ui.WindowDragTouchListener

/**
 * 사이드 채팅 화면. 패널이 [Host]로 화면 틀·편집기·글 강화기 동작을 빌려 주고,
 * 대화 상태·AI 요청·스트리밍 표시·문장 출처 확인 창은 이 클래스가 맡는다.
 */
internal class SideChatScreen(
    private val context: Context,
    private val host: Host,
    private val store: SideChatStore,
    private val aiClient: AiClient,
) {
    interface Host {
        val content: LinearLayout
        val stickyActions: LinearLayout
        val headerHost: LinearLayout
        val scroll: ScrollView
        /** 출처 확인 창을 겹쳐 띄울 패널 최상위 틀. */
        val overlayRoot: FrameLayout
        val layoutProfile: MobileLayoutProfile
        val panelWidth: Int
        /** 패널이 열려 있고 채팅 화면을 보여 주는 중인지. */
        val showingChat: Boolean
        /** 이 패널이 아직 살아 있어 응답을 받아도 되는지. */
        val acceptsResponses: Boolean
        val keyboardVisible: Boolean

        fun focusedEditor(): EditText?

        /** 채팅 화면을 그리기 전에 패널 화면을 비우고 채팅 상태로 바꾼다. */
        fun beginChatSurface(keepKeyboard: Boolean)
        fun hideKeyboard()
        fun hideImeOnly()
        fun createEditor(
            hint: String,
            text: String,
            minRows: Int,
            maxRows: Int,
            textSizeSp: Float,
        ): PasteFriendlyEditText
        fun editMenuButton(field: PasteFriendlyEditText): View
        fun actionButton(text: String, color: Int): Button
        fun openSettings(anchor: View)
        fun collapse()
        fun movePanelBy(deltaX: Int, deltaY: Int)
        fun persistPanelGeometry()
        fun returnToWriting()
        fun writingContext(): SideChatWritingContext
        fun writingSummary(): String
        fun executeAction(action: SideChatAction)

        // 한 번만 쓰는 화면·이미지는 서비스가 보관한다. 브리지 결과가 패널이 닫힌 사이에 오기 때문이다.
        val pendingVisual: AttachmentRef?
        var visualNotice: String
        var retainedDraft: String
        fun takePendingVisual(): AttachmentRef?
        fun finishVisualRequest(attachment: AttachmentRef?)
        fun discardPendingVisual()
        fun discardActiveVisual()
        fun captureScreen()
        fun pickImage()
        fun previewVisual(visual: AttachmentRef)
    }

    private data class SourceDialogState(
        val sources: List<WebSource>,
        val options: List<Int>,
        val sentence: String,
        var selected: Int = 0,
    )

    /** 문장 출처 링크. 누르면 바로 열지 않고 출처 확인 창을 띄운다. */
    private class CitationSpan(
        private val color: Int,
        private val underline: Boolean,
        private val onTap: () -> Unit,
    ) : ClickableSpan() {
        override fun onClick(widget: View) = onTap()

        override fun updateDrawState(paint: TextPaint) {
            paint.color = color
            paint.isUnderlineText = underline
        }
    }

    /** 문장 뒤의 출처 번호. 복사할 때는 뺀다. */
    private class CitationMarkSpan

    var busy = false
        private set
    private var draft = host.retainedDraft
    private var pendingUser = ""
    private var editingMessageId = ""
    private var clearConfirmation = false
    private var error = ""
    // 다음 질문 한 번만 웹 검색을 강제한다.
    private var searchMode = false
    private var activeForceSearch = false
    private var progress: SideChatProgress? = null
    private var progressStartedAt = 0L
    private var progressLabel: TextView? = null
    // 검색·화면 자료가 섞인 대화에서 사용자 확인을 기다리는 채팅 제안 동작.
    private var pendingAction: SideChatAction? = null
    private var keepKeyboard = false
    // 지금 받고 있는 답변 글. 제어 블록은 이미 빠져 있다.
    private var streamText = ""
    private var streamBubble: TextView? = null
    private var input: PasteFriendlyEditText? = null
    private var call: SideChatCall? = null
    private var requestToken = 0L
    private var dialogState: SourceDialogState? = null
    private var dialogView: View? = null

    private val progressTicker = object : Runnable {
        override fun run() {
            if (!busy || !host.acceptsResponses) return
            progressLabel?.text = SideChatDisplayPolicy.progressLabel(
                progress,
                System.currentTimeMillis() - progressStartedAt,
            )
            host.overlayRoot.postDelayed(this, 1_000)
        }
    }

    private fun dp(value: Int): Int = context.dp(value)

    // ── 화면 전환 ──────────────────────────────────────────────

    /** 채팅 화면을 새로 열 때 지난 편집·확인 상태를 지운다. */
    fun open() {
        editingMessageId = ""
        clearConfirmation = false
        error = ""
        render()
    }

    /** 패널이 다른 화면을 그리기 전에 채팅 화면의 뷰 참조를 놓는다. */
    fun forgetViews() {
        input = null
        progressLabel = null
        streamBubble = null
    }

    fun syncDraft() {
        input?.let { draft = it.text?.toString().orEmpty() }
    }

    /** 글 강화기로 돌아가기 전에 편집·확인 상태와 일회성 이미지를 정리한다. */
    fun leave() {
        syncDraft()
        editingMessageId = ""
        clearConfirmation = false
        closeSourceDialog()
        host.discardPendingVisual()
        host.visualNotice = ""
        host.hideKeyboard()
    }

    /** 패널을 접을 때 진행 중인 답변을 멈추고 입력 중인 글은 다음에 이어 쓰게 남긴다. */
    fun prepareCollapse() {
        closeSourceDialog()
        if (busy || call?.isDone == false) {
            cancelCall()
            if (draft.isBlank()) draft = pendingUser
            pendingUser = ""
            error = ""
            host.discardActiveVisual()
        }
        host.retainedDraft = draft
        host.discardPendingVisual()
        host.visualNotice = ""
    }

    fun shutdown() {
        cancelCall()
    }

    /** 뒤로 가기를 채팅 화면이 처리했으면 true. */
    fun handleBack(editorActive: Boolean): Boolean {
        if (dialogState != null) {
            closeSourceDialog()
            return true
        }
        if (editorActive) return false
        return when {
            clearConfirmation -> {
                clearConfirmation = false
                render()
                true
            }
            editingMessageId.isNotBlank() -> {
                editingMessageId = ""
                render()
                true
            }
            else -> false
        }
    }

    fun showNotice(notice: String) {
        host.visualNotice = notice
        if (host.showingChat) render()
    }

    fun render() {
        val restoreKeyboard = keepKeyboard
        keepKeyboard = false
        host.beginChatSurface(restoreKeyboard)
        renderHeader()
        renderContext()

        if (error.isNotBlank()) {
            host.content.addView(
                Ui.label(context, error, 12f, 0xFFFF9B9B.toInt()).apply {
                    setPadding(dp(5), 0, dp(5), dp(9))
                },
            )
        }

        val messages = store.list()
        if (messages.isEmpty() && pendingUser.isBlank()) {
            host.content.addView(
                Ui.label(
                    context,
                    "검색부터 글 다듬기까지,\n필요한 것을 편하게 물어보세요.",
                    14f,
                    Ui.PANEL_MUTED,
                ).apply {
                    setPadding(dp(8), dp(20), dp(8), dp(20))
                    setLineSpacing(0f, 1.18f)
                },
            )
        } else {
            messages.forEach { renderMessage(it) }
            if (pendingUser.isNotBlank()) {
                renderMessage(
                    SideChatMessage(
                        id = "",
                        role = "user",
                        content = pendingUser,
                        createdAt = System.currentTimeMillis(),
                    ),
                    editable = false,
                )
            }
        }
        if (busy) {
            renderStreamingBubble()
            renderProgress()
        } else {
            pendingAction?.let(::renderPendingAction)
        }
        renderComposer()
        host.scroll.post { host.scroll.fullScroll(View.FOCUS_DOWN) }
        val root = host.overlayRoot
        if (restoreKeyboard) {
            focusInput(showKeyboard = true)
        } else {
            root.requestFocus()
            root.post {
                if (host.showingChat) {
                    root.requestFocus()
                    host.hideImeOnly()
                }
            }
        }
    }

    // ── 머리글·안내 ────────────────────────────────────────────

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun renderHeader() {
        val header = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(3), 0, 0, dp(10))
            contentDescription = "사이드 채팅 창 이동"
        }
        header.addView(
            Ui.label(context, "사이드 채팅", 18f, Ui.PANEL_TEXT, true).apply {
                maxLines = 1
                setAutoSizeTextTypeUniformWithConfiguration(10, 18, 1, TypedValue.COMPLEX_UNIT_SP)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        header.addView(
            Ui.iconButton(context, UiIcon.NEW, "새 사이드 채팅") { requestNewChat() }.apply {
                isEnabled = !busy
                alpha = if (busy) 0.34f else 1f
            },
            LinearLayout.LayoutParams(dp(44), dp(44)),
        )
        header.addView(
            Ui.quietButton(context, "글로") { host.returnToWriting() }.apply {
                contentDescription = "글 강화기로 돌아가기"
                maxLines = 1
                setPadding(dp(4), dp(4), dp(4), dp(4))
                setAutoSizeTextTypeUniformWithConfiguration(10, 13, 1, TypedValue.COMPLEX_UNIT_SP)
                setTextColor(Ui.ACCENT_TEXT)
                background = Ui.interactive(context, Ui.ACCENT_SURFACE)
            },
            LinearLayout.LayoutParams(dp(48), dp(44)),
        )
        header.addView(
            Ui.iconButton(context, UiIcon.SETTINGS, "설정") { host.openSettings(it) },
            LinearLayout.LayoutParams(dp(44), dp(44)),
        )
        header.addView(
            Ui.iconButton(context, UiIcon.CLOSE, "버블로 접기") { host.collapse() },
            LinearLayout.LayoutParams(dp(44), dp(44)),
        )
        header.setOnTouchListener(
            WindowDragTouchListener(
                view = header,
                onDelta = { deltaX, deltaY -> host.movePanelBy(deltaX, deltaY) },
                onFinished = { host.persistPanelGeometry() },
            ),
        )
        host.headerHost.addView(header)
    }

    private fun renderContext() {
        host.content.addView(
            Ui.label(context, host.writingSummary(), 11f, Ui.PANEL_MUTED).apply {
                setPadding(dp(4), dp(2), dp(4), dp(10))
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) },
        )
    }

    // ── 메시지 ─────────────────────────────────────────────────

    private fun bubbleWidth(isUser: Boolean, actionSpace: Int): Int {
        val available = host.panelWidth -
            dp(host.layoutProfile.horizontalPaddingDp * 2) - actionSpace - dp(5)
        return if (isUser) (available * 0.88f).toInt() else available
    }

    private fun renderMessage(message: SideChatMessage, editable: Boolean = true) {
        val isUser = message.role == "user"
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = if (isUser) Gravity.END else Gravity.START
            setPadding(0, dp(4), 0, dp(4))
        }
        if (isUser && editable && editingMessageId == message.id) {
            renderMessageEditor(row, message)
        } else {
            val messageAction = MobileUiPolicy.sideChatMessageAction(
                role = message.role,
                editable = editable,
                busy = busy,
                hasMessageId = message.id.isNotBlank(),
                hasContent = message.content.isNotBlank(),
            )
            val maximumWidth = bubbleWidth(
                isUser,
                if (messageAction != SideChatMessageAction.NONE) dp(44) else 0,
            )
            val bubble = messageBubble(maximumWidth, isUser).apply {
                if (isUser) {
                    text = message.content
                } else {
                    text = richAnswer(message)
                    setTextIsSelectable(true)
                    // 선택 복사를 유지하면서 문장 출처 링크도 누를 수 있게 한다.
                    if (message.citations.isNotEmpty()) movementMethod = LinkMovementMethod.getInstance()
                }
            }
            if (messageAction == SideChatMessageAction.EDIT_LEFT) {
                row.addView(
                    Ui.iconButton(context, UiIcon.EDIT, "이 메시지 수정") {
                        editingMessageId = message.id
                        clearConfirmation = false
                        render()
                    },
                    LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(5) },
                )
            }
            val stack = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.START
            }
            if (!isUser) categoryBadge(message)?.let { badge ->
                stack.addView(
                    badge,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { bottomMargin = dp(4) },
                )
            }
            stack.addView(
                bubble,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            if (!isUser && message.sourcesMissing) {
                stack.addView(
                    Ui.label(context, SideChatDisplayPolicy.SOURCES_MISSING_NOTE, 12f, 0xFFFFD58A.toInt())
                        .apply {
                            maxWidth = maximumWidth
                            setPadding(dp(10), dp(7), dp(10), dp(7))
                            setLineSpacing(dp(1).toFloat(), 1.15f)
                            background = Ui.rounded(0x33E0A23A, 10, context)
                        },
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(5) },
                )
            }
            if (!isUser && message.sources.isNotEmpty()) {
                stack.addView(renderSources(message.sources, maximumWidth))
            }
            if (!isUser && message.followUpQueries.isNotEmpty()) {
                stack.addView(renderFollowUps(message.followUpQueries, maximumWidth))
            }
            row.addView(
                stack,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            if (messageAction == SideChatMessageAction.COPY_RIGHT) {
                row.addView(
                    Ui.iconButton(context, UiIcon.COPY, "선택한 부분 또는 전체 AI 답변 복사") {
                        copyAnswer(bubble, message)
                    },
                    LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(5) },
                )
            }
        }
        host.content.addView(
            row,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
    }

    private fun messageBubble(maximumWidth: Int, isUser: Boolean): TextView =
        Ui.label(context, "", 15f, Ui.PANEL_TEXT).apply {
            maxWidth = maximumWidth
            setPadding(dp(14), dp(13), dp(14), dp(13))
            setLineSpacing(dp(2).toFloat(), 1.22f)
            background = Ui.rounded(if (isUser) Ui.ACCENT_SURFACE else Ui.PANEL_RAISED, 18, context)
        }

    private fun renderMessageEditor(row: LinearLayout, message: SideChatMessage) {
        val editorStack = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.END
        }
        val editor = host.createEditor(
            hint = "사용자 메시지 수정",
            text = message.content,
            minRows = 2,
            maxRows = host.layoutProfile.answerMaxRows,
            textSizeSp = 13f,
        )
        editorStack.addView(
            editor,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        val actions = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        actions.addView(
            Ui.quietButton(context, "취소") {
                editingMessageId = ""
                render()
            },
        )
        actions.addView(
            Ui.quietButton(context, "수정 완료") {
                editMessage(message.id, editor.text?.toString().orEmpty())
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38)).apply {
                marginStart = dp(6)
            },
        )
        editorStack.addView(
            actions,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(38)).apply {
                topMargin = dp(5)
            },
        )
        row.addView(
            editorStack,
            LinearLayout.LayoutParams(host.panelWidth * 4 / 5, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
    }

    /** 요청 분류 이름표: 앱 조작·웹 조사·질문 답변·글 상담. */
    private fun categoryBadge(message: SideChatMessage): View? {
        if (message.category.isEmpty()) return null
        val (surface, text) = when (message.category) {
            ChatAnswer.CATEGORY_COMMAND -> Ui.ACCENT_SURFACE to Ui.ACCENT_TEXT
            ChatAnswer.CATEGORY_RESEARCH -> 0xFF223A4F.toInt() to 0xFFB9DCFF.toInt()
            else -> Ui.PANEL_FIELD to Ui.PANEL_MUTED
        }
        return Ui.label(
            context,
            ChatAnswer.categoryLabel(message.category, message.sources.isNotEmpty()),
            11f,
            text,
            true,
        ).apply {
            setPadding(dp(8), dp(3), dp(8), dp(3))
            background = Ui.rounded(surface, 999, context)
        }
    }

    /** 답변 글에 굵게·코드 서식과 문장 출처 링크·번호를 입힌다. */
    private fun richAnswer(message: SideChatMessage): CharSequence {
        if (message.citations.isEmpty() && message.styles.isEmpty()) {
            // 이전 버전에서 저장한 답변은 서식 표시가 글에 남아 있을 수 있다.
            return ChatTextFormatter.render(message.content)
        }
        val builder = SpannableStringBuilder(message.content)
        message.styles.forEach { style ->
            val span = if (style.kind == AnswerStyle.CODE) TypefaceSpan("monospace") else StyleSpan(Typeface.BOLD)
            builder.setSpan(span, style.start, style.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        // 뒤에서부터 번호를 끼워 넣어 앞쪽 위치가 밀리지 않게 한다.
        message.citations.sortedByDescending { it.end }.forEach { citation ->
            val sentence = message.content.substring(citation.start, citation.end)
            val open = { openSourceDialog(message.sources, citation.sources, sentence) }
            builder.setSpan(
                CitationSpan(Ui.ACCENT_TEXT, underline = true, onTap = open),
                citation.start,
                citation.end,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
            val mark = citation.sources.joinToString(",") { (it + 1).toString() }
            val markEnd = citation.end + mark.length
            builder.insert(citation.end, mark)
            listOf(
                SuperscriptSpan(),
                RelativeSizeSpan(0.72f),
                CitationMarkSpan(),
                CitationSpan(Ui.ACCENT_TEXT, underline = false, onTap = open),
            ).forEach { builder.setSpan(it, citation.end, markEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        }
        return builder
    }

    private fun copyAnswer(view: TextView, message: SideChatMessage) {
        val shown = view.text
        val start = Selection.getSelectionStart(shown)
        val end = Selection.getSelectionEnd(shown)
        val selected = if (start >= 0 && end >= 0 && start != end) {
            val from = minOf(start, end)
            val to = maxOf(start, end)
            val marks = (shown as? Spanned)?.let { spanned ->
                spanned.getSpans(from, to, CitationMarkSpan::class.java)
                    .map { spanned.getSpanStart(it) until spanned.getSpanEnd(it) }
            }.orEmpty()
            buildString {
                for (index in from until to) if (marks.none { index in it }) append(shown[index])
            }
        } else {
            message.content
        }
        if (selected.isBlank()) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("AI 답변", selected))
        Toast.makeText(
            context,
            if (selected.length == message.content.length) "AI 답변을 복사했어요." else "선택한 부분을 복사했어요.",
            Toast.LENGTH_SHORT,
        ).show()
    }

    // ── 스트리밍·진행 ──────────────────────────────────────────

    private fun renderStreamingBubble() {
        streamBubble = null
        if (streamText.isEmpty()) return
        val bubble = messageBubble(bubbleWidth(isUser = false, actionSpace = 0), isUser = false).apply {
            contentDescription = "AI가 답변을 쓰는 중"
        }
        setStreamingText(bubble, streamText)
        streamBubble = bubble
        host.content.addView(
            LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.START
                setPadding(0, dp(4), 0, dp(4))
                addView(bubble)
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
    }

    private fun setStreamingText(view: TextView, text: String) {
        val shown = SpannableStringBuilder(ChatTextFormatter.render(text))
        val caretStart = shown.length
        shown.append(" ▍")
        shown.setSpan(
            ForegroundColorSpan(Ui.ACCENT_TEXT),
            caretStart,
            shown.length,
            Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        view.text = shown
    }

    // 지금까지 받은 글을 말풍선에 바로 이어 쓴다. 말풍선이 새로 생기거나 사라질 때만 화면을 다시 그린다.
    private fun onDelta(token: Long, text: String) {
        if (token != requestToken || !busy || !host.acceptsResponses) return
        streamText = text
        if (!host.showingChat) return
        val bubble = streamBubble
        if (bubble == null || text.isEmpty()) {
            if (bubble == null && text.isEmpty()) return
            keepKeyboard = host.focusedEditor() != null || host.keyboardVisible
            render()
            return
        }
        val scroll = host.scroll
        val nearBottom = (scroll.getChildAt(0)?.bottom ?: 0) - (scroll.height + scroll.scrollY) < dp(96)
        setStreamingText(bubble, text)
        if (nearBottom) scroll.post { scroll.scrollTo(0, scroll.getChildAt(0)?.bottom ?: 0) }
    }

    private fun renderProgress() {
        val label = Ui.label(
            context,
            SideChatDisplayPolicy.progressLabel(progress, System.currentTimeMillis() - progressStartedAt),
            13f,
            Ui.PANEL_MUTED,
            true,
        ).apply {
            setPadding(dp(14), dp(11), dp(14), dp(11))
            background = Ui.rounded(Ui.PANEL_RAISED, 18, context)
            contentDescription = "AI가 답변 중"
        }
        progressLabel = label
        host.content.addView(
            LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.START
                setPadding(0, dp(4), 0, dp(4))
                addView(label)
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
    }

    private fun startProgress() {
        progress = null
        progressStartedAt = System.currentTimeMillis()
        host.overlayRoot.removeCallbacks(progressTicker)
        host.overlayRoot.postDelayed(progressTicker, 1_000)
    }

    private fun stopProgress() {
        runCatching { host.overlayRoot.removeCallbacks(progressTicker) }
        progress = null
        progressStartedAt = 0L
        progressLabel = null
    }

    private fun cancelCall() {
        call?.cancel()
        call = null
        requestToken += 1
        busy = false
        streamText = ""
        stopProgress()
    }

    private fun stopReply() {
        if (!busy) return
        cancelCall()
        host.discardActiveVisual()
        if (pendingUser.isNotBlank()) {
            draft = pendingUser
            host.retainedDraft = pendingUser
        }
        searchMode = activeForceSearch
        pendingUser = ""
        error = ""
        host.visualNotice = SharedSideChatRules.CANCELLED
        render()
    }

    // ── 제안 적용 ──────────────────────────────────────────────

    private fun renderPendingAction(action: SideChatAction) {
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(13), dp(12), dp(13), dp(10))
            background = Ui.rounded(Ui.ACCENT_SURFACE, 16, context)
            contentDescription = "제안 적용 확인"
        }
        card.addView(Ui.label(context, SharedSideChatRules.PENDING_TITLE, 14f, Ui.PANEL_TEXT, true))
        card.addView(
            Ui.label(context, SideChatDisplayPolicy.pendingActionLabel(action), 13f, Ui.ACCENT_TEXT, true)
                .apply { setPadding(0, dp(5), 0, 0) },
        )
        SideChatDisplayPolicy.pendingActionPreview(action)?.let { preview ->
            card.addView(
                Ui.label(context, preview, 13f, Ui.PANEL_TEXT).apply {
                    setPadding(dp(10), dp(8), dp(10), dp(8))
                    setLineSpacing(dp(1).toFloat(), 1.18f)
                    maxLines = 8
                    ellipsize = TextUtils.TruncateAt.END
                    background = Ui.rounded(Ui.PANEL_FIELD, 10, context)
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(8) },
            )
        }
        card.addView(
            Ui.label(context, SharedSideChatRules.PENDING_NOTE, 11f, Ui.PANEL_MUTED).apply {
                setPadding(0, dp(8), 0, dp(8))
            },
        )
        val buttons = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        buttons.addView(
            Ui.quietButton(context, "취소") { dismissPendingAction() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)),
        )
        buttons.addView(
            host.actionButton("적용", Ui.ACCENT).apply {
                contentDescription = "제안한 변경 적용"
                setOnClickListener { applyPendingAction() }
            },
            LinearLayout.LayoutParams(dp(84), dp(44)).apply { marginStart = dp(6) },
        )
        card.addView(buttons, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)))
        host.content.addView(
            card,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(6)
                bottomMargin = dp(4)
            },
        )
    }

    private fun applyPendingAction() {
        val action = pendingAction ?: return
        if (busy) return
        pendingAction = null
        runAction(action)
        if (host.showingChat) render()
    }

    private fun dismissPendingAction() {
        if (pendingAction == null) return
        pendingAction = null
        host.visualNotice = SharedSideChatRules.PENDING_DISMISSED
        render()
    }

    // 글 강화기 동작은 다른 화면으로 넘어갈 수 있으므로 출처 확인 창을 먼저 닫는다.
    private fun runAction(action: SideChatAction) {
        if (action.name == SideChatAction.NONE) return
        closeSourceDialog()
        host.executeAction(action)
    }

    // ── 출처 ───────────────────────────────────────────────────

    private fun renderSources(sources: List<WebSource>, maximumWidth: Int): View {
        val shown = sources.take(SharedSideChatRules.WEB_SOURCES)
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(5), dp(2), 0)
            val details = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE
            }
            val closedText = "${SharedSideChatRules.SOURCES_HEADING} · 출처 ${shown.size}개  ▾"
            val openText = "${SharedSideChatRules.SOURCES_HEADING} · 출처 ${shown.size}개  ▴"
            val toggle = Ui.label(context, closedText, 12f, 0xFFD8D2F0.toInt(), true).apply {
                maxWidth = maximumWidth
                minHeight = dp(44)
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(9), dp(4), dp(9), dp(4))
                background = Ui.interactive(context, Color.TRANSPARENT)
                isClickable = true
                isFocusable = true
                contentDescription = "답변 출처 펼치기"
                setOnClickListener {
                    val opening = details.visibility != View.VISIBLE
                    details.visibility = if (opening) View.VISIBLE else View.GONE
                    text = if (opening) openText else closedText
                    contentDescription = if (opening) "답변 출처 접기" else "답변 출처 펼치기"
                }
            }
            addView(toggle, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)))
            shown.forEachIndexed { index, source ->
                val site = ChatAnswer.hostOf(source.url)
                details.addView(
                    Ui.label(
                        context,
                        buildString {
                            append("${index + 1}. ${source.title}")
                            if (site.isNotBlank()) append("\n$site")
                        },
                        12f,
                        if (source.cited) 0xFFE4DFFF.toInt() else 0xFFB4AECB.toInt(),
                        true,
                    ).apply {
                        maxWidth = maximumWidth
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                        minHeight = dp(48)
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(9), dp(4), dp(9), dp(4))
                        background = Ui.rounded(0x243E2B72, 9, context)
                        contentDescription = "출처 ${index + 1} 확인: ${source.title}"
                        isClickable = true
                        isFocusable = true
                        setOnClickListener { openSourceDialog(sources, listOf(index), "") }
                    },
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(3) },
                )
            }
            addView(
                details,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
    }

    // 출처 링크를 누르면 바로 열지 않고, 자료 설명과 확인·취소를 먼저 보여 준다.
    private fun openSourceDialog(sources: List<WebSource>, indices: List<Int>, sentence: String) {
        val options = indices.filter { sources.getOrNull(it)?.url?.isNotBlank() == true }
        if (options.isEmpty()) return
        host.hideKeyboard()
        dialogState = SourceDialogState(sources, options, sentence)
        renderSourceDialog()
    }

    private fun renderSourceDialog() {
        val state = dialogState ?: return
        dialogView?.let { host.overlayRoot.removeView(it) }
        val source = state.sources[state.options[state.selected]]
        val site = ChatAnswer.hostOf(source.url)

        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(12))
            background = Ui.rounded(Ui.PANEL_RAISED, 18, context, Ui.PANEL_STROKE)
            isClickable = true
            contentDescription = SharedSideChatRules.SOURCE_DIALOG_TITLE
        }
        fun add(view: View, topMargin: Int) = card.addView(
            view,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { this.topMargin = dp(topMargin) },
        )
        card.addView(Ui.label(context, SharedSideChatRules.SOURCE_DIALOG_TITLE, 16f, Ui.PANEL_TEXT, true))
        add(
            Ui.label(
                context,
                if (state.sentence.isNotEmpty()) {
                    SharedSideChatRules.SOURCE_DIALOG_SENTENCE_INTRO
                } else {
                    SharedSideChatRules.SOURCE_DIALOG_LIST_INTRO
                },
                13f,
                Ui.PANEL_MUTED,
            ),
            8,
        )
        if (state.sentence.isNotEmpty()) {
            val quote = if (state.sentence.length > 180) state.sentence.take(180) + "…" else state.sentence
            add(
                Ui.label(context, quote, 13f, Ui.PANEL_TEXT).apply {
                    setPadding(dp(12), dp(9), dp(12), dp(9))
                    setLineSpacing(dp(1).toFloat(), 1.18f)
                    background = Ui.rounded(Ui.PANEL_FIELD, 10, context)
                },
                8,
            )
        }
        if (state.options.size > 1) {
            val choices = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
            state.options.forEachIndexed { position, index ->
                val option = state.sources[index]
                val chosen = position == state.selected
                choices.addView(
                    Ui.quietButton(context, "${index + 1}. ${option.title.ifBlank { ChatAnswer.hostOf(option.url) }}") {
                        state.selected = position
                        renderSourceDialog()
                    }.apply {
                        maxLines = 1
                        maxWidth = dp(200)
                        ellipsize = TextUtils.TruncateAt.END
                        if (chosen) {
                            setTextColor(Ui.ACCENT_TEXT)
                            background = Ui.interactive(context, Ui.ACCENT_SURFACE, 12)
                        }
                        contentDescription = "출처 ${index + 1} 고르기" + if (chosen) " (선택됨)" else ""
                    },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)).apply {
                        marginEnd = dp(6)
                    },
                )
            }
            add(
                HorizontalScrollView(context).apply {
                    isHorizontalScrollBarEnabled = false
                    addView(choices)
                },
                10,
            )
        }
        fun detail(term: String, value: String, maxLines: Int = 2) {
            if (value.isBlank()) return
            add(Ui.label(context, term, 11f, Ui.PANEL_MUTED, true), 10)
            add(
                Ui.label(context, value, 13f, Ui.PANEL_TEXT).apply {
                    this.maxLines = maxLines
                    ellipsize = TextUtils.TruncateAt.END
                },
                3,
            )
        }
        detail(
            SharedSideChatRules.SOURCE_DIALOG_SITE,
            if (source.title.isNotBlank() && source.title != site) "${source.title} · $site" else site,
        )
        detail(SharedSideChatRules.SOURCE_DIALOG_ADDRESS, source.url, maxLines = 3)
        detail(SharedSideChatRules.SOURCE_DIALOG_QUERY, source.query)
        if (site == "vertexaisearch.cloud.google.com") {
            add(Ui.label(context, SharedSideChatRules.SOURCE_DIALOG_REDIRECT_NOTE, 11f, Ui.PANEL_MUTED), 10)
        }
        add(Ui.label(context, SharedSideChatRules.SOURCE_DIALOG_OPEN_NOTE, 11f, Ui.PANEL_MUTED), 10)

        val buttons = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        buttons.addView(
            Ui.quietButton(context, SharedSideChatRules.SOURCE_DIALOG_CANCEL) { closeSourceDialog() },
            LinearLayout.LayoutParams(dp(76), dp(44)),
        )
        val confirm = host.actionButton(SharedSideChatRules.SOURCE_DIALOG_CONFIRM, Ui.ACCENT).apply {
            contentDescription = "이 출처를 브라우저에서 열기"
            setOnClickListener { confirmSourceDialog() }
        }
        buttons.addView(confirm, LinearLayout.LayoutParams(dp(84), dp(44)).apply { marginStart = dp(6) })
        add(buttons, 14)

        val scrim = FrameLayout(context).apply {
            setBackgroundColor(0x99000000.toInt())
            isClickable = true
            setOnClickListener { closeSourceDialog() }
            addView(
                ScrollView(context).apply {
                    isFillViewport = false
                    addView(card)
                },
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER,
                ).apply { setMargins(dp(16), dp(16), dp(16), dp(16)) },
            )
        }
        host.overlayRoot.addView(
            scrim,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        dialogView = scrim
        confirm.post { confirm.requestFocus() }
    }

    private fun closeSourceDialog() {
        dialogView?.let { view -> runCatching { host.overlayRoot.removeView(view) } }
        dialogView = null
        dialogState = null
    }

    private fun confirmSourceDialog() {
        val state = dialogState ?: return
        val source = state.sources[state.options[state.selected]]
        closeSourceDialog()
        openSource(source)
    }

    private fun openSource(source: WebSource) {
        val uri = runCatching { Uri.parse(source.url) }.getOrNull()
        if (uri == null || uri.scheme !in setOf("https", "http")) {
            Toast.makeText(context, "출처 링크를 열지 못했어요.", Toast.LENGTH_SHORT).show()
            return
        }
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure {
            Toast.makeText(context, "출처 링크를 열 수 있는 앱이 없어요.", Toast.LENGTH_SHORT).show()
        }
    }

    // ── 후속 질문 ──────────────────────────────────────────────

    private fun renderFollowUps(queries: List<String>, maximumWidth: Int): View =
        LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(7), dp(2), 0)
            addView(Ui.label(context, "이어서 탐색", 10f, 0xFFAAA3BC.toInt(), true))
            val chipRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
            queries.take(SharedSideChatRules.RELATED_QUERIES).forEach { query ->
                chipRow.addView(
                    Ui.label(context, "› $query", 12f, 0xFFE4DFFF.toInt(), true).apply {
                        maxWidth = (maximumWidth * 4 / 5).coerceAtLeast(dp(140))
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                        minHeight = dp(48)
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(8), dp(7), dp(8), dp(7))
                        background = Ui.interactive(context, Ui.PANEL_RAISED, 12)
                        contentDescription = "후속 검색 바로 실행: $query"
                        isClickable = true
                        isFocusable = true
                        setOnClickListener { applyFollowUp(query) }
                    },
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { marginEnd = dp(5) },
                )
            }
            addView(
                HorizontalScrollView(context).apply {
                    isHorizontalScrollBarEnabled = false
                    isFillViewport = false
                    addView(chipRow)
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(3) },
            )
        }

    private fun applyFollowUp(query: String) {
        if (!SideChatSearchPolicy.canSubmitFollowUp(query, busy, clearConfirmation)) return
        val normalized = SearchFollowUpPolicy.normalize(listOf(query)).first()
        draft = normalized
        input?.apply {
            setText(normalized)
            setSelection(normalized.length)
        }
        error = ""
        keepKeyboard = false
        sendMessage(restoreKeyboardOverride = false, forceSearch = true)
    }

    // ── 입력 영역 ──────────────────────────────────────────────

    private fun renderVisualPreview(visual: AttachmentRef) {
        val previewCard = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(7), dp(7), dp(7), dp(6))
            background = Ui.rounded(0x333E2B72, 12, context)
        }
        previewCard.addView(
            ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                adjustViewBounds = false
                contentDescription = "검색 전 이미지 미리보기 · 영역 선택 열기"
                background = Ui.rounded(0xFF24232B.toInt(), 10, context)
                decodeVisualPreview(visual.path)?.let(::setImageBitmap)
                setOnClickListener { previewVisual(visual) }
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(104)),
        )
        val actions = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(
                Ui.label(context, visual.displayName, 10f, 0xFFD8D2F0.toInt(), true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            addView(
                Ui.quietButton(context, "영역 선택") { previewVisual(visual) }.apply {
                    contentDescription = "이미지 부분 영역 선택"
                },
            )
            addView(
                Ui.quietButton(context, "×") {
                    host.discardPendingVisual()
                    host.visualNotice = "이미지 사용을 해제했어요."
                    render()
                }.apply { contentDescription = "검색 이미지 제거" },
                LinearLayout.LayoutParams(dp(42), dp(38)).apply { marginStart = dp(4) },
            )
        }
        previewCard.addView(
            actions,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(4) },
        )
        host.stickyActions.addView(
            previewCard,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(6) },
        )
    }

    private fun toolButton(text: String, description: String, onClick: () -> Unit): Button =
        Ui.quietButton(context, text) { onClick() }.apply {
            isEnabled = !busy && !clearConfirmation
            alpha = if (isEnabled) 1f else 0.4f
            contentDescription = description
        }

    private fun renderComposer() {
        host.pendingVisual?.let(::renderVisualPreview)
        val tools = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        tools.addView(
            toolButton("▣ 화면", "현재 화면 한 장을 촬영해 다음 질문에 함께 보내기") { captureScreen() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)),
        )
        tools.addView(
            toolButton("▧ 이미지", "질문에 함께 보낼 이미지 파일 첨부") { pickImage() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply { marginStart = dp(5) },
        )
        tools.addView(
            toolButton(
                if (searchMode) "⌕ 검색 켬" else "⌕ 검색",
                if (searchMode) "다음 질문 웹 검색 켜짐. 누르면 끕니다" else "다음 질문을 웹에서 검색",
            ) { toggleSearchMode() }.apply {
                if (searchMode) {
                    setTextColor(Ui.ACCENT_TEXT)
                    background = Ui.interactive(context, Ui.ACCENT_SURFACE, 12)
                }
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply { marginStart = dp(5) },
        )
        val notice = host.visualNotice
        if (notice.isNotBlank()) {
            tools.addView(
                Ui.label(
                    context,
                    notice,
                    10f,
                    if (notice.startsWith("화면을 가져오지")) 0xFFFF9B9B.toInt() else Ui.PANEL_MUTED,
                ).apply {
                    maxLines = 2
                    ellipsize = TextUtils.TruncateAt.END
                    setPadding(dp(7), 0, 0, 0)
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
        }
        host.stickyActions.addView(
            tools,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(5) },
        )
        val field = host.createEditor(
            hint = "사이드 채팅에 입력",
            text = draft,
            minRows = 1,
            maxRows = host.layoutProfile.answerMaxRows,
            textSizeSp = 15f,
        ).apply {
            isEnabled = !busy && !clearConfirmation
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    sendMessage()
                    true
                } else {
                    false
                }
            }
            addTextChangedListener(
                object : TextWatcher {
                    override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit

                    override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {
                        draft = text?.toString().orEmpty()
                    }

                    override fun afterTextChanged(editable: Editable?) = Unit
                },
            )
        }
        input = field
        tools.addView(
            host.editMenuButton(field).apply { contentDescription = "사이드 채팅 편집 메뉴" },
            2,
            LinearLayout.LayoutParams(dp(48), dp(48)).apply { marginStart = dp(5) },
        )
        host.stickyActions.addView(
            field,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        if (clearConfirmation) {
            host.stickyActions.addView(
                Ui.label(context, "현재 사이드 채팅 대화만 지울까요?", 12f, Ui.PANEL_MUTED).apply {
                    setPadding(dp(4), dp(7), 0, dp(4))
                },
            )
        }
        val actionHeight = dp(host.layoutProfile.actionHeightDp)
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        if (clearConfirmation) {
            row.addView(
                host.actionButton("취소", Ui.PANEL_FIELD).apply {
                    setOnClickListener {
                        clearConfirmation = false
                        render()
                    }
                },
                LinearLayout.LayoutParams(0, actionHeight, 1f),
            )
            row.addView(
                host.actionButton("지우기", 0xFF7C3844.toInt()).apply { setOnClickListener { clearChat() } },
                LinearLayout.LayoutParams(0, actionHeight, 1f).apply { marginStart = dp(6) },
            )
        } else {
            row.addView(
                host.actionButton(
                    if (busy) "중단" else "보내기",
                    if (busy) 0xFF3A3550.toInt() else Ui.ACCENT,
                ).apply {
                    contentDescription = if (busy) "답변 중단" else "메시지 보내기"
                    setOnClickListener { if (busy) stopReply() else sendMessage() }
                },
                LinearLayout.LayoutParams(0, actionHeight, 1f),
            )
        }
        host.stickyActions.addView(
            row,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, actionHeight).apply { topMargin = dp(6) },
        )
    }

    private fun toggleSearchMode() {
        if (busy || clearConfirmation) return
        syncDraft()
        searchMode = !searchMode
        host.visualNotice = if (searchMode) SharedSideChatRules.SEARCH_MODE_ON else SharedSideChatRules.SEARCH_MODE_OFF
        keepKeyboard = host.focusedEditor() === input || host.keyboardVisible
        render()
    }

    private fun captureScreen() {
        if (busy || clearConfirmation) return
        syncDraft()
        host.visualNotice = "화면 공유 권한을 확인하는 중…"
        host.captureScreen()
    }

    private fun pickImage() {
        if (busy || clearConfirmation) return
        syncDraft()
        host.visualNotice = "이미지 선택기를 여는 중…"
        host.pickImage()
    }

    private fun previewVisual(visual: AttachmentRef) {
        if (busy) return
        syncDraft()
        host.hideKeyboard()
        host.previewVisual(visual)
    }

    private fun decodeVisualPreview(path: String): android.graphics.Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > 720 || bounds.outHeight / sample > 720) sample *= 2
        return runCatching {
            BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
        }.getOrNull()
    }

    private fun focusInput(showKeyboard: Boolean) {
        val field = input ?: return
        field.post {
            if (!host.showingChat) return@post
            field.requestFocus()
            field.setSelection(field.text?.length ?: 0)
            if (showKeyboard) {
                (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                    .showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    // ── 보내기·수정·지우기 ─────────────────────────────────────

    private fun sendMessage(restoreKeyboardOverride: Boolean? = null, forceSearch: Boolean = false) {
        if (busy || call?.isDone == false) return
        syncDraft()
        val inputText = SideChatPolicy.clean("user", draft)
        if (inputText.isBlank()) {
            error = "메시지를 먼저 입력해 주세요."
            render()
            return
        }
        val previous = store.list()
        val restoreKeyboard = restoreKeyboardOverride
            ?: (host.focusedEditor() === input || host.keyboardVisible)
        val screenContext = host.takePendingVisual()
        val requestForceSearch = forceSearch || searchMode
        searchMode = false
        pendingAction = null
        draft = ""
        pendingUser = inputText
        error = ""
        busy = true
        streamText = ""
        keepKeyboard = restoreKeyboard
        render()
        request(
            inputText = inputText,
            previousMessages = previous,
            editedMessageAlreadyStored = false,
            restoreKeyboard = restoreKeyboard,
            screenContext = screenContext,
            forceSearch = requestForceSearch,
        )
    }

    private fun editMessage(messageId: String, text: String) {
        if (busy || call?.isDone == false) return
        val cleaned = SideChatPolicy.clean("user", text)
        if (cleaned.isBlank()) {
            error = "수정할 메시지를 입력해 주세요."
            render()
            return
        }
        val rewritten = store.rewriteFromUser(messageId, cleaned)
        if (rewritten == null) {
            editingMessageId = ""
            error = "수정할 메시지를 찾지 못했어요."
            render()
            return
        }
        val restoreKeyboard = host.focusedEditor() != null || host.keyboardVisible
        val screenContext = host.takePendingVisual()
        pendingAction = null
        editingMessageId = ""
        pendingUser = ""
        error = ""
        busy = true
        streamText = ""
        keepKeyboard = restoreKeyboard
        render()
        request(
            inputText = cleaned,
            previousMessages = rewritten.dropLast(1),
            editedMessageAlreadyStored = true,
            restoreKeyboard = restoreKeyboard,
            screenContext = screenContext,
        )
    }

    private fun request(
        inputText: String,
        previousMessages: List<SideChatMessage>,
        editedMessageAlreadyStored: Boolean,
        restoreKeyboard: Boolean,
        screenContext: AttachmentRef?,
        forceSearch: Boolean = false,
    ) {
        val token = ++requestToken
        activeForceSearch = forceSearch
        startProgress()
        call = aiClient.chat(
            SideChatRequest(
                input = inputText,
                messages = previousMessages,
                writingContext = host.writingContext(),
                screenContext = screenContext,
                forceSearch = forceSearch,
            ),
            onProgress = { update ->
                if (token == requestToken && busy && host.acceptsResponses) {
                    progress = update
                    progressLabel?.text = SideChatDisplayPolicy.progressLabel(
                        update,
                        System.currentTimeMillis() - progressStartedAt,
                    )
                }
            },
            onDelta = { text -> onDelta(token, text) },
        ) { result ->
            // 화면 임시 파일은 응답이 늦게 도착하거나 무시되더라도 항상 삭제한다.
            host.finishVisualRequest(screenContext)
            if (!host.acceptsResponses || token != requestToken) return@chat
            busy = false
            streamText = ""
            stopProgress()
            result.fold(
                onSuccess = { response ->
                    val details = SideChatReplyDetails.from(response)
                    if (editedMessageAlreadyStored) {
                        store.appendAssistant(response.reply, details)
                    } else {
                        store.appendExchange(inputText, response.reply, details)
                    }
                    pendingUser = ""
                    draft = ""
                    host.retainedDraft = ""
                    error = ""
                    val action = response.action
                    // AI 계층의 판단에 더해 UI 실행 경계에서도 외부 자료 여부를 다시 확인한다.
                    val needsConfirmation = response.actionRequiresConfirmation ||
                        SideChatSearchPolicy.requiresConfirmation(
                            action,
                            SideChatSearchPolicy.isExternallyGrounded(
                                screenContext,
                                response.sources,
                                response.usedWebSearch,
                                response.untrustedExternalContext,
                            ),
                        )
                    pendingAction = action.takeIf { needsConfirmation && it.name != SideChatAction.NONE }
                    if (host.showingChat) {
                        keepKeyboard = restoreKeyboard && pendingAction == null
                        render()
                    }
                    if (!needsConfirmation) runAction(action)
                },
                onFailure = { failure ->
                    pendingUser = ""
                    if (!editedMessageAlreadyStored) {
                        draft = inputText
                        host.retainedDraft = inputText
                    }
                    searchMode = forceSearch
                    error = failure.message?.take(180) ?: "채팅 답변을 가져오지 못했어요."
                    if (host.showingChat) {
                        keepKeyboard = restoreKeyboard
                        render()
                    } else {
                        Toast.makeText(context, error, Toast.LENGTH_SHORT).show()
                    }
                },
            )
        }
    }

    private fun requestNewChat() {
        if (busy) return
        if (store.list().isEmpty()) {
            clearChat()
        } else {
            clearConfirmation = true
            render()
        }
    }

    private fun clearChat() {
        if (busy) return
        val restoreKeyboard = host.focusedEditor() === input || host.keyboardVisible
        store.clear()
        host.discardPendingVisual()
        pendingAction = null
        searchMode = false
        host.visualNotice = ""
        draft = ""
        host.retainedDraft = ""
        pendingUser = ""
        editingMessageId = ""
        clearConfirmation = false
        error = ""
        keepKeyboard = restoreKeyboard
        render()
    }
}
