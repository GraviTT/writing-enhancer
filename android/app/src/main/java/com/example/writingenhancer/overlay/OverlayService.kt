package com.example.writingenhancer.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.BitmapFactory
import android.graphics.PixelFormat
import android.graphics.Point
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import com.example.writingenhancer.MainActivity
import com.example.writingenhancer.ai.AiClient
import com.example.writingenhancer.ai.AttachmentPolicy
import com.example.writingenhancer.ai.AttachmentRef
import com.example.writingenhancer.ai.EnhancementLevelPolicy
import com.example.writingenhancer.ai.EnhancementRequest
import com.example.writingenhancer.ai.EnhancementResult
import com.example.writingenhancer.ai.FollowUpMode
import com.example.writingenhancer.ai.SearchFollowUpPolicy
import com.example.writingenhancer.ai.SideChatAction
import com.example.writingenhancer.ai.SideChatCall
import com.example.writingenhancer.ai.SideChatDisplayPolicy
import com.example.writingenhancer.ai.SideChatMessage
import com.example.writingenhancer.ai.SideChatProgress
import com.example.writingenhancer.ai.SideChatRequest
import com.example.writingenhancer.ai.SideChatSearchPolicy
import com.example.writingenhancer.ai.SideChatWritingContext
import com.example.writingenhancer.ai.SharedSideChatRules
import com.example.writingenhancer.ai.WebSource
import com.example.writingenhancer.capture.BridgeActivity
import com.example.writingenhancer.capture.ImageCropActivity
import com.example.writingenhancer.data.DraftState
import com.example.writingenhancer.data.HistoryEntry
import com.example.writingenhancer.data.ResultVersion
import com.example.writingenhancer.data.SideChatPolicy
import com.example.writingenhancer.data.SideChatStore
import com.example.writingenhancer.data.WorkspacePolicy
import com.example.writingenhancer.data.WorkspaceStore
import com.example.writingenhancer.memory.MemoryChange
import com.example.writingenhancer.memory.MemoryCandidate
import com.example.writingenhancer.memory.MemoryStore
import com.example.writingenhancer.preferences.AppPreferences
import com.example.writingenhancer.security.SecureStore
import com.example.writingenhancer.ui.SettingsPanel
import com.example.writingenhancer.ui.SideChatMessageAction
import com.example.writingenhancer.ui.EditorOutsideAction
import com.example.writingenhancer.ui.InlineEditMenuController
import com.example.writingenhancer.ui.MobileEditorRole
import com.example.writingenhancer.ui.MobileUiPolicy
import com.example.writingenhancer.ui.PanelNavigationAction
import com.example.writingenhancer.ui.PanelScreenState
import com.example.writingenhancer.ui.PanelSurface
import com.example.writingenhancer.ui.PasteFriendlyEditText
import com.example.writingenhancer.ui.Ui
import com.example.writingenhancer.ui.UiIcon
import com.example.writingenhancer.ui.UiIconDrawable
import com.example.writingenhancer.ui.ChatTextFormatter
import com.example.writingenhancer.ui.Ui.dp
import com.example.writingenhancer.ui.WindowDragTouchListener
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Future
import kotlin.math.abs
import kotlin.math.roundToInt

class OverlayService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var secureStore: SecureStore
    private lateinit var memoryStore: MemoryStore
    private lateinit var workspaceStore: WorkspaceStore
    private lateinit var sideChatStore: SideChatStore
    private lateinit var preferences: AppPreferences
    private lateinit var aiClient: AiClient

    private var bubble: TextView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var removeTarget: TextView? = null
    private var panel: PanelController? = null
    private var request: Future<*>? = null
    private var chatRequest: SideChatCall? = null
    // 중단·접기 뒤에 늦게 도착한 채팅 응답을 무시하기 위한 요청 번호.
    private var chatRequestToken = 0L
    private var requestSequence = 0L
    private var activeRequestId = 0L
    private var stopping = false
    private var bridgeInProgress = false
    private var lastPanelSurface = PanelSurface.WRITING
    private var pendingChatScreen: AttachmentRef? = null
    private var activeChatScreen: AttachmentRef? = null
    private var chatScreenNotice = ""
    private var retainedChatDraft = ""
    private val mainHandler = Handler(Looper.getMainLooper())
    private val session = Session()

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        secureStore = SecureStore(this)
        memoryStore = MemoryStore(secureStore)
        workspaceStore = WorkspaceStore(
            secureStore,
            File(filesDir, BridgeActivity.ATTACHMENT_DIRECTORY),
        )
        sideChatStore = SideChatStore(secureStore)
        workspaceStore.sweepAttachmentRoot()
        sweepStaleSideChatCaptures()
        preferences = AppPreferences(this)
        lastPanelSurface = PanelSurface.fromStored(
            getSharedPreferences(STATE_PREFS, MODE_PRIVATE)
                .getString(STATE_LAST_PANEL_SURFACE, null),
        )
        aiClient = AiClient(secureStore)
        workspaceStore.loadDraft().let { draft ->
            val draftAttachments = draft.attachments.filter { File(it.path).isFile }
            session.situation = draft.situation
            session.rawInput = draft.rawInput
            session.answer = draft.answer
            session.question = draft.question
            session.assumption = draft.assumption
            session.enhancementLevel = EnhancementLevelPolicy.normalize(draft.enhancementLevel)
            session.guessQuestion = draft.shouldResumeQuestion()
            session.attachments += draftAttachments
            if (draft.shouldResumeResult()) {
                workspaceStore.getHistory(draft.historyId.orEmpty())?.let { history ->
                    val selectedHistory = history.copy(
                        selectedVersion = draft.selectedVersion.coerceIn(
                            0,
                            history.versions.lastIndex,
                        ),
                    )
                    session.loadHistory(
                        selectedHistory,
                    )
                    session.enhancementLevel =
                        WorkspacePolicy.resumedEnhancementLevel(draft, selectedHistory)
                    session.answer = draft.answer
                    session.situation = draft.situation
                    session.rawInput = draft.rawInput
                    session.attachments.clear()
                    session.attachments += draftAttachments
                }
            }
        }
        startAsForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == ACTION_STOP) {
            stopBubble()
            return START_NOT_STICKY
        }
        if (action == ACTION_START) {
            stopping = false
            setMarkedRunning(this, true)
        }
        // A capture/bridge result can race with the user's stop tap. Never turn that
        // late result into a fresh bubble service; discard only our own internal file.
        if (!isMarkedRunning(this)) {
            discardLateBridgePayload(intent)
            stopping = true
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!Settings.canDrawOverlays(this)) {
            stopBubble()
            return START_NOT_STICKY
        }
        if (bubble == null) showBubble()
        when (intent?.action) {
            ACTION_OPEN -> showPanel()
            ACTION_RESIZE_BUBBLE -> applyBubbleSize()
            ACTION_ATTACHMENT_RESULT -> receiveAttachment(intent)
            ACTION_CAPTURE_CANCELLED -> {
                restoreAfterBridge()
                if (isSideChatVisualTarget(intent.getStringExtra(EXTRA_TARGET))) {
                    chatScreenNotice = if (pendingChatScreen != null) {
                        "이미지 미리보기 준비됨 · 전송 전 확인하세요."
                    } else {
                        "이미지 사용을 취소했어요."
                    }
                    panel?.renderCurrentScreen()
                }
            }
            ACTION_BRIDGE_ERROR -> {
                restoreAfterBridge()
                val message = intent.getStringExtra(EXTRA_MESSAGE) ?: "작업을 마치지 못했어요."
                if (isSideChatVisualTarget(intent.getStringExtra(EXTRA_TARGET))) {
                    chatScreenNotice = "이미지를 가져오지 못했어요: $message"
                    panel?.renderCurrentScreen()
                } else {
                    showBridgeError(message)
                }
            }
            ACTION_SPEECH_RESULT -> {
                restoreAfterBridge()
                panel?.insertSpeech(
                    intent.getStringExtra(EXTRA_TARGET).orEmpty(),
                    intent.getStringExtra(EXTRA_TEXT).orEmpty(),
                )
            }
            else -> if (Settings.canDrawOverlays(this) && bubble == null) showBubble()
        }
        return START_STICKY
    }

    private fun discardLateBridgePayload(intent: Intent?) {
        if (intent?.action != ACTION_ATTACHMENT_RESULT) return
        val candidate = intent.getStringExtra(EXTRA_PATH)?.let(::File) ?: return
        val allowedRoots = listOf(
            File(filesDir, BridgeActivity.ATTACHMENT_DIRECTORY),
            File(filesDir, BridgeActivity.SIDE_CHAT_CAPTURE_DIRECTORY),
        )
        val candidatePath = runCatching { candidate.canonicalPath }.getOrNull() ?: return
        val belongsToApp = allowedRoots.any { root ->
            val rootPath = runCatching { root.canonicalPath }.getOrNull() ?: return@any false
            candidatePath.startsWith(rootPath + File.separator)
        }
        if (belongsToApp) runCatching { candidate.delete() }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        panel?.close()
        bubbleParams?.let { params ->
            val bounds = currentScreenSize()
            val view = bubble ?: return@let
            params.x = params.x.coerceIn(0, (bounds.first - view.width).coerceAtLeast(0))
            params.y = params.y.coerceIn(
                dp(18),
                (bounds.second - view.height - dp(22)).coerceAtLeast(dp(18)),
            )
            runCatching { windowManager.updateViewLayout(view, params) }
        }
    }

    override fun onDestroy() {
        stopping = true
        request?.cancel(true)
        request = null
        chatRequest?.cancel()
        chatRequest = null
        discardPendingChatScreen()
        activeChatScreen?.let(::deleteChatScreenFile)
        activeChatScreen = null
        persistDraft()
        panel?.removeForServiceShutdown()
        panel = null
        hideRemoveTarget()
        bubble?.let { runCatching { windowManager.removeView(it) } }
        bubble = null
        aiClient.close()
        setMarkedRunning(this, false)
        super.onDestroy()
    }

    private fun startAsForeground() {
        val notificationManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "글 강화기 버블",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "사용자가 켠 글 강화기 버블의 실행 상태"
                setShowBadge(false)
            },
        )
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, OverlayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(com.example.writingenhancer.R.drawable.ic_launcher)
            .setContentTitle("글 강화기가 대기 중이에요")
            .setContentText("버블을 누르면 바로 글을 완성할 수 있어요.")
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "버블 끄기", stopIntent).build())
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun showBubble() {
        if (bubble != null || !Settings.canDrawOverlays(this)) return
        val saved = getSharedPreferences(POSITION_PREFS, MODE_PRIVATE)
        val screen = currentScreenSize()
        val size = dp(preferences.bubbleSizeDp)
        val params = WindowManager.LayoutParams(
            size,
            size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = saved.getInt("x", screen.first - size - dp(10))
                .coerceIn(0, (screen.first - size).coerceAtLeast(0))
            y = saved.getInt("y", (screen.second * 0.31f).roundToInt())
                .coerceIn(dp(18), (screen.second - size - dp(22)).coerceAtLeast(dp(18)))
        }
        val view = TextView(this).apply {
            text = "글"
            textSize = (preferences.bubbleSizeDp * 0.28f).coerceIn(13f, 22f)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            alpha = 0.88f
            elevation = dp(10).toFloat()
            background = Ui.rounded(Ui.ACCENT, preferences.bubbleSizeDp / 2, this@OverlayService)
            contentDescription = "글 강화기 열기. 길게 눌러 종료할 수 있어요."
            setOnClickListener { showPanel() }
            setOnTouchListener(BubbleDragListener(params))
        }
        windowManager.addView(view, params)
        bubble = view
        bubbleParams = params
    }

    private fun applyBubbleSize() {
        val view = bubble ?: return
        val params = bubbleParams ?: return
        val size = dp(preferences.bubbleSizeDp)
        params.width = size
        params.height = size
        val screen = currentScreenSize()
        params.x = params.x.coerceIn(0, (screen.first - size).coerceAtLeast(0))
        params.y = params.y.coerceIn(dp(18), (screen.second - size - dp(22)).coerceAtLeast(dp(18)))
        view.textSize = (preferences.bubbleSizeDp * 0.28f).coerceIn(13f, 22f)
        view.background = Ui.rounded(Ui.ACCENT, preferences.bubbleSizeDp / 2, this)
        runCatching { windowManager.updateViewLayout(view, params) }
        saveBubblePosition(params)
    }

    private fun showPanel() {
        if (panel != null || !Settings.canDrawOverlays(this)) return
        bubble?.visibility = View.GONE
        val controller = PanelController()
        panel = controller
        runCatching { controller.show() }
            .onFailure {
                controller.removeAfterFailedShow()
                if (panel === controller) panel = null
                ensureBubbleVisible()
                Toast.makeText(
                    this,
                    "패널을 열지 못했어요. 다시 눌러 주세요.",
                    Toast.LENGTH_SHORT,
                ).show()
            }
    }

    private fun stopBubble() {
        stopping = true
        // Persist the user's stop decision before MediaProjection or BridgeActivity can
        // deliver a late result. Those helpers must never resurrect a stopped bubble.
        setMarkedRunning(this, false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun sweepStaleSideChatCaptures(now: Long = System.currentTimeMillis()) {
        val captureRoot = File(filesDir, BridgeActivity.SIDE_CHAT_CAPTURE_DIRECTORY)
        captureRoot.listFiles()?.forEach { file ->
            if (
                file.isFile &&
                now - file.lastModified() >= SIDE_CHAT_CAPTURE_STALE_MS
            ) {
                runCatching { file.delete() }
            }
        }
    }

    private fun submit(
        rawInput: String,
        currentDraft: String?,
        answer: String?,
        questionFirst: Boolean,
        regenerateFromOriginal: Boolean = false,
        controller: PanelController,
        loadingButton: Button?,
    ) {
        if (request?.isDone == false) return
        val requestedLevel =
            EnhancementLevelPolicy.captureRequestLevel(session.enhancementLevel)
        val requestContext = SessionRequestContext(
            requestId = ++requestSequence,
            generation = session.generation,
            historyId = session.historyId,
            rawInput = rawInput,
            situation = session.situation,
            attachments = session.attachments.toList(),
            enhancementLevel = requestedLevel,
        )
        activeRequestId = requestContext.requestId
        val grounding =
            "${requestContext.rawInput} ${requestContext.situation} ${answer.orEmpty()}"
        val memories = memoryStore.relevantFor(grounding)
            .map { "${it.sourceKind} | ${it.type} | ${it.scope} | ${it.value}" }
        controller.setLoading(true, loadingButton)
        request = aiClient.enhance(
            EnhancementRequest(
                rawInput = requestContext.rawInput,
                situation = requestContext.situation,
                currentDraft = currentDraft,
                userAnswer = answer,
                priorQuestion = session.question.takeIf {
                    !regenerateFromOriginal && it.isNotBlank() && !questionFirst
                },
                priorAssumption = session.assumption.takeIf {
                    !regenerateFromOriginal && it.isNotBlank() && !questionFirst
                },
                memories = memories,
                attachments = requestContext.attachments,
                questionFirst = questionFirst,
                followUpMode = if (
                    !questionFirst &&
                    currentDraft.isNullOrBlank() &&
                    requestContext.historyId.isNullOrBlank()
                ) {
                    FollowUpMode.FIRST
                } else {
                    FollowUpMode.SUBSEQUENT
                },
                enhancementLevel = requestContext.enhancementLevel,
                regenerateFromOriginal = regenerateFromOriginal,
            ),
        ) { result ->
            if (stopping || panel !== controller) return@enhance
            if (activeRequestId != requestContext.requestId) return@enhance
            if (
                !WorkspacePolicy.isRequestGenerationCurrent(
                    captured = requestContext.generation,
                    current = session.generation,
                )
            ) {
                controller.setLoading(false)
                return@enhance
            }
            controller.setLoading(false)
            result.fold(
                onSuccess = { enhancement ->
                    if (questionFirst) {
                        session.invalidateRequestScope()
                        session.enhancementLevel = requestContext.enhancementLevel
                        session.question = enhancement.followUp
                        session.assumption = enhancement.assumption
                        session.guessQuestion = true
                        persistDraft()
                        controller.renderGuessQuestion(enhancement.followUp)
                    } else {
                        acceptResult(enhancement, answer, requestContext, controller)
                    }
                },
                onFailure = { failure ->
                    controller.showError(
                        failure.message?.take(180)
                            ?: "잠시 연결하지 못했어요. 다시 눌러 주세요.",
                    )
                },
            )
        }
    }

    private fun acceptResult(
        enhancement: EnhancementResult,
        answer: String?,
        requestContext: SessionRequestContext,
        controller: PanelController,
    ) {
        session.draft = enhancement.completedText
        session.question = enhancement.followUp
        session.assumption = enhancement.assumption
        session.provider = enhancement.provider
        session.answer = ""
        session.guessQuestion = false
        val version = WorkspacePolicy.resultVersionForRequest(
            text = enhancement.completedText,
            question = enhancement.followUp,
            provider = enhancement.provider,
            createdAt = System.currentTimeMillis(),
            assumption = enhancement.assumption,
            capturedRequestLevel = requestContext.enhancementLevel,
        )
        val stored = workspaceStore.addVersion(
            historyId = requestContext.historyId,
            situation = requestContext.situation,
            rawInput = requestContext.rawInput,
            attachments = requestContext.attachments,
            version = version,
        )
        session.loadHistory(stored)
        persistDraft()
        controller.renderStoredResult()
        remember(
            enhancement,
            "${requestContext.rawInput}\n${requestContext.situation}\n${answer.orEmpty()}",
            controller,
        )
    }

    private fun remember(
        enhancement: EnhancementResult,
        groundingInput: String,
        controller: PanelController,
    ) {
        if (!preferences.memoryAdditionsEnabled) return
        val candidates = memoryStore.previewCandidates(
            enhancement.memoryCandidates,
            groundingInput,
        )
        if (candidates.isNotEmpty()) {
            controller.showMemoryApproval(candidates, groundingInput)
        }
    }

    private fun receiveAttachment(intent: Intent) {
        restoreAfterBridge()
        val attachment = AttachmentRef(
            path = intent.getStringExtra(EXTRA_PATH).orEmpty(),
            displayName = intent.getStringExtra(EXTRA_NAME) ?: "첨부 파일",
            mimeType = intent.getStringExtra(EXTRA_MIME) ?: "application/octet-stream",
            sizeBytes = intent.getLongExtra(EXTRA_SIZE, 0L),
            source = intent.getStringExtra(EXTRA_SOURCE) ?: "file",
        )
        if (!File(attachment.path).isFile) {
            showBridgeError("첨부 파일을 찾지 못했어요.")
            return
        }
        if (isSideChatVisualTarget(intent.getStringExtra(EXTRA_TARGET))) {
            if (
                !attachment.mimeType.startsWith("image/") ||
                attachment.sizeBytes !in 1..WorkspacePolicy.MAX_ATTACHMENT_BYTES
            ) {
                deleteChatScreenFile(attachment)
                chatScreenNotice = "검색 이미지는 지원되는 8MB 이하 이미지여야 해요."
                panel?.renderCurrentScreen()
                return
            }
            discardPendingChatScreen()
            pendingChatScreen = attachment
            chatScreenNotice = "이미지 준비됨 · 전송 전에 미리보기와 영역을 확인하세요."
            panel?.renderCurrentScreen()
            return
        }
        if (!WorkspacePolicy.canAttach(session.attachments, attachment.sizeBytes)) {
            File(attachment.path).delete()
            showBridgeError("첨부는 최대 5개, 파일당 8MB, 합계 12MB까지 가능해요.")
            return
        }
        session.invalidateRequestScope()
        session.attachments += attachment
        persistDraft()
        panel?.renderCurrentScreen()
        Toast.makeText(this, "${attachment.displayName}을 첨부했어요.", Toast.LENGTH_SHORT).show()
    }

    private fun isSideChatVisualTarget(target: String?): Boolean =
        target == BridgeActivity.TARGET_SIDE_CHAT_SCREEN ||
            target == BridgeActivity.TARGET_SIDE_CHAT_VISUAL

    private fun takePendingChatScreen(): AttachmentRef? {
        val attachment = pendingChatScreen ?: return null
        pendingChatScreen = null
        activeChatScreen = attachment
        chatScreenNotice = "선택한 이미지를 포함해 답변을 준비하는 중…"
        return attachment
    }

    private fun finishChatScreenRequest(attachment: AttachmentRef?) {
        if (attachment == null) return
        deleteChatScreenFile(attachment)
        if (activeChatScreen?.path == attachment.path) activeChatScreen = null
        chatScreenNotice = "사용한 이미지는 한 번 전송한 뒤 삭제했어요."
    }

    private fun discardPendingChatScreen() {
        pendingChatScreen?.let(::deleteChatScreenFile)
        pendingChatScreen = null
    }

    private fun deleteChatScreenFile(attachment: AttachmentRef) {
        runCatching { File(attachment.path).takeIf(File::isFile)?.delete() }
    }

    private fun restoreAfterBridge() {
        bridgeInProgress = false
        panel?.restoreAfterBridge()
        if (panel == null) bubble?.visibility = View.VISIBLE
    }

    private fun showBridgeError(message: String) {
        panel?.showError(message) ?: Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun persistDraft() {
        workspaceStore.saveDraft(
            DraftState(
                situation = session.situation,
                rawInput = session.rawInput,
                answer = session.answer,
                question = session.question,
                assumption = session.assumption,
                questionFirstActive = session.guessQuestion,
                historyId = session.historyId,
                selectedVersion = session.versionIndex,
                attachments = session.attachments,
                enhancementLevel = EnhancementLevelPolicy.normalize(session.enhancementLevel),
            ),
        )
    }

    private fun ensureBubbleVisible() {
        if (bridgeInProgress || stopping) return
        if (bubble == null && Settings.canDrawOverlays(this)) showBubble()
        bubble?.visibility = View.VISIBLE
    }

    private fun saveBubblePosition(params: WindowManager.LayoutParams) {
        getSharedPreferences(POSITION_PREFS, MODE_PRIVATE)
            .edit()
            .putInt("x", params.x)
            .putInt("y", params.y)
            .apply()
    }

    private inner class BubbleDragListener(
        private val params: WindowManager.LayoutParams,
    ) : View.OnTouchListener {
        private var startX = 0
        private var startY = 0
        private var downRawX = 0f
        private var downRawY = 0f
        private var lastRawX = 0f
        private var lastRawY = 0f
        private var moved = false
        private var pointerDown = false
        private var longPressed = false
        private val longPress = Runnable {
            if (pointerDown) {
                longPressed = true
                showRemoveTarget()
            }
        }

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    downRawX = event.rawX
                    downRawY = event.rawY
                    lastRawX = event.rawX
                    lastRawY = event.rawY
                    moved = false
                    pointerDown = true
                    longPressed = false
                    view.alpha = 1f
                    mainHandler.postDelayed(longPress, LONG_PRESS_MS)
                    return true
                }

                MotionEvent.ACTION_MOVE -> {
                    lastRawX = event.rawX
                    lastRawY = event.rawY
                    val deltaX = (event.rawX - downRawX).roundToInt()
                    val deltaY = (event.rawY - downRawY).roundToInt()
                    moved = moved || abs(deltaX) > dp(5) || abs(deltaY) > dp(5)
                    val screen = currentScreenSize()
                    params.x = (startX + deltaX).coerceIn(
                        0,
                        (screen.first - view.width).coerceAtLeast(0),
                    )
                    params.y = (startY + deltaY).coerceIn(
                        dp(18),
                        (screen.second - view.height - dp(22)).coerceAtLeast(dp(18)),
                    )
                    runCatching { windowManager.updateViewLayout(view, params) }
                    if (longPressed) {
                        val over = isOverRemoveTarget(lastRawX, lastRawY)
                        removeTarget?.background = Ui.rounded(
                            if (over) 0xFFE64B5D.toInt() else 0xE633303A.toInt(),
                            28,
                            this@OverlayService,
                        )
                        view.alpha = if (over) 0.45f else 1f
                    }
                    return true
                }

                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    pointerDown = false
                    mainHandler.removeCallbacks(longPress)
                    val shouldStop = longPressed &&
                        event.actionMasked == MotionEvent.ACTION_UP &&
                        isOverRemoveTarget(lastRawX, lastRawY)
                    hideRemoveTarget()
                    if (shouldStop) {
                        stopBubble()
                    } else {
                        if (!moved && !longPressed && event.actionMasked == MotionEvent.ACTION_UP) {
                            view.performClick()
                        }
                        saveBubblePosition(params)
                        view.alpha = 0.88f
                    }
                    return true
                }
            }
            return false
        }
    }

    private fun showRemoveTarget() {
        if (removeTarget != null) return
        val target = TextView(this).apply {
            text = getString(com.example.writingenhancer.R.string.remove_bubble_target)
            textSize = 13f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = Ui.rounded(0xE633303A.toInt(), 28, this@OverlayService)
            elevation = dp(16).toFloat()
        }
        val params = WindowManager.LayoutParams(
            dp(150),
            dp(72),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(34)
        }
        windowManager.addView(target, params)
        removeTarget = target
    }

    private fun hideRemoveTarget() {
        removeTarget?.let { runCatching { windowManager.removeView(it) } }
        removeTarget = null
    }

    private fun isOverRemoveTarget(rawX: Float, rawY: Float): Boolean {
        val screen = currentScreenSize()
        return MobileUiPolicy.isInRemoveZone(
            rawX = rawX,
            rawY = rawY,
            screenWidth = screen.first,
            screenHeight = screen.second,
            horizontalRadius = dp(105),
            bottomZoneHeight = dp(135),
        )
    }

    private inner class PanelController {
        private lateinit var root: BackAwareFrameLayout
        private lateinit var headerHost: LinearLayout
        private lateinit var content: LinearLayout
        private lateinit var scroll: ScrollView
        private lateinit var stickyActions: LinearLayout
        private var input: PasteFriendlyEditText? = null
        private var situationInput: PasteFriendlyEditText? = null
        private var answerInput: PasteFriendlyEditText? = null
        private var chatInput: PasteFriendlyEditText? = null
        private var completeButton: Button? = null
        private var answerPrimaryButton: Button? = null
        private var reenhanceButton: Button? = null
        private var suggestionView: View? = null
        private var suggestionAcceptButton: Button? = null
        private var error: TextView? = null
        private var undoBanner: View? = null
        private var memoryApprovalBanner: View? = null
        private val editMenuController =
            InlineEditMenuController(this@OverlayService, dark = true)
        private var settingsOpen = false
        private var closed = false
        private var screenState = PanelScreenState.INPUT
        private var historyReturnScreen = PanelScreenState.INPUT
        private var chatReturnScreen = PanelScreenState.INPUT
        private val visibleFrame = Rect()
        private var insetImeBottom = 0
        private var insetSystemBarBottom = 0
        private var geometryImeBottom = 0
        private var imeVisible = false
        private var requestedPanelHeight = 0
        private var panelParams: WindowManager.LayoutParams? = null
        private var layoutProfile = MobileUiPolicy.layoutProfile(380, 640)
        private val generationButtons = linkedSetOf<Button>()
        private var activeLoadingButton: Button? = null
        private var activeLoadingLabel: String = ""
        private var generationInProgress = false
        private var responsiveRerenderPending = false
        private var chatBusy = false
        private var chatDraft = retainedChatDraft
        private var chatPendingUser = ""
        private var chatEditingMessageId = ""
        private var chatClearConfirmation = false
        private var chatError = ""
        // 다음 질문 한 번만 웹 검색을 강제한다.
        private var chatSearchMode = false
        private var chatActiveForceSearch = false
        private var chatProgress: SideChatProgress? = null
        private var chatProgressStartedAt = 0L
        private var chatProgressLabel: TextView? = null
        // 검색·화면 자료가 섞인 대화에서 사용자 확인을 기다리는 채팅 제안 동작.
        private var pendingChatAction: SideChatAction? = null
        private val chatProgressTicker = object : Runnable {
            override fun run() {
                if (!chatBusy || closed) return
                chatProgressLabel?.text = SideChatDisplayPolicy.progressLabel(
                    chatProgress,
                    System.currentTimeMillis() - chatProgressStartedAt,
                )
                root.postDelayed(this, 1_000)
            }
        }
        private var keepChatKeyboard = false
        private var situationExpanded = false
        private var toolsExpanded = false
        private val persistRunnable = Runnable {
            syncInputs()
            persistDraft()
        }

        @Suppress("DEPRECATION")
        @android.annotation.SuppressLint("ClickableViewAccessibility")
        fun show() {
            root = BackAwareFrameLayout(
                context = this@OverlayService,
                onBack = { handleBack() },
                onOutside = { event -> handleOutside(event) },
            ).apply {
                background = Ui.rounded(Ui.PANEL, 24, this@OverlayService, Ui.PANEL_STROKE)
                clipToOutline = true
                elevation = dp(18).toFloat()
                isFocusableInTouchMode = true
                descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
                outsideEnabled = { !settingsOpen }
            }
            content = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
            }
            headerHost = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
            }
            scroll = ScrollView(this@OverlayService).apply {
                isFillViewport = true
                overScrollMode = View.OVER_SCROLL_NEVER
                addView(content)
            }
            stickyActions = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                background = Ui.rounded(Ui.PANEL, 16, this@OverlayService)
            }
            val panelColumn = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                addView(
                    headerHost,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
                addView(
                    scroll,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        0,
                        1f,
                    ),
                )
                addView(
                    stickyActions,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            }
            root.addView(
                panelColumn,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            val screen = currentScreenSize()
            val geometry = getSharedPreferences(PANEL_GEOMETRY_PREFS, MODE_PRIVATE)
            val minimumWidth = dp(280)
            val minimumHeight = dp(360)
            val defaultWidth = (screen.first - dp(16)).coerceAtMost(dp(440))
            val defaultHeight = minOf((screen.second * 0.88f).roundToInt(), dp(760))
            val panelWidth = geometry.getInt(KEY_PANEL_WIDTH, defaultWidth)
                .coerceIn(minimumWidth, screen.first)
            val panelHeight = geometry.getInt(KEY_PANEL_HEIGHT, defaultHeight)
                .coerceIn(minimumHeight, screen.second)
            layoutProfile = MobileUiPolicy.layoutProfile(
                widthDp = pxToDp(panelWidth),
                heightDp = pxToDp(panelHeight),
            )
            applyPanelPadding()
            requestedPanelHeight = panelHeight
            val params = WindowManager.LayoutParams(
                panelWidth,
                panelHeight,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT,
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = geometry.getInt(KEY_PANEL_X, (screen.first - panelWidth) / 2)
                    .coerceIn(panelPositionRange(panelWidth, screen.first))
                y = geometry.getInt(KEY_PANEL_Y, screen.second - panelHeight - dp(8))
                    .coerceIn(panelPositionRange(panelHeight, screen.second))
                softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                    WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
            }
            panelParams = params
            Ui.applySurfaceOpacity(root, preferences.popupOpacityPercent / 100f)
            val resizeHandle = TextView(this@OverlayService).apply {
                text = ""
                textSize = 18f
                gravity = Gravity.CENTER
                setTextColor(Ui.PANEL_MUTED)
                contentDescription = "글 강화기 창 크기 조절"
                background = android.graphics.drawable.InsetDrawable(
                    UiIconDrawable(UiIcon.RESIZE, Ui.PANEL_MUTED), dp(10),
                )
            }
            resizeHandle.setOnTouchListener(
                WindowDragTouchListener(
                    view = resizeHandle,
                    onDelta = { deltaX, deltaY -> resizePanelBy(deltaX, deltaY) },
                    onFinished = {
                        persistPanelGeometry()
                        applyResponsiveLayoutAfterResize()
                    },
                ),
            )
            root.addView(
                resizeHandle,
                FrameLayout.LayoutParams(
                    dp(44),
                    dp(44),
                    Gravity.END or Gravity.BOTTOM,
                ).apply {
                    rightMargin = 0
                    bottomMargin = 0
                },
            )
            windowManager.addView(root, params)
            configureImeAwareScroll()
            if (lastPanelSurface == PanelSurface.SIDE_CHAT) {
                chatReturnScreen = writingScreenForSession()
                renderSideChat()
            } else {
                renderWritingState()
            }
            root.requestFocus()
            root.post {
                root.requestFocus()
                hideImeOnly()
                root.requestApplyInsets()
            }
        }

        private fun panelPositionRange(size: Int, screenSize: Int): IntRange =
            MobileUiPolicy.popupPositionRange(
                popupSize = size,
                screenSize = screenSize,
                recoverableEdge = dp(76),
            )

        private fun pxToDp(value: Int): Int =
            (value / resources.displayMetrics.density).roundToInt().coerceAtLeast(1)

        private fun applyPanelPadding() {
            root.setPadding(
                dp(layoutProfile.horizontalPaddingDp),
                dp(layoutProfile.verticalPaddingDp),
                dp(layoutProfile.horizontalPaddingDp),
                dp(layoutProfile.verticalPaddingDp),
            )
            if (::stickyActions.isInitialized) {
                // Keep the 44dp resize target below, not over, the last action.
                stickyActions.setPadding(0, dp(10), 0, dp(36))
            }
        }

        private fun applyResponsiveLayoutAfterResize() {
            val params = panelParams ?: return
            val next = MobileUiPolicy.layoutProfile(
                widthDp = pxToDp(params.width),
                heightDp = pxToDp(params.height),
            )
            if (next == layoutProfile) return
            syncInputs()
            layoutProfile = next
            applyPanelPadding()
            if (generationInProgress) {
                responsiveRerenderPending = true
            } else {
                renderCurrentScreen()
            }
        }

        private fun movePanelBy(deltaX: Int, deltaY: Int) {
            val params = panelParams ?: return
            val screen = currentScreenSize()
            params.x = (params.x + deltaX).coerceIn(
                panelPositionRange(params.width, screen.first),
            )
            params.y = (params.y + deltaY).coerceIn(
                panelPositionRange(params.height, screen.second),
            )
            runCatching { windowManager.updateViewLayout(root, params) }
        }

        private fun resizePanelBy(deltaWidth: Int, deltaHeight: Int) {
            val params = panelParams ?: return
            val screen = currentScreenSize()
            params.width = (params.width + deltaWidth).coerceIn(dp(280), screen.first)
            params.height = (params.height + deltaHeight).coerceIn(dp(360), screen.second)
            requestedPanelHeight = params.height
            params.x = params.x.coerceIn(panelPositionRange(params.width, screen.first))
            params.y = params.y.coerceIn(panelPositionRange(params.height, screen.second))
            runCatching { windowManager.updateViewLayout(root, params) }
            root.requestApplyInsets()
        }

        private fun persistPanelGeometry() {
            val params = panelParams ?: return
            getSharedPreferences(PANEL_GEOMETRY_PREFS, MODE_PRIVATE)
                .edit()
                .putInt(KEY_PANEL_X, params.x)
                .putInt(KEY_PANEL_Y, params.y)
                .putInt(KEY_PANEL_WIDTH, params.width)
                .putInt(KEY_PANEL_HEIGHT, params.height)
                .apply()
        }

        fun close() {
            if (closed || !::root.isInitialized) return
            rememberCollapsedSurface()
            runCatching { syncInputs() }
            if (screenState == PanelScreenState.CHAT) {
                cancelSideChatRequestForCollapse()
                retainedChatDraft = chatDraft
            }
            closed = true
            runCatching { mainHandler.removeCallbacks(persistRunnable) }
            runCatching { persistDraft() }
            runCatching { persistPanelGeometry() }
            runCatching { hideKeyboard() }
            if (screenState == PanelScreenState.CHAT) {
                discardPendingChatScreen()
                chatScreenNotice = ""
            }
            try {
                runCatching { windowManager.removeView(root) }
            } finally {
                if (panel === this) panel = null
                panelParams = null
                if (bridgeInProgress) {
                    runCatching { bubble?.visibility = View.GONE }
                } else {
                    runCatching { ensureBubbleVisible() }
                }
            }
        }

        private fun cancelSideChatRequestForCollapse() {
            if (!chatBusy && chatRequest?.isDone != false) return
            chatRequest?.cancel()
            chatRequest = null
            chatRequestToken += 1
            chatBusy = false
            stopChatProgress()
            if (chatDraft.isBlank()) chatDraft = chatPendingUser
            chatPendingUser = ""
            chatError = ""
            activeChatScreen?.let(::deleteChatScreenFile)
            activeChatScreen = null
        }

        fun removeForServiceShutdown() {
            closed = true
            if (::root.isInitialized) runCatching { windowManager.removeView(root) }
        }

        fun removeAfterFailedShow() {
            closed = true
            if (::root.isInitialized && root.isAttachedToWindow) {
                runCatching { windowManager.removeView(root) }
            }
        }

        fun restoreAfterBridge() {
            if (!::root.isInitialized) return
            root.visibility = View.VISIBLE
        }

        fun renderCurrentScreen() {
            if (!::root.isInitialized) return
            when {
                screenState == PanelScreenState.CHAT -> renderSideChat()
                session.guessQuestion && session.question.isNotBlank() ->
                    renderGuessQuestion(session.question)
                session.draft.isBlank() -> renderInput()
                else -> renderStoredResult()
            }
        }

        @android.annotation.SuppressLint("ClickableViewAccessibility")
        private fun renderHeader(showNew: Boolean, showHistory: Boolean = true) {
            val header = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(3), 0, 0, dp(10))
                contentDescription = "글 강화기 창 이동"
            }
            val title = Ui.label(
                this@OverlayService,
                "글 강화기",
                18f,
                Color.WHITE,
                true,
            ).apply {
                maxLines = 1
                setAutoSizeTextTypeUniformWithConfiguration(
                    11,
                    18,
                    1,
                    TypedValue.COMPLEX_UNIT_SP,
                )
            }
            header.addView(
                title,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            if (showHistory) {
                header.addView(Ui.iconButton(this@OverlayService, UiIcon.HISTORY, "기록") { renderHistory() }, LinearLayout.LayoutParams(dp(44), dp(44)))
                header.addView(
                    Ui.iconButton(this@OverlayService, UiIcon.CHAT, "사이드 채팅 베타 열기") { openSideChat() },
                    LinearLayout.LayoutParams(dp(44), dp(44)),
                )
            }
            if (showNew) {
                // Keep four tools in the header even at the minimum popup width.
                content.addView(Ui.quietButton(this@OverlayService, "＋ 새 글") {
                    session.clear()
                    workspaceStore.clearDraft()
                    renderInput()
                }.apply {
                    contentDescription = "새 글 시작"
                    background = Ui.interactive(this@OverlayService, Color.TRANSPARENT)
                    setTextColor(Ui.PANEL_MUTED)
                }, LinearLayout.LayoutParams(dp(88), dp(44)).apply { gravity = Gravity.END })
            }
            val gear = Ui.iconButton(this@OverlayService, UiIcon.SETTINGS, "설정") {
                openSettings(it)
            }
            header.addView(gear, LinearLayout.LayoutParams(dp(44), dp(44)))
            header.addView(Ui.iconButton(this@OverlayService, UiIcon.CLOSE, "버블로 접기") { close() }, LinearLayout.LayoutParams(dp(44), dp(44)))
            header.setOnTouchListener(
                WindowDragTouchListener(
                    view = header,
                    onDelta = { deltaX, deltaY -> movePanelBy(deltaX, deltaY) },
                    onFinished = { persistPanelGeometry() },
                ),
            )
            headerHost.addView(header)
        }

        private fun openSettings(anchor: View) {
            if (settingsOpen) return
            settingsOpen = true
            root.foreground = android.graphics.drawable.ColorDrawable(0xAA000000.toInt())
            SettingsPanel.showPopup(
                context = this@OverlayService,
                anchor = anchor,
                secureStore = secureStore,
                memoryStore = memoryStore,
                onStopBubble = { stopBubble() },
                onBubbleSizeChanged = { applyBubbleSize() },
                onPopupOpacityChanged = { opacity -> Ui.applySurfaceOpacity(root, opacity) },
            ).setOnDismissListener {
                settingsOpen = false
                root.foreground = null
            }
        }

        private fun renderInput() {
            hideKeyboard()
            screenState = PanelScreenState.INPUT
            content.removeAllViews()
            resetViewReferences()
            renderHeader(showNew = false)
            content.addView(
                Ui.label(
                    this@OverlayService,
                    "아무렇게나 적어도 돼요.",
                    if (layoutProfile.rawMinRows < 4) 18f else 22f,
                    Color.WHITE,
                    true,
                ).apply { setPadding(dp(3), dp(10), 0, dp(6)) },
            )
            if (layoutProfile.rawMinRows >= 4) content.addView(Ui.label(this@OverlayService, "생각을 적으면, 완성된 글로.", 13f, Ui.PANEL_MUTED).apply {
                setPadding(dp(3), 0, 0, dp(20))
            })

            val rawField = backAwareEditText(
                hintText = "생각나는 대로 적어 보세요…",
                textValue = session.rawInput,
                minRows = layoutProfile.rawMinRows,
                maxRows = layoutProfile.rawMaxRows,
                textSizeSp = 16f,
            )
            input = rawField

            val quickRow = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val situationToggle = compactAction(
                when {
                    situationExpanded -> "상황 접기"
                    session.situation.isBlank() -> "＋ 상황"
                    else -> "상황 ✓"
                },
                Ui.PANEL_RAISED,
            )
            val toolsToggle = compactAction(
                if (toolsExpanded) "도구 접기" else "＋ 도구",
                Ui.PANEL_RAISED,
            )
            quickRow.addView(situationToggle, LinearLayout.LayoutParams(0, dp(44), 1f))
            quickRow.addView(
                toolsToggle,
                LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginStart = dp(6) },
            )
            quickRow.addView(
                editMenuController.menuButton(rawField),
                LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(6) },
            )
            situationToggle.setOnClickListener {
                syncInputs()
                situationExpanded = !situationExpanded
                renderInput()
            }
            toolsToggle.setOnClickListener {
                syncInputs()
                toolsExpanded = !toolsExpanded
                renderInput()
            }

            if (situationExpanded) {
                val situationField = backAwareEditText(
                    hintText = "예: 팀장에게 보낼 보고, 소설 장면, 고객 문자",
                    textValue = session.situation,
                    minRows = 1,
                    maxRows = 3,
                    textSizeSp = 13f,
                    showEditTools =
                        MobileUiPolicy.showInlineEditTools(MobileEditorRole.SITUATION),
                )
                situationInput = situationField
                content.addView(
                    Ui.label(
                        this@OverlayService,
                        "상황이나 필요한 내용 · 선택",
                        12f,
                        Ui.PANEL_MUTED,
                        true,
                    ),
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { bottomMargin = dp(5) },
                )
                content.addView(
                    situationField,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
                situationField.watchDraft { session.situation = it }
            }

            rawField.contentDescription = "나의 글 입력"
            content.addView(
                rawField,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    1f,
                ),
            )
            rawField.watchDraft { session.rawInput = it }
            content.addView(quickRow, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44),
            ).apply { topMargin = dp(10) })

            renderEnhancementLevelControl()
            renderAttachmentArea()
            renderError()

            if (toolsExpanded) {
                val toolGrid = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.VERTICAL
                }
                val firstToolRow = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                val file = compactAction("＋ 파일", Ui.PANEL_FIELD)
                val screen = compactAction("▣ 화면", Ui.PANEL_FIELD)
                val voice = compactAction("● 말하기", Ui.PANEL_FIELD)
                firstToolRow.addView(file, LinearLayout.LayoutParams(0, dp(42), 1f))
                firstToolRow.addView(
                    screen,
                    LinearLayout.LayoutParams(0, dp(42), 1f).apply {
                        marginStart = dp(6)
                    },
                )
                firstToolRow.addView(
                    voice,
                    LinearLayout.LayoutParams(0, dp(42), 1f).apply { marginStart = dp(6) },
                )
                toolGrid.addView(
                    firstToolRow,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(42),
                    ),
                )
                content.addView(
                    toolGrid,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(10) },
                )
                file.setOnClickListener {
                    launchBridge(
                        BridgeActivity.ACTION_PICK_ATTACHMENT,
                        BridgeActivity.TARGET_RAW,
                    )
                }
                screen.setOnClickListener {
                    launchBridge(
                        BridgeActivity.ACTION_CAPTURE_SCREEN,
                        BridgeActivity.TARGET_RAW,
                    )
                }
                voice.setOnClickListener {
                    launchBridge(BridgeActivity.ACTION_SPEECH, BridgeActivity.TARGET_RAW)
                }
            }

            completeButton = Ui.primaryButton(this@OverlayService, "완성하기").apply {
                setAutoSizeTextTypeUniformWithConfiguration(
                    12,
                    16,
                    1,
                    TypedValue.COMPLEX_UNIT_SP,
                )
                setOnClickListener {
                    startCompletion(questionFirst = false, loadingButton = this)
                }
            }
            completeButton?.let { generationButtons += it }
            val inputActions = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            inputActions.addView(
                completeButton,
                LinearLayout.LayoutParams(
                    0,
                    dp(layoutProfile.actionHeightDp.coerceAtLeast(48)),
                    1f,
                ),
            )
            val guess = compactAction("알아맞춰 봐", Ui.PANEL_RAISED).apply {
                contentDescription = "알아맞춰 봐 · AI가 먼저 한 가지만 물어요"
                setTextColor(Ui.PANEL_MUTED)
            }
            generationButtons += guess
            inputActions.addView(
                guess,
                LinearLayout.LayoutParams(
                    0,
                    dp(layoutProfile.actionHeightDp.coerceAtLeast(48)),
                    1f,
                ).apply { marginStart = dp(8) },
            )
            stickyActions.addView(inputActions)
            guess.setOnClickListener {
                startCompletion(questionFirst = true, loadingButton = guess)
            }
            root.requestFocus()
        }

        private fun renderAttachmentArea() {
            if (session.attachments.isEmpty()) return
            val list = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(8), 0, 0)
            }
            session.attachments.toList().forEach { attachment ->
                val row = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(11), dp(6), dp(5), dp(6))
                    background = Ui.rounded(0xFF303039.toInt(), 12, this@OverlayService)
                }
                val source = if (attachment.source == "screenshot") "화면" else "첨부"
                row.addView(
                    Ui.label(
                        this@OverlayService,
                        "$source · ${AttachmentPolicy.sanitizeDisplayName(attachment.displayName).take(28)}\n" +
                            "${attachment.mimeType} · " +
                            AttachmentPolicy.humanReadableSize(attachment.sizeBytes),
                        11f,
                        0xFFE5E2EA.toInt(),
                    ),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
                )
                row.addView(Ui.quietButton(this@OverlayService, "×") {
                    session.invalidateRequestScope()
                    session.attachments.removeAll { it.path == attachment.path }
                    persistDraft()
                    renderInput()
                }.apply { contentDescription = "${attachment.displayName} 첨부 제거" })
                list.addView(
                    row,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { bottomMargin = dp(5) },
                )
            }
            content.addView(list)
        }

        private fun openSideChat() {
            syncInputs()
            persistDraft()
            if (screenState != PanelScreenState.CHAT) {
                chatReturnScreen = screenState
            }
            chatEditingMessageId = ""
            chatClearConfirmation = false
            chatError = ""
            screenState = PanelScreenState.CHAT
            renderSideChat()
        }

        private fun renderSideChat() {
            val restoreKeyboard = keepChatKeyboard
            keepChatKeyboard = false
            if (!restoreKeyboard) hideKeyboard()
            screenState = PanelScreenState.CHAT
            content.removeAllViews()
            resetViewReferences()
            renderSideChatHeader()
            renderSideChatContext()

            if (chatError.isNotBlank()) {
                content.addView(
                    Ui.label(
                        this@OverlayService,
                        chatError,
                        12f,
                        0xFFFF9B9B.toInt(),
                    ).apply { setPadding(dp(5), 0, dp(5), dp(9)) },
                )
            }

            val messages = sideChatStore.list()
            if (messages.isEmpty() && chatPendingUser.isBlank()) {
                content.addView(
                    Ui.label(
                        this@OverlayService,
                        "검색부터 글 다듬기까지,\n" +
                            "필요한 것을 편하게 물어보세요.",
                        14f,
                        Ui.PANEL_MUTED,
                    ).apply {
                        setPadding(dp(8), dp(20), dp(8), dp(20))
                        setLineSpacing(0f, 1.18f)
                    },
                )
            } else {
                messages.forEach(::renderSideChatMessage)
                if (chatPendingUser.isNotBlank()) {
                    renderSideChatMessage(
                        SideChatMessage(
                            id = "",
                            role = "user",
                            content = chatPendingUser,
                            createdAt = System.currentTimeMillis(),
                        ),
                        editable = false,
                    )
                }
            }
            if (chatBusy) {
                renderSideChatProgress()
            } else {
                pendingChatAction?.let(::renderPendingChatAction)
            }
            renderSideChatComposer()
            scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
            if (restoreKeyboard) {
                focusChatInput(showKeyboard = true)
            } else {
                root.requestFocus()
                root.post {
                    if (screenState == PanelScreenState.CHAT && !closed) {
                        root.requestFocus()
                        hideImeOnly()
                    }
                }
            }
        }

        @android.annotation.SuppressLint("ClickableViewAccessibility")
        private fun renderSideChatHeader() {
            val header = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(3), 0, 0, dp(10))
                contentDescription = "사이드 채팅 창 이동"
            }
            header.addView(
                Ui.label(this@OverlayService, "사이드 채팅", 18f, Ui.PANEL_TEXT, true).apply {
                    maxLines = 1
                    setAutoSizeTextTypeUniformWithConfiguration(10, 18, 1, TypedValue.COMPLEX_UNIT_SP)
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            header.addView(
                Ui.iconButton(this@OverlayService, UiIcon.NEW, "새 사이드 채팅") { requestNewSideChat() }.apply {
                    contentDescription = "새 사이드 채팅"
                    isEnabled = !chatBusy
                    alpha = if (chatBusy) 0.34f else 1f
                },
                LinearLayout.LayoutParams(dp(44), dp(44)),
            )
            header.addView(
                Ui.quietButton(this@OverlayService, "글로") { returnFromSideChat() }.apply {
                    contentDescription = "글 강화기로 돌아가기"
                    maxLines = 1
                    setPadding(dp(4), dp(4), dp(4), dp(4))
                    setAutoSizeTextTypeUniformWithConfiguration(10, 13, 1, TypedValue.COMPLEX_UNIT_SP)
                    setTextColor(Ui.ACCENT_TEXT)
                    background = Ui.interactive(this@OverlayService, Ui.ACCENT_SURFACE)
                },
                LinearLayout.LayoutParams(dp(48), dp(44)),
            )
            header.addView(
                Ui.iconButton(this@OverlayService, UiIcon.SETTINGS, "설정") { openSettings(it) },
                LinearLayout.LayoutParams(dp(44), dp(44)),
            )
            header.addView(
                Ui.iconButton(this@OverlayService, UiIcon.CLOSE, "버블로 접기") { close() },
                LinearLayout.LayoutParams(dp(44), dp(44)),
            )
            header.setOnTouchListener(
                WindowDragTouchListener(
                    view = header,
                    onDelta = { deltaX, deltaY -> movePanelBy(deltaX, deltaY) },
                    onFinished = { persistPanelGeometry() },
                ),
            )
            headerHost.addView(header)
        }

        private fun renderSideChatContext() {
            val contextText = when {
                session.draft.isNotBlank() ->
                    "현재 강화 결과 연동 · ${session.versions.size.coerceAtLeast(1)}개 버전"
                session.rawInput.isNotBlank() || session.situation.isNotBlank() ->
                    "현재 작성 중인 원문 연동"
                else -> "자유롭게 대화하기 · 베타"
            }
            content.addView(
                Ui.label(
                    this@OverlayService,
                    contextText,
                    11f,
                    Ui.PANEL_MUTED,
                ).apply {
                    setPadding(dp(4), dp(2), dp(4), dp(10))
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(10) },
            )
        }

        private fun renderSideChatMessage(
            message: SideChatMessage,
            editable: Boolean = true,
        ) {
            val isUser = message.role == "user"
            val visibleContent = if (isUser) {
                message.content
            } else {
                SideChatDisplayPolicy.clean(
                    message.content,
                    message.sources.isNotEmpty() || message.untrustedExternalContext,
                )
            }
            val row = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = if (isUser) Gravity.END else Gravity.START
                setPadding(0, dp(4), 0, dp(4))
            }
            if (isUser && editable && chatEditingMessageId == message.id) {
                val editorStack = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.END
                }
                val editor = backAwareEditText(
                    hintText = "사용자 메시지 수정",
                    textValue = message.content,
                    minRows = 2,
                    maxRows = layoutProfile.answerMaxRows,
                    textSizeSp = 13f,
                    showEditTools = true,
                )
                editorStack.addView(
                    editor,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
                val actions = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.END
                }
                actions.addView(
                    Ui.quietButton(this@OverlayService, "취소") {
                        chatEditingMessageId = ""
                        renderSideChat()
                    },
                )
                actions.addView(
                    Ui.quietButton(this@OverlayService, "수정 완료") {
                        editSideChatMessage(message.id, editor.text?.toString().orEmpty())
                    },
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        dp(38),
                    ).apply { marginStart = dp(6) },
                )
                editorStack.addView(
                    actions,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(38),
                    ).apply { topMargin = dp(5) },
                )
                row.addView(
                    editorStack,
                    LinearLayout.LayoutParams(
                        (panelParams?.width ?: dp(320)) * 4 / 5,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            } else {
                val messageAction = MobileUiPolicy.sideChatMessageAction(
                    role = message.role,
                    editable = editable,
                    busy = chatBusy,
                    hasMessageId = message.id.isNotBlank(),
                    hasContent = message.content.isNotBlank(),
                )
                val actionSpace = if (messageAction != SideChatMessageAction.NONE) {
                    dp(44)
                } else {
                    0
                }
                val availableWidth = (panelParams?.width ?: dp(320)) -
                    dp(layoutProfile.horizontalPaddingDp * 2) - actionSpace - dp(5)
                val maximumBubbleWidth = if (isUser) (availableWidth * 0.88f).toInt() else availableWidth
                val bubble = Ui.label(
                    this@OverlayService,
                    visibleContent,
                    15f,
                    Ui.PANEL_TEXT,
                ).apply {
                    maxWidth = maximumBubbleWidth
                    setPadding(dp(14), dp(13), dp(14), dp(13))
                    setLineSpacing(dp(2).toFloat(), 1.22f)
                    background = Ui.rounded(
                        if (isUser) Ui.ACCENT_SURFACE else Ui.PANEL_RAISED,
                        18,
                        this@OverlayService,
                    )
                    if (!isUser) {
                        text = ChatTextFormatter.render(visibleContent)
                        setTextIsSelectable(true)
                    }
                }
                if (messageAction == SideChatMessageAction.EDIT_LEFT) {
                    row.addView(
                        Ui.iconButton(this@OverlayService, UiIcon.EDIT, "이 메시지 수정") {
                            chatEditingMessageId = message.id
                            chatClearConfirmation = false
                            renderSideChat()
                        }.apply { contentDescription = "이 메시지 수정" },
                        LinearLayout.LayoutParams(
                            dp(44),
                            dp(44),
                        ).apply { marginEnd = dp(5) },
                    )
                }
                val bubbleStack = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.START
                    addView(
                        bubble,
                        LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                        ),
                    )
                    if (!isUser && message.sourcesMissing) {
                        addView(
                            Ui.label(
                                this@OverlayService,
                                SideChatDisplayPolicy.SOURCES_MISSING_NOTE,
                                12f,
                                0xFFFFD58A.toInt(),
                            ).apply {
                                maxWidth = maximumBubbleWidth
                                setPadding(dp(10), dp(7), dp(10), dp(7))
                                setLineSpacing(dp(1).toFloat(), 1.15f)
                                background = Ui.rounded(0x33E0A23A, 10, this@OverlayService)
                            },
                            LinearLayout.LayoutParams(
                                ViewGroup.LayoutParams.WRAP_CONTENT,
                                ViewGroup.LayoutParams.WRAP_CONTENT,
                            ).apply { topMargin = dp(5) },
                        )
                    }
                    if (!isUser && message.sources.isNotEmpty()) {
                        addView(renderSideChatSources(message.sources, maximumBubbleWidth))
                    }
                    if (!isUser && message.followUpQueries.isNotEmpty()) {
                        addView(
                            renderSideChatFollowUps(
                                message.followUpQueries,
                                maximumBubbleWidth,
                            ),
                        )
                    }
                }
                row.addView(
                    bubbleStack,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
                if (messageAction == SideChatMessageAction.COPY_RIGHT) {
                    row.addView(
                        Ui.iconButton(this@OverlayService, UiIcon.COPY, "선택한 부분 또는 전체 AI 답변 복사") {
                            copySideChatAnswer(bubble, bubble.text.toString())
                        }.apply {
                            contentDescription = "선택한 부분 또는 전체 AI 답변 복사"
                        },
                        LinearLayout.LayoutParams(
                            dp(44),
                            dp(44),
                        ).apply { marginStart = dp(5) },
                    )
                }
            }
            content.addView(
                row,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }

        private fun renderSideChatProgress() {
            val label = Ui.label(
                this@OverlayService,
                SideChatDisplayPolicy.progressLabel(
                    chatProgress,
                    System.currentTimeMillis() - chatProgressStartedAt,
                ),
                13f,
                Ui.PANEL_MUTED,
                true,
            ).apply {
                setPadding(dp(14), dp(11), dp(14), dp(11))
                background = Ui.rounded(Ui.PANEL_RAISED, 18, this@OverlayService)
                contentDescription = "AI가 답변 중"
            }
            chatProgressLabel = label
            content.addView(
                LinearLayout(this@OverlayService).apply {
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

        private fun renderPendingChatAction(action: SideChatAction) {
            val card = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(13), dp(12), dp(13), dp(10))
                background = Ui.rounded(Ui.ACCENT_SURFACE, 16, this@OverlayService)
                contentDescription = "제안 적용 확인"
            }
            card.addView(
                Ui.label(this@OverlayService, SharedSideChatRules.PENDING_TITLE, 14f, Ui.PANEL_TEXT, true),
            )
            card.addView(
                Ui.label(
                    this@OverlayService,
                    SideChatDisplayPolicy.pendingActionLabel(action),
                    13f,
                    Ui.ACCENT_TEXT,
                    true,
                ).apply { setPadding(0, dp(5), 0, 0) },
            )
            SideChatDisplayPolicy.pendingActionPreview(action)?.let { preview ->
                card.addView(
                    Ui.label(this@OverlayService, preview, 13f, Ui.PANEL_TEXT).apply {
                        setPadding(dp(10), dp(8), dp(10), dp(8))
                        setLineSpacing(dp(1).toFloat(), 1.18f)
                        maxLines = 8
                        ellipsize = TextUtils.TruncateAt.END
                        background = Ui.rounded(Ui.PANEL_FIELD, 10, this@OverlayService)
                    },
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(8) },
                )
            }
            card.addView(
                Ui.label(
                    this@OverlayService,
                    SharedSideChatRules.PENDING_NOTE,
                    11f,
                    Ui.PANEL_MUTED,
                ).apply { setPadding(0, dp(8), 0, dp(8)) },
            )
            val buttons = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
            }
            buttons.addView(
                Ui.quietButton(this@OverlayService, "취소") { dismissPendingChatAction() },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)),
            )
            buttons.addView(
                compactAction("적용", Ui.ACCENT).apply {
                    contentDescription = "제안한 변경 적용"
                    setOnClickListener { applyPendingChatAction() }
                },
                LinearLayout.LayoutParams(dp(84), dp(44)).apply { marginStart = dp(6) },
            )
            card.addView(
                buttons,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)),
            )
            content.addView(
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

        private fun applyPendingChatAction() {
            val action = pendingChatAction ?: return
            if (chatBusy) return
            pendingChatAction = null
            executeSideChatAction(action)
            if (screenState == PanelScreenState.CHAT && !closed) renderSideChat()
        }

        private fun dismissPendingChatAction() {
            if (pendingChatAction == null) return
            pendingChatAction = null
            chatScreenNotice = SharedSideChatRules.PENDING_DISMISSED
            renderSideChat()
        }

        private fun startChatProgress() {
            chatProgress = null
            chatProgressStartedAt = System.currentTimeMillis()
            root.removeCallbacks(chatProgressTicker)
            root.postDelayed(chatProgressTicker, 1_000)
        }

        private fun stopChatProgress() {
            if (::root.isInitialized) root.removeCallbacks(chatProgressTicker)
            chatProgress = null
            chatProgressStartedAt = 0L
            chatProgressLabel = null
        }

        private fun stopSideChatReply() {
            if (!chatBusy) return
            chatRequest?.cancel()
            chatRequest = null
            chatRequestToken += 1
            chatBusy = false
            stopChatProgress()
            activeChatScreen?.let(::deleteChatScreenFile)
            activeChatScreen = null
            if (chatPendingUser.isNotBlank()) {
                chatDraft = chatPendingUser
                retainedChatDraft = chatPendingUser
            }
            chatSearchMode = chatActiveForceSearch
            chatPendingUser = ""
            chatError = ""
            chatScreenNotice = SharedSideChatRules.CANCELLED
            renderSideChat()
        }

        private fun renderSideChatSources(
            sources: List<WebSource>,
            maximumWidth: Int,
        ): View {
            return LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(4), dp(5), dp(2), 0)
                val sourceDetails = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.VERTICAL
                    visibility = View.GONE
                }
                val toggle = Ui.label(
                    this@OverlayService,
                    "출처 ${sources.size.coerceAtMost(6)}개 보기  ▾",
                    10f,
                    0xFFD8D2F0.toInt(),
                    true,
                ).apply {
                    textSize = 12f
                    maxWidth = maximumWidth
                    minHeight = dp(44)
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(9), dp(4), dp(9), dp(4))
                    background = Ui.interactive(this@OverlayService, Color.TRANSPARENT)
                    isClickable = true
                    isFocusable = true
                    contentDescription = "답변 출처 펼치기"
                    setOnClickListener {
                        val opening = sourceDetails.visibility != View.VISIBLE
                        sourceDetails.visibility = if (opening) View.VISIBLE else View.GONE
                        text = if (opening) {
                            "출처 ${sources.size.coerceAtMost(6)}개 접기  ▴"
                        } else {
                            "출처 ${sources.size.coerceAtMost(6)}개 보기  ▾"
                        }
                        contentDescription = if (opening) "답변 출처 접기" else "답변 출처 펼치기"
                    }
                }
                addView(
                    toggle,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        dp(44),
                    ),
                )
                sources.take(6).forEachIndexed { index, source ->
                    val host = runCatching { Uri.parse(source.url).host.orEmpty() }.getOrDefault("")
                    sourceDetails.addView(
                        Ui.label(
                            this@OverlayService,
                            buildString {
                                append("${index + 1}. ${source.title}")
                                if (host.isNotBlank()) append("\n$host")
                            },
                            10f,
                            0xFFD8D2F0.toInt(),
                            true,
                        ).apply {
                            textSize = 12f
                            maxWidth = maximumWidth
                            maxLines = 2
                            ellipsize = TextUtils.TruncateAt.END
                            minHeight = dp(48)
                            gravity = Gravity.CENTER_VERTICAL
                            setPadding(dp(9), dp(4), dp(9), dp(4))
                            background = Ui.rounded(
                                0x243E2B72,
                                9,
                                this@OverlayService,
                            )
                            contentDescription = "출처 ${index + 1} 열기: ${source.title}"
                            isClickable = true
                            isFocusable = true
                            setOnClickListener { openSideChatSource(source) }
                        },
                        LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                        ).apply { topMargin = dp(3) },
                    )
                }
                addView(
                    sourceDetails,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            }
        }

        private fun openSideChatSource(source: WebSource) {
            val uri = runCatching { Uri.parse(source.url) }.getOrNull()
            if (uri == null || uri.scheme !in setOf("https", "http")) {
                Toast.makeText(
                    this@OverlayService,
                    "출처 링크를 열지 못했어요.",
                    Toast.LENGTH_SHORT,
                ).show()
                return
            }
            runCatching {
                startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }.onFailure {
                Toast.makeText(
                    this@OverlayService,
                    "출처 링크를 열 수 있는 앱이 없어요.",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }

        private fun renderSideChatFollowUps(
            queries: List<String>,
            maximumWidth: Int,
        ): View = LinearLayout(this@OverlayService).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(7), dp(2), 0)
            addView(
                Ui.label(
                    this@OverlayService,
                    "이어서 탐색",
                    10f,
                    0xFFAAA3BC.toInt(),
                    true,
                ),
            )
            val chipRow = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            queries.take(3).forEach { query ->
                chipRow.addView(
                    Ui.label(
                        this@OverlayService,
                        "› $query",
                        10f,
                        0xFFE4DFFF.toInt(),
                        true,
                    ).apply {
                        textSize = 12f
                        maxWidth = (maximumWidth * 4 / 5).coerceAtLeast(dp(140))
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                        minHeight = dp(48)
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(8), dp(7), dp(8), dp(7))
                        background = Ui.interactive(this@OverlayService, Ui.PANEL_RAISED, 12)
                        contentDescription = "후속 검색 바로 실행: $query"
                        isClickable = true
                        isFocusable = true
                        setOnClickListener { applySideChatFollowUp(query) }
                    },
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { marginEnd = dp(5) },
                )
            }
            addView(
                HorizontalScrollView(this@OverlayService).apply {
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

        private fun applySideChatFollowUp(query: String) {
            if (
                !SideChatSearchPolicy.canSubmitFollowUp(
                    query = query,
                    busy = chatBusy,
                    clearConfirmation = chatClearConfirmation,
                )
            ) return
            val normalized = SearchFollowUpPolicy
                .normalize(listOf(query))
                .first()
            chatDraft = normalized
            chatInput?.apply {
                setText(normalized)
                setSelection(normalized.length)
            }
            chatError = ""
            keepChatKeyboard = false
            sendSideChatMessage(
                restoreKeyboardOverride = false,
                forceSearch = true,
            )
        }

        private fun renderSideChatComposer() {
            pendingChatScreen?.let { visual ->
                val previewCard = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(7), dp(7), dp(7), dp(6))
                    background = Ui.rounded(0x333E2B72, 12, this@OverlayService)
                }
                val previewImage = ImageView(this@OverlayService).apply {
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    adjustViewBounds = false
                    contentDescription = "검색 전 이미지 미리보기 · 영역 선택 열기"
                    background = Ui.rounded(0xFF24232B.toInt(), 10, this@OverlayService)
                    decodeChatVisualPreview(visual.path)?.let(::setImageBitmap)
                    setOnClickListener { openSideChatVisualPreview(visual) }
                }
                previewCard.addView(
                    previewImage,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(104),
                    ),
                )
                val previewActions = LinearLayout(this@OverlayService).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(
                        Ui.label(
                            this@OverlayService,
                            visual.displayName,
                            10f,
                            0xFFD8D2F0.toInt(),
                            true,
                        ).apply {
                            maxLines = 1
                            ellipsize = TextUtils.TruncateAt.END
                        },
                        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
                    )
                    addView(
                        Ui.quietButton(this@OverlayService, "영역 선택") {
                            openSideChatVisualPreview(visual)
                        }.apply { contentDescription = "이미지 부분 영역 선택" },
                    )
                    addView(
                        Ui.quietButton(this@OverlayService, "×") {
                            discardPendingChatScreen()
                            chatScreenNotice = "이미지 사용을 해제했어요."
                            renderSideChat()
                        }.apply { contentDescription = "검색 이미지 제거" },
                        LinearLayout.LayoutParams(dp(42), dp(38)).apply { marginStart = dp(4) },
                    )
                }
                previewCard.addView(
                    previewActions,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(40),
                    ).apply { topMargin = dp(4) },
                )
                stickyActions.addView(
                    previewCard,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { bottomMargin = dp(6) },
                )
            }
            val screenRow = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            screenRow.addView(
                Ui.quietButton(
                    this@OverlayService,
                    "▣ 화면",
                ) { toggleSideChatScreen() }.apply {
                    isEnabled = !chatBusy && !chatClearConfirmation
                    alpha = if (isEnabled) 1f else 0.4f
                    contentDescription = "현재 화면 한 장을 촬영해 다음 질문에 함께 보내기"
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    dp(48),
                ),
            )
            screenRow.addView(
                Ui.quietButton(
                    this@OverlayService,
                    "▧ 이미지",
                ) { pickSideChatImage() }.apply {
                    isEnabled = !chatBusy && !chatClearConfirmation
                    alpha = if (isEnabled) 1f else 0.4f
                    contentDescription = "질문에 함께 보낼 이미지 파일 첨부"
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    dp(48),
                ).apply { marginStart = dp(5) },
            )
            screenRow.addView(
                Ui.quietButton(
                    this@OverlayService,
                    if (chatSearchMode) "⌕ 검색 켬" else "⌕ 검색",
                ) { toggleSideChatSearchMode() }.apply {
                    isEnabled = !chatBusy && !chatClearConfirmation
                    alpha = if (isEnabled) 1f else 0.4f
                    if (chatSearchMode) {
                        setTextColor(Ui.ACCENT_TEXT)
                        background = Ui.interactive(this@OverlayService, Ui.ACCENT_SURFACE, 12)
                    }
                    contentDescription = if (chatSearchMode) {
                        "다음 질문 웹 검색 켜짐. 누르면 끕니다"
                    } else {
                        "다음 질문을 웹에서 검색"
                    }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    dp(48),
                ).apply { marginStart = dp(5) },
            )
            if (chatScreenNotice.isNotBlank()) {
                screenRow.addView(
                    Ui.label(
                        this@OverlayService,
                        chatScreenNotice,
                        10f,
                        if (chatScreenNotice.startsWith("화면을 가져오지")) {
                            0xFFFF9B9B.toInt()
                        } else {
                            Ui.PANEL_MUTED
                        },
                    ).apply {
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                        setPadding(dp(7), 0, 0, 0)
                    },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
                )
            }
            stickyActions.addView(
                screenRow,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(5) },
            )
            chatInput = backAwareEditText(
                hintText = "사이드 채팅에 입력",
                textValue = chatDraft,
                minRows = 1,
                maxRows = layoutProfile.answerMaxRows,
                textSizeSp = 15f,
                showEditTools = true,
            ).also { field ->
                field.isEnabled = !chatBusy && !chatClearConfirmation
                field.imeOptions = EditorInfo.IME_ACTION_SEND
                field.setOnEditorActionListener { _, actionId, _ ->
                    if (actionId == EditorInfo.IME_ACTION_SEND) {
                        sendSideChatMessage()
                        true
                    } else {
                        false
                    }
                }
                field.addTextChangedListener(
                    object : TextWatcher {
                        override fun beforeTextChanged(
                            text: CharSequence?,
                            start: Int,
                            count: Int,
                            after: Int,
                        ) = Unit

                        override fun onTextChanged(
                            text: CharSequence?,
                            start: Int,
                            before: Int,
                            count: Int,
                        ) {
                            chatDraft = text?.toString().orEmpty()
                        }

                        override fun afterTextChanged(editable: Editable?) = Unit
                    },
                )
            }
            chatInput?.let { field ->
                screenRow.addView(
                    editMenuController.menuButton(field).apply {
                        contentDescription = "사이드 채팅 편집 메뉴"
                    },
                    2,
                    LinearLayout.LayoutParams(dp(48), dp(48)).apply {
                        marginStart = dp(5)
                    },
                )
            }
            stickyActions.addView(
                chatInput,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )

            if (chatClearConfirmation) {
                stickyActions.addView(
                    Ui.label(
                        this@OverlayService,
                        "현재 사이드 채팅 대화만 지울까요?",
                        12f,
                        Ui.PANEL_MUTED,
                    ).apply { setPadding(dp(4), dp(7), 0, dp(4)) },
                )
            }

            val row = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            if (chatClearConfirmation) {
                row.addView(
                    compactAction("취소", Ui.PANEL_FIELD).apply {
                        setOnClickListener {
                            chatClearConfirmation = false
                            renderSideChat()
                        }
                    },
                    LinearLayout.LayoutParams(0, dp(layoutProfile.actionHeightDp), 1f),
                )
                row.addView(
                    compactAction("지우기", 0xFF7C3844.toInt()).apply {
                        setOnClickListener { clearSideChat() }
                    },
                    LinearLayout.LayoutParams(0, dp(layoutProfile.actionHeightDp), 1f).apply {
                        marginStart = dp(6)
                    },
                )
            } else {
                row.addView(
                    compactAction(
                        if (chatBusy) "중단" else "보내기",
                        if (chatBusy) 0xFF3A3550.toInt() else Ui.ACCENT,
                    ).apply {
                        contentDescription = if (chatBusy) "답변 중단" else "메시지 보내기"
                        setOnClickListener {
                            if (chatBusy) stopSideChatReply() else sendSideChatMessage()
                        }
                    },
                    LinearLayout.LayoutParams(0, dp(layoutProfile.actionHeightDp), 1f),
                )
            }
            stickyActions.addView(
                row,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(layoutProfile.actionHeightDp),
                ).apply { topMargin = dp(6) },
            )
        }

        private fun toggleSideChatSearchMode() {
            if (chatBusy || chatClearConfirmation) return
            chatInput?.let { chatDraft = it.text?.toString().orEmpty() }
            chatSearchMode = !chatSearchMode
            chatScreenNotice = if (chatSearchMode) {
                SharedSideChatRules.SEARCH_MODE_ON
            } else {
                SharedSideChatRules.SEARCH_MODE_OFF
            }
            keepChatKeyboard = focusedEditor() === chatInput || imeVisible
            renderSideChat()
        }

        private fun toggleSideChatScreen() {
            if (chatBusy || chatClearConfirmation) return
            chatInput?.let { chatDraft = it.text?.toString().orEmpty() }
            chatScreenNotice = "화면 공유 권한을 확인하는 중…"
            launchBridge(
                BridgeActivity.ACTION_CAPTURE_SCREEN,
                BridgeActivity.TARGET_SIDE_CHAT_SCREEN,
                affectsWriting = false,
            )
        }

        private fun pickSideChatImage() {
            if (chatBusy || chatClearConfirmation) return
            chatInput?.let { chatDraft = it.text?.toString().orEmpty() }
            chatScreenNotice = "이미지 선택기를 여는 중…"
            launchBridge(
                BridgeActivity.ACTION_PICK_ATTACHMENT,
                BridgeActivity.TARGET_SIDE_CHAT_VISUAL,
                affectsWriting = false,
            )
        }

        private fun decodeChatVisualPreview(path: String): android.graphics.Bitmap? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (bounds.outWidth / sample > 720 || bounds.outHeight / sample > 720) {
                sample *= 2
            }
            return runCatching {
                BitmapFactory.decodeFile(
                    path,
                    BitmapFactory.Options().apply { inSampleSize = sample.coerceAtLeast(1) },
                )
            }.getOrNull()
        }

        private fun openSideChatVisualPreview(visual: AttachmentRef) {
            if (chatBusy || bridgeInProgress) return
            chatInput?.let { chatDraft = it.text?.toString().orEmpty() }
            hideKeyboard()
            bridgeInProgress = true
            root.visibility = View.INVISIBLE
            val preview = Intent(this@OverlayService, ImageCropActivity::class.java)
                .putExtra(ImageCropActivity.EXTRA_PATH, visual.path)
                .putExtra(ImageCropActivity.EXTRA_NAME, visual.displayName)
                .putExtra(ImageCropActivity.EXTRA_SOURCE, visual.source)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            runCatching { startActivity(preview) }
                .onFailure {
                    bridgeInProgress = false
                    restoreAfterBridge()
                    chatScreenNotice = "이미지 미리보기를 열지 못했어요."
                    renderSideChat()
                }
        }

        private fun sideChatWritingContext(): SideChatWritingContext =
            SideChatWritingContext(
                view = when {
                    session.guessQuestion -> "guess"
                    session.draft.isNotBlank() -> "result"
                    else -> "input"
                },
                situation = session.situation,
                rawInput = session.rawInput,
                completedText = session.draft,
                followUp = session.question,
                reply = session.answer,
                enhancementLevel = session.enhancementLevel,
                versionIndex = session.versionIndex,
                versionCount = session.versions.size,
                attachmentNames = session.attachments.map { it.displayName },
            )

        private fun sendSideChatMessage(
            restoreKeyboardOverride: Boolean? = null,
            forceSearch: Boolean = false,
        ) {
            if (chatBusy || chatRequest?.isDone == false) return
            chatInput?.let { chatDraft = it.text?.toString().orEmpty() }
            val inputText = SideChatPolicy.clean("user", chatDraft)
            if (inputText.isBlank()) {
                chatError = "메시지를 먼저 입력해 주세요."
                renderSideChat()
                return
            }
            val previous = sideChatStore.list()
            val restoreKeyboard = restoreKeyboardOverride
                ?: (focusedEditor() === chatInput || imeVisible)
            val screenContext = takePendingChatScreen()
            val requestForceSearch = forceSearch || chatSearchMode
            chatSearchMode = false
            pendingChatAction = null
            chatDraft = ""
            chatPendingUser = inputText
            chatError = ""
            chatBusy = true
            keepChatKeyboard = restoreKeyboard
            renderSideChat()
            requestSideChat(
                inputText = inputText,
                previousMessages = previous,
                editedMessageAlreadyStored = false,
                restoreKeyboard = restoreKeyboard,
                screenContext = screenContext,
                forceSearch = requestForceSearch,
            )
        }

        private fun editSideChatMessage(messageId: String, text: String) {
            if (chatBusy || chatRequest?.isDone == false) return
            val cleaned = SideChatPolicy.clean("user", text)
            if (cleaned.isBlank()) {
                chatError = "수정할 메시지를 입력해 주세요."
                renderSideChat()
                return
            }
            val rewritten = sideChatStore.rewriteFromUser(messageId, cleaned)
            if (rewritten == null) {
                chatEditingMessageId = ""
                chatError = "수정할 메시지를 찾지 못했어요."
                renderSideChat()
                return
            }
            val restoreKeyboard = focusedEditor() != null || imeVisible
            val screenContext = takePendingChatScreen()
            pendingChatAction = null
            chatEditingMessageId = ""
            chatPendingUser = ""
            chatError = ""
            chatBusy = true
            keepChatKeyboard = restoreKeyboard
            renderSideChat()
            requestSideChat(
                inputText = cleaned,
                previousMessages = rewritten.dropLast(1),
                editedMessageAlreadyStored = true,
                restoreKeyboard = restoreKeyboard,
                screenContext = screenContext,
            )
        }

        private fun requestSideChat(
            inputText: String,
            previousMessages: List<SideChatMessage>,
            editedMessageAlreadyStored: Boolean,
            restoreKeyboard: Boolean,
            screenContext: AttachmentRef?,
            forceSearch: Boolean = false,
        ) {
            val token = ++chatRequestToken
            chatActiveForceSearch = forceSearch
            startChatProgress()
            chatRequest = aiClient.chat(
                SideChatRequest(
                    input = inputText,
                    messages = previousMessages,
                    writingContext = sideChatWritingContext(),
                    screenContext = screenContext,
                    forceSearch = forceSearch,
                ),
                onProgress = { progress ->
                    if (token == chatRequestToken && chatBusy && !closed) {
                        chatProgress = progress
                        chatProgressLabel?.text = SideChatDisplayPolicy.progressLabel(
                            progress,
                            System.currentTimeMillis() - chatProgressStartedAt,
                        )
                    }
                },
            ) { result ->
                // 화면 임시 파일은 응답이 늦게 도착하거나 무시되더라도 항상 삭제한다.
                finishChatScreenRequest(screenContext)
                if (stopping || panel !== this || closed || token != chatRequestToken) {
                    return@chat
                }
                chatBusy = false
                stopChatProgress()
                result.fold(
                    onSuccess = { response ->
                        val visibleResponse = response.copy(
                            reply = SideChatDisplayPolicy.clean(
                                response.reply,
                                response.sources.isNotEmpty() || response.untrustedExternalContext,
                            ),
                        )
                        if (editedMessageAlreadyStored) {
                            sideChatStore.appendAssistant(
                                visibleResponse.reply,
                                visibleResponse.sources,
                                visibleResponse.followUpQueries,
                                visibleResponse.untrustedExternalContext,
                                visibleResponse.sourcesMissing,
                            )
                        } else {
                            sideChatStore.appendExchange(
                                inputText,
                                visibleResponse.reply,
                                visibleResponse.sources,
                                visibleResponse.followUpQueries,
                                visibleResponse.untrustedExternalContext,
                                visibleResponse.sourcesMissing,
                            )
                        }
                        chatPendingUser = ""
                        chatDraft = ""
                        retainedChatDraft = ""
                        chatError = ""
                        val action = visibleResponse.action
                        // AI 계층의 판단에 더해 UI 실행 경계에서도 외부 자료 여부를 다시 확인한다.
                        val needsConfirmation = visibleResponse.actionRequiresConfirmation ||
                            SideChatSearchPolicy.requiresConfirmation(
                                action,
                                SideChatSearchPolicy.isExternallyGrounded(
                                    screenContext,
                                    visibleResponse.sources,
                                    visibleResponse.usedWebSearch,
                                    visibleResponse.untrustedExternalContext,
                                ),
                            )
                        pendingChatAction = action.takeIf {
                            needsConfirmation && it.name != SideChatAction.NONE
                        }
                        if (screenState == PanelScreenState.CHAT) {
                            keepChatKeyboard = restoreKeyboard && pendingChatAction == null
                            renderSideChat()
                        }
                        if (!needsConfirmation) executeSideChatAction(action)
                    },
                    onFailure = { failure ->
                        chatPendingUser = ""
                        if (!editedMessageAlreadyStored) {
                            chatDraft = inputText
                            retainedChatDraft = inputText
                        }
                        chatSearchMode = forceSearch
                        chatError = failure.message?.take(180)
                            ?: "채팅 답변을 가져오지 못했어요."
                        if (screenState == PanelScreenState.CHAT) {
                            keepChatKeyboard = restoreKeyboard
                            renderSideChat()
                        } else {
                            Toast.makeText(
                                this@OverlayService,
                                chatError,
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                    },
                )
            }
        }

        private fun requestNewSideChat() {
            if (chatBusy) return
            if (sideChatStore.list().isEmpty()) {
                clearSideChat()
            } else {
                chatClearConfirmation = true
                renderSideChat()
            }
        }

        private fun clearSideChat() {
            if (chatBusy) return
            val restoreKeyboard = focusedEditor() === chatInput || imeVisible
            sideChatStore.clear()
            discardPendingChatScreen()
            pendingChatAction = null
            chatSearchMode = false
            chatScreenNotice = ""
            chatDraft = ""
            retainedChatDraft = ""
            chatPendingUser = ""
            chatEditingMessageId = ""
            chatClearConfirmation = false
            chatError = ""
            keepChatKeyboard = restoreKeyboard
            renderSideChat()
        }

        private fun returnFromSideChat() {
            chatInput?.let { chatDraft = it.text?.toString().orEmpty() }
            chatEditingMessageId = ""
            chatClearConfirmation = false
            discardPendingChatScreen()
            chatScreenNotice = ""
            hideKeyboard()
            when (chatReturnScreen) {
                PanelScreenState.GUESS -> {
                    if (session.guessQuestion && session.question.isNotBlank()) {
                        renderGuessQuestion(session.question)
                    } else {
                        renderInput()
                    }
                }
                PanelScreenState.RESULT -> {
                    if (session.draft.isNotBlank()) renderStoredResult() else renderInput()
                }
                PanelScreenState.HISTORY -> renderHistory()
                else -> renderInput()
            }
        }

        private fun renderWritingState() {
            when {
                session.guessQuestion && session.question.isNotBlank() ->
                    renderGuessQuestion(session.question)
                session.draft.isBlank() -> renderInput()
                else -> renderStoredResult()
            }
        }

        private fun writingScreenForSession(): PanelScreenState = when {
            session.guessQuestion && session.question.isNotBlank() -> PanelScreenState.GUESS
            session.draft.isBlank() -> PanelScreenState.INPUT
            else -> PanelScreenState.RESULT
        }

        private fun rememberCollapsedSurface() {
            lastPanelSurface = MobileUiPolicy.surfaceForCollapse(screenState)
            getSharedPreferences(STATE_PREFS, MODE_PRIVATE)
                .edit()
                .putString(STATE_LAST_PANEL_SURFACE, lastPanelSurface.name)
                .apply()
        }

        private fun executeSideChatAction(action: SideChatAction) {
            if (action.name == SideChatAction.NONE) return
            when (action.name) {
                "show_writing" -> renderWritingState()
                "focus_source" -> {
                    renderInput()
                    input?.post { focusEditor(input) }
                }
                "replace_source" -> {
                    session.clear()
                    workspaceStore.clearDraft()
                    session.rawInput = action.value
                    persistDraft()
                    renderInput()
                    Toast.makeText(
                        this@OverlayService,
                        "채팅의 내용을 원문에 반영했어요.",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                "set_situation" -> {
                    session.situation = action.value
                    situationExpanded = true
                    persistDraft()
                    renderInput()
                    Toast.makeText(
                        this@OverlayService,
                        "상황 안내를 반영했어요.",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                "replace_result" -> replaceResultFromSideChat(action.value)
                "set_follow_up_reply" -> {
                    if (session.draft.isBlank()) {
                        Toast.makeText(
                            this@OverlayService,
                            "후속 요구를 넣을 결과가 아직 없어요.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        session.answer = action.value
                        persistDraft()
                        renderStoredResult()
                    }
                }
                "enhance" -> {
                    renderInput()
                    startCompletion(questionFirst = false, loadingButton = completeButton)
                }
                "reenhance" -> {
                    if (session.draft.isBlank()) {
                        renderInput()
                        Toast.makeText(
                            this@OverlayService,
                            "먼저 완성할 글을 입력해 주세요.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        renderStoredResult()
                        submit(
                            rawInput = session.rawInput,
                            currentDraft = null,
                            answer = null,
                            questionFirst = false,
                            regenerateFromOriginal = true,
                            controller = this,
                            loadingButton = reenhanceButton,
                        )
                    }
                }
                "copy_result" -> {
                    if (session.draft.isBlank()) {
                        Toast.makeText(
                            this@OverlayService,
                            "복사할 강화 결과가 아직 없어요.",
                            Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        copyAndClose(session.draft)
                    }
                }
                "new_writing" -> {
                    session.clear()
                    workspaceStore.clearDraft()
                    renderInput()
                }
                "open_history" -> renderHistory()
                "open_settings", "open_memories" -> {
                    renderWritingState()
                    root.post { openSettings(root) }
                }
                "open_tools" -> {
                    toolsExpanded = true
                    renderInput()
                }
                "set_enhancement_level" -> {
                    session.enhancementLevel =
                        EnhancementLevelPolicy.normalize(action.value.toIntOrNull() ?: 3)
                    persistDraft()
                    renderWritingState()
                    Toast.makeText(
                        this@OverlayService,
                        "강화 범위를 ${session.enhancementLevel}단계로 바꿨어요.",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                "previous_result" -> {
                    if (session.draft.isNotBlank()) {
                        renderStoredResult()
                        moveVersion(previous = true)
                    }
                }
                "next_result" -> {
                    if (session.draft.isNotBlank()) {
                        renderStoredResult()
                        moveVersion(previous = false)
                    }
                }
                "guess_intent" -> {
                    renderInput()
                    startCompletion(questionFirst = true, loadingButton = completeButton)
                }
            }
        }

        private fun replaceResultFromSideChat(value: String) {
            val replacement = value.trim()
            if (session.draft.isBlank() || replacement.isBlank()) {
                Toast.makeText(
                    this@OverlayService,
                    "먼저 완성된 결과가 필요해요.",
                    Toast.LENGTH_SHORT,
                ).show()
                return
            }
            val current = session.versions.getOrNull(session.versionIndex)
            val stored = workspaceStore.addVersion(
                historyId = session.historyId,
                situation = session.situation,
                rawInput = session.rawInput,
                attachments = session.attachments,
                version = ResultVersion(
                    text = replacement,
                    question = current?.question ?: session.question,
                    provider = "SideChat",
                    createdAt = System.currentTimeMillis(),
                    assumption = current?.assumption ?: session.assumption,
                    enhancementLevel = session.enhancementLevel,
                ),
            )
            session.loadHistory(stored)
            persistDraft()
            renderStoredResult()
            Toast.makeText(
                this@OverlayService,
                "채팅의 내용을 새 결과 버전으로 반영했어요.",
                Toast.LENGTH_SHORT,
            ).show()
        }

        private fun focusChatInput(showKeyboard: Boolean) {
            val field = chatInput ?: return
            field.post {
                if (screenState != PanelScreenState.CHAT || closed) return@post
                field.requestFocus()
                field.setSelection(field.text?.length ?: 0)
                if (showKeyboard) {
                    (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
                        .showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
                }
            }
        }

        private fun focusEditor(editor: PasteFriendlyEditText?) {
            val field = editor ?: return
            field.requestFocus()
            field.setSelection(field.text?.length ?: 0)
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
                .showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
        }

        private fun startCompletion(
            questionFirst: Boolean,
            loadingButton: Button? = completeButton,
        ) {
            syncInputs()
            if (
                session.rawInput.isBlank() &&
                session.situation.isBlank() &&
                session.attachments.isEmpty()
            ) {
                showError("한 단어나 짧은 메모, 상황 또는 첨부 하나만 있어도 돼요.")
                return
            }
            submit(
                rawInput = session.rawInput,
                currentDraft = null,
                answer = null,
                questionFirst = questionFirst,
                controller = this,
                loadingButton = loadingButton,
            )
        }

        @android.annotation.SuppressLint("SetTextI18n")
        private fun renderEnhancementLevelControl() {
            session.enhancementLevel =
                EnhancementLevelPolicy.normalize(session.enhancementLevel)
            val block = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(3), dp(18), dp(3), dp(6))
            }
            val levelLabel = Ui.label(
                this@OverlayService,
                "",
                12f,
                0xFFE8E5EE.toInt(),
                true,
            )
            fun updateLabel(level: Int) {
                val definition = EnhancementLevelPolicy.definition(level)
                levelLabel.text = "강화 범위   ·   ${definition.label}"
                levelLabel.contentDescription = getString(
                    com.example.writingenhancer.R.string.enhancement_level_format, level, definition.label,
                ) + ", 목표 ${definition.lengthTarget}"
                levelLabel.setTextColor(Ui.ACCENT_TEXT)
            }
            updateLabel(session.enhancementLevel)
            block.addView(levelLabel)
            val seek = SeekBar(this@OverlayService).apply {
                Ui.styleSeekBar(this)
                max = EnhancementLevelPolicy.MAX - EnhancementLevelPolicy.MIN
                progress = session.enhancementLevel - EnhancementLevelPolicy.MIN
                splitTrack = false
                contentDescription = "강화 범위 5단계"
                setOnSeekBarChangeListener(
                    object : SeekBar.OnSeekBarChangeListener {
                        override fun onProgressChanged(
                            seekBar: SeekBar?,
                            progress: Int,
                            fromUser: Boolean,
                        ) {
                            val level = EnhancementLevelPolicy.normalize(
                                progress + EnhancementLevelPolicy.MIN,
                            )
                            updateLabel(level)
                            if (fromUser) {
                                session.enhancementLevel = level
                                persistDraft()
                            }
                        }

                        override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit

                        override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
                    },
                )
            }
            block.addView(
                seek,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(44),
                ),
            )
            val endpoints = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            endpoints.addView(
                Ui.label(this@OverlayService, "짧게 정리", 12f, Ui.PANEL_MUTED),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            endpoints.addView(
                Ui.label(this@OverlayService, "풍부하게", 12f, Ui.PANEL_MUTED).apply {
                    gravity = Gravity.END
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            block.addView(endpoints)
            content.addView(block)
        }

        fun renderGuessQuestion(question: String) {
            hideKeyboard()
            screenState = PanelScreenState.GUESS
            content.removeAllViews()
            resetViewReferences()
            renderHeader(showNew = true)
            content.addView(
                Ui.label(this@OverlayService, "먼저 이것만 알려주세요", 13f, Ui.PANEL_MUTED, true)
                    .apply { setPadding(dp(3), dp(3), 0, dp(9)) },
            )
            content.addView(
                Ui.label(
                    this@OverlayService,
                    question,
                    17f,
                    Color.WHITE,
                    true,
                ).apply {
                    setPadding(dp(15), dp(15), dp(15), dp(15))
                    setLineSpacing(dp(2).toFloat(), 1.12f)
                    background = Ui.rounded(Ui.PANEL_FIELD, 17, this@OverlayService)
                },
            )
            answerInput = backAwareEditText(
                hintText = "모르면 ‘알아서’를 눌러도 돼요",
                textValue = session.answer,
                minRows = layoutProfile.answerMinRows,
                maxRows = layoutProfile.answerMaxRows,
                textSizeSp = 15f,
                showEditTools = MobileUiPolicy.showInlineEditTools(MobileEditorRole.ANSWER),
            ).also { field ->
                field.imeOptions = EditorInfo.IME_ACTION_SEND
                field.setOnEditorActionListener { _, actionId, _ ->
                    if (actionId == EditorInfo.IME_ACTION_SEND) {
                        completeAfterGuess(
                            field.text.toString(),
                            answerPrimaryButton,
                        )
                        true
                    } else {
                        false
                    }
                }
                content.addView(
                    field,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(12) },
                )
                field.watchDraft { session.answer = it }
            }
            renderAnswerActions(
                applyLabel = "완성하기",
                onApply = { button ->
                    completeAfterGuess(answerInput?.text?.toString().orEmpty(), button)
                },
                onDecide = { button ->
                    completeAfterGuess(
                        "알아서 가장 적절한 방향으로 결정해 줘.",
                        button,
                    )
                },
            )
            renderError()
        }

        private fun completeAfterGuess(answer: String, loadingButton: Button?) {
            val cleaned = answer.trim()
            if (cleaned.isBlank()) {
                showError("말하기 어렵다면 ‘알아서’를 눌러 주세요.")
                return
            }
            session.invalidateRequestScope()
            session.answer = cleaned
            submit(
                rawInput = session.rawInput,
                currentDraft = null,
                answer = cleaned,
                questionFirst = false,
                controller = this,
                loadingButton = loadingButton,
            )
        }

        fun renderStoredResult(restoreLevelFromVersion: Boolean = false) {
            if (session.versions.isNotEmpty()) {
                val selected = session.versions[
                    session.versionIndex.coerceIn(0, session.versions.lastIndex)
                ]
                session.draft = selected.text
                session.question = selected.question
                session.assumption = selected.assumption
                session.provider = selected.provider
                if (restoreLevelFromVersion) {
                    session.enhancementLevel =
                        EnhancementLevelPolicy.normalize(selected.enhancementLevel)
                }
            }
            renderResultBody()
        }

        private fun renderResultBody() {
            hideKeyboard()
            screenState = PanelScreenState.RESULT
            content.removeAllViews()
            resetViewReferences()
            renderHeader(showNew = false)
            val versionCount = session.versions.size.coerceAtLeast(1)
            val versionNumber = (session.versionIndex + 1).coerceAtLeast(1)
            val versionTitleRow = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            versionTitleRow.addView(
                Ui.label(
                    this@OverlayService,
                    "완성된 글 $versionNumber/$versionCount",
                    12f,
                    Ui.PANEL_MUTED,
                    true,
                ),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            val previous = Ui.iconButton(this@OverlayService, UiIcon.BACK, "이전 결과").apply {
                contentDescription = "이전 결과"
                isEnabled = session.versionIndex > 0
                alpha = if (isEnabled) 1f else 0.38f
                setOnClickListener { moveVersion(previous = true) }
            }
            val next = Ui.iconButton(this@OverlayService, UiIcon.NEXT, "다음 결과").apply {
                contentDescription = "다음 결과"
                isEnabled = session.versionIndex < session.versions.lastIndex
                alpha = if (isEnabled) 1f else 0.38f
                setOnClickListener { moveVersion(previous = false) }
            }
            versionTitleRow.addView(
                previous,
                LinearLayout.LayoutParams(dp(44), dp(44)),
            )
            versionTitleRow.addView(
                next,
                LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(5) },
            )
            content.addView(
                versionTitleRow,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(44),
                ).apply { bottomMargin = dp(8) },
            )
            val resultText = Ui.label(
                this@OverlayService,
                session.draft,
                16f,
                Color.WHITE,
            ).apply {
                setTextIsSelectable(true)
                setLineSpacing(dp(3).toFloat(), 1.22f)
                setPadding(dp(18), dp(18), dp(18), dp(18))
                minHeight = dp(layoutProfile.resultMinHeightDp)
                background = Ui.rounded(Ui.PANEL_RAISED, 18, this@OverlayService, Ui.PANEL_STROKE)
            }
            content.addView(resultText)
            val originalText = Ui.label(
                this@OverlayService,
                session.rawInput,
                13f,
                0xFFE5E2EA.toInt(),
            ).apply {
                visibility = View.GONE
                setTextIsSelectable(true)
                setPadding(dp(13), dp(11), dp(13), dp(11))
                background = Ui.rounded(0xFF303039.toInt(), 14, this@OverlayService)
            }
            val resultUtilityRow = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL or Gravity.END
            }
            val again = compactAction("↻", 0xFF34343D.toInt()).apply {
                contentDescription = "다시 강화"
                setOnClickListener {
                    submit(
                        rawInput = session.rawInput,
                        currentDraft = null,
                        answer = null,
                        questionFirst = false,
                        regenerateFromOriginal = true,
                        controller = this@PanelController,
                        loadingButton = this,
                    )
                }
            }
            reenhanceButton = again
            generationButtons += again
            val originalToggle = compactAction("원문 보기", 0xFF34343D.toInt())
            originalToggle.setOnClickListener {
                val show = originalText.visibility != View.VISIBLE
                originalText.visibility = if (show) View.VISIBLE else View.GONE
                originalToggle.text = if (show) "원문 접기" else "원문 보기"
            }
            resultUtilityRow.addView(
                compactAction("＋ 새 글", Color.TRANSPARENT).apply {
                    contentDescription = "새 글 시작"
                    setTextColor(Ui.PANEL_MUTED)
                    setOnClickListener {
                        session.clear()
                        workspaceStore.clearDraft()
                        renderInput()
                    }
                },
                LinearLayout.LayoutParams(dp(82), dp(44)),
            )
            resultUtilityRow.addView(
                Space(this@OverlayService),
                LinearLayout.LayoutParams(0, 1, 1f),
            )
            resultUtilityRow.addView(
                again,
                LinearLayout.LayoutParams(dp(44), dp(44)),
            )
            resultUtilityRow.addView(
                originalToggle,
                LinearLayout.LayoutParams(dp(92), dp(44)).apply { marginStart = dp(6) },
            )
            content.addView(
                resultUtilityRow,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(44),
                ).apply { topMargin = dp(7) },
            )
            content.addView(
                originalText,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(5) },
            )
            renderEnhancementLevelControl()

            val suggestionText = Ui.label(
                this@OverlayService,
                session.question.ifBlank {
                    "가장 자연스러운 상황으로 이해했어요. 다르게 바꿀 점이 있나요?"
                },
                14f,
                0xFFE6E3EB.toInt(),
                true,
            ).apply {
                setPadding(dp(12), dp(11), dp(12), dp(11))
                setLineSpacing(0f, 1.18f)
                background = Ui.rounded(Ui.ACCENT_SURFACE, 14, this@OverlayService)
            }
            val yes = compactAction("예", 0xFF3A3942.toInt()).apply {
                contentDescription = "AI 제안 반영"
                setOnClickListener {
                    refineWith(
                        "예. AI가 제안한 방향을 현재 결과에 반영해 줘.",
                        this,
                    )
                }
            }
            suggestionAcceptButton = yes
            generationButtons += yes
            val suggestionBlock = LinearLayout(this@OverlayService).apply {
                orientation = if (shouldStackResultControls()) {
                    LinearLayout.VERTICAL
                } else {
                    LinearLayout.HORIZONTAL
                }
                gravity = Gravity.CENTER_VERTICAL
                if (orientation == LinearLayout.VERTICAL) {
                    addView(
                        suggestionText,
                        LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                        ),
                    )
                    addView(
                        yes,
                        LinearLayout.LayoutParams(dp(78), dp(46)).apply {
                            gravity = Gravity.END
                            topMargin = dp(6)
                        },
                    )
                } else {
                    addView(
                        suggestionText,
                        LinearLayout.LayoutParams(
                            0,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            1f,
                        ),
                    )
                    addView(
                        yes,
                        LinearLayout.LayoutParams(dp(68), dp(46)).apply {
                            marginStart = dp(7)
                        },
                    )
                }
            }
            suggestionView = suggestionBlock
            content.addView(
                suggestionBlock,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(12) },
            )

            val apply = compactAction("반영하기", Ui.ACCENT).apply {
                setOnClickListener {
                    refineWith(answerInput?.text?.toString().orEmpty(), this)
                }
            }
            answerPrimaryButton = apply
            generationButtons += apply
            answerInput = backAwareEditText(
                hintText = "아니면 다른 요구 사항 입력",
                textValue = session.answer,
                minRows = layoutProfile.answerMinRows,
                maxRows = layoutProfile.answerMaxRows,
                textSizeSp = 14f,
                showEditTools = MobileUiPolicy.showInlineEditTools(MobileEditorRole.ANSWER),
            ).also { field ->
                field.imeOptions = EditorInfo.IME_ACTION_SEND
                field.setOnEditorActionListener { _, actionId, _ ->
                    if (actionId == EditorInfo.IME_ACTION_SEND) {
                        refineWith(field.text.toString(), apply)
                        true
                    } else {
                        false
                    }
                }
                field.watchDraft {
                    session.answer = it
                    updateSuggestionPriority()
                }
            }
            val requirementBlock = LinearLayout(this@OverlayService).apply {
                orientation = if (shouldStackResultControls()) {
                    LinearLayout.VERTICAL
                } else {
                    LinearLayout.HORIZONTAL
                }
                gravity = Gravity.CENTER_VERTICAL
                if (orientation == LinearLayout.VERTICAL) {
                    addView(
                        answerInput,
                        LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                        ),
                    )
                    addView(
                        apply,
                        LinearLayout.LayoutParams(dp(104), dp(46)).apply {
                            gravity = Gravity.END
                            topMargin = dp(6)
                        },
                    )
                } else {
                    addView(
                        answerInput,
                        LinearLayout.LayoutParams(
                            0,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            1f,
                        ),
                    )
                    addView(
                        apply,
                        LinearLayout.LayoutParams(dp(92), dp(46)).apply {
                            marginStart = dp(7)
                        },
                    )
                }
            }
            content.addView(
                requirementBlock,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply {
                    topMargin = dp(8)
                    bottomMargin = dp(8)
                },
            )
            updateSuggestionPriority()

            stickyActions.addView(
                Ui.primaryButton(this@OverlayService, "강화한 글 복사").apply {
                    setAutoSizeTextTypeUniformWithConfiguration(
                        12,
                        16,
                        1,
                        TypedValue.COMPLEX_UNIT_SP,
                    )
                    setOnClickListener { copyAndClose(session.draft) }
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(layoutProfile.actionHeightDp.coerceAtLeast(46)),
                ),
            )
            renderError()
        }

        private fun renderAnswerActions(
            applyLabel: String,
            onApply: (Button) -> Unit,
            onDecide: (Button) -> Unit,
        ) {
            val row = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val apply = compactAction(applyLabel, Ui.ACCENT).apply {
                setOnClickListener { onApply(this) }
            }
            val decide = compactAction("알아서", 0xFF3A3942.toInt()).apply {
                setOnClickListener { onDecide(this) }
            }
            answerPrimaryButton = apply
            generationButtons += apply
            generationButtons += decide
            row.addView(
                apply,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f),
            )
            row.addView(
                decide,
                LinearLayout.LayoutParams(
                    0,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0.82f,
                ).apply {
                    marginStart = dp(7)
                },
            )
            stickyActions.addView(
                row,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(layoutProfile.actionHeightDp.coerceAtLeast(42)),
                ).apply { topMargin = dp(6) },
            )
        }

        private fun moveVersion(previous: Boolean) {
            if (session.versions.isEmpty()) return
            val nextIndex = if (previous) {
                WorkspacePolicy.previousVersionIndex(session.versionIndex, session.versions.size)
            } else {
                WorkspacePolicy.nextVersionIndex(session.versionIndex, session.versions.size)
            }
            if (nextIndex == session.versionIndex) return
            session.invalidateRequestScope()
            session.versionIndex = nextIndex
            session.historyId?.let { workspaceStore.selectVersion(it, session.versionIndex) }
            renderStoredResult(restoreLevelFromVersion = true)
            persistDraft()
        }

        private fun refineWith(answer: String, loadingButton: Button?) {
            val cleaned = answer.trim()
            if (cleaned.isBlank()) {
                showError("요구 사항을 입력하거나 ‘예’를 눌러 주세요.")
                return
            }
            session.invalidateRequestScope()
            session.answer = cleaned
            submit(
                rawInput = session.rawInput,
                currentDraft = session.draft,
                answer = cleaned,
                questionFirst = false,
                controller = this,
                loadingButton = loadingButton,
            )
        }

        private fun shouldStackResultControls(): Boolean =
            pxToDp(panelParams?.width ?: dp(380)) < 330

        private fun updateSuggestionPriority() {
            val hasDirectRequirement = answerInput?.text?.toString()?.isNotBlank() == true
            suggestionView?.alpha = if (hasDirectRequirement) 0.52f else 1f
            suggestionAcceptButton?.isEnabled =
                !hasDirectRequirement && !generationInProgress
        }

        private fun handleBack() {
            if (closed || settingsOpen) return
            syncInputs()
            val editorActive = focusedEditor() != null || imeVisible
            if (!editorActive && screenState == PanelScreenState.CHAT) {
                when {
                    chatClearConfirmation -> {
                        chatClearConfirmation = false
                        renderSideChat()
                        return
                    }
                    chatEditingMessageId.isNotBlank() -> {
                        chatEditingMessageId = ""
                        renderSideChat()
                        return
                    }
                }
            }
            when (
                MobileUiPolicy.backAction(
                    editorActive = editorActive,
                    screen = screenState,
                )
            ) {
                PanelNavigationAction.HIDE_IME -> hideKeyboard(preserveEditMenu = true)
                PanelNavigationAction.RETURN_FROM_HISTORY -> returnFromHistory()
                PanelNavigationAction.RETURN_FROM_CHAT -> returnFromSideChat()
                PanelNavigationAction.CANCEL_GUESS -> cancelGuess()
                PanelNavigationAction.COLLAPSE_PANEL -> close()
            }
        }

        private fun handleOutside(event: MotionEvent) {
            if (closed || settingsOpen) return
            if (editMenuController.isVisible) {
                editMenuController.hide()
                return
            }
            val editor = focusedEditor()
            root.getWindowVisibleDisplayFrame(visibleFrame)
            val touchInImeArea = editor != null &&
                MobileUiPolicy.isTouchInImeArea(event.rawY, visibleFrame.bottom)
            val contextMenuLikely = editor?.contextMenuLikely == true
            when (
                MobileUiPolicy.outsideAction(
                    editorActive = editor != null,
                    contextMenuLikely = contextMenuLikely,
                    touchInImeArea = touchInImeArea,
                )
            ) {
                EditorOutsideAction.KEEP_EDITING -> {
                    if (contextMenuLikely && !touchInImeArea) {
                        editor?.consumeContextMenuProtection()
                    }
                }
                EditorOutsideAction.HIDE_EDITOR -> hideKeyboard()
                EditorOutsideAction.COLLAPSE_PANEL -> close()
            }
        }

        private fun cancelGuess() {
            session.invalidateRequestScope()
            session.answer = ""
            session.question = ""
            session.assumption = ""
            session.guessQuestion = false
            persistDraft()
            renderInput()
        }

        private fun returnFromHistory() {
            when (historyReturnScreen) {
                PanelScreenState.GUESS -> {
                    if (session.guessQuestion && session.question.isNotBlank()) {
                        renderGuessQuestion(session.question)
                    } else {
                        renderInput()
                    }
                }
                PanelScreenState.RESULT -> {
                    if (session.draft.isNotBlank()) renderStoredResult() else renderInput()
                }
                PanelScreenState.CHAT -> renderSideChat()
                else -> renderInput()
            }
        }

        private fun renderHistory() {
            hideKeyboard()
            if (screenState != PanelScreenState.HISTORY) {
                session.invalidateRequestScope()
                historyReturnScreen = screenState
            }
            screenState = PanelScreenState.HISTORY
            content.removeAllViews()
            resetViewReferences()
            val header = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(3), 0, 0, dp(12))
            }
            header.addView(
                Ui.label(this@OverlayService, "이전 작업", 18f, Color.WHITE, true),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            header.addView(Ui.quietButton(this@OverlayService, "돌아가기") {
                returnFromHistory()
            })
            headerHost.addView(header)
            val histories = workspaceStore.listHistory()
            if (histories.isEmpty()) {
                content.addView(
                    Ui.label(
                        this@OverlayService,
                        "아직 저장된 작업이 없어요.",
                        14f,
                        Ui.PANEL_MUTED,
                    ).apply { setPadding(dp(4), dp(20), 0, 0) },
                )
                return
            }
            histories.forEach { entry -> content.addView(historyCard(entry)) }
        }

        private fun historyCard(entry: HistoryEntry): View {
            val card = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(13), dp(11), dp(9), dp(9))
                background = Ui.rounded(Ui.PANEL_FIELD, 15, this@OverlayService)
            }
            val selected = entry.versions[
                entry.selectedVersion.coerceIn(0, entry.versions.lastIndex)
            ]
            val date = SimpleDateFormat("MM.dd HH:mm", Locale.KOREA)
                .format(Date(entry.updatedAt))
            card.addView(
                Ui.label(
                    this@OverlayService,
                    entry.situation
                        .ifBlank { "저장된 글" }
                        .replace('\n', ' ')
                        .take(42),
                    13f,
                    Color.WHITE,
                    true,
                ),
            )
            card.addView(
                Ui.label(
                    this@OverlayService,
                    "원문 · ${entry.rawInput.replace('\n', ' ').take(72)}",
                    12f,
                    0xFFE7E4EC.toInt(),
                ).apply { setPadding(0, dp(6), 0, dp(4)) },
            )
            card.addView(
                Ui.label(
                    this@OverlayService,
                    "결과 · ${selected.text.replace('\n', ' ').take(72)}",
                    12f,
                    Ui.PANEL_MUTED,
                ).apply { setPadding(0, dp(5), 0, dp(6)) },
            )
            val row = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            row.addView(
                Ui.label(this@OverlayService, "$date · ${entry.versions.size}개 결과", 10f, Ui.PANEL_MUTED),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            val open = compactAction("열기", 0xFF44424D.toInt())
            val delete = compactAction("삭제", 0xFF44424D.toInt()).apply {
                setTextColor(0xFFFFA2AA.toInt())
            }
            row.addView(open, LinearLayout.LayoutParams(dp(62), dp(36)))
            row.addView(
                delete,
                LinearLayout.LayoutParams(dp(62), dp(36)).apply { marginStart = dp(5) },
            )
            card.addView(row)
            open.setOnClickListener {
                session.loadHistory(entry)
                persistDraft()
                renderStoredResult()
            }
            delete.setOnClickListener {
                workspaceStore.deleteHistory(entry.id)
                if (session.historyId == entry.id) {
                    session.invalidateRequestScope()
                    session.historyId = null
                }
                renderHistory()
            }
            return card.apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(8) }
            }
        }

        @Suppress("DEPRECATION")
        private fun configureImeAwareScroll() {
            scroll.clipToPadding = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                root.setOnApplyWindowInsetsListener { _, insets ->
                    // A floating window's visible frame is not the screen frame:
                    // its bottom gap must never be mistaken for a keyboard.
                    insetImeBottom = if (insets.isVisible(WindowInsets.Type.ime())) {
                        insets.getInsets(WindowInsets.Type.ime()).bottom
                    } else {
                        0
                    }
                    insetSystemBarBottom =
                        insets.getInsets(WindowInsets.Type.navigationBars()).bottom
                    applyImePadding()
                    insets
                }
            }
            root.viewTreeObserver.addOnGlobalLayoutListener {
                if (closed || !root.isAttachedToWindow) return@addOnGlobalLayoutListener
                root.getWindowVisibleDisplayFrame(visibleFrame)
                val geometryBottom = (
                    currentScreenSize().second - visibleFrame.bottom
                ).coerceAtLeast(0)
                geometryImeBottom = geometryBottom
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                    insetImeBottom = geometryBottom
                    insetSystemBarBottom = root.rootWindowInsets
                        ?.stableInsetBottom
                        ?.coerceAtLeast(0)
                        ?: 0
                }
                applyImePadding()
            }
        }

        private fun applyImePadding() {
            val maximum = if (root.height > 0) {
                (root.height / 2).coerceIn(dp(120), dp(300))
            } else {
                dp(240)
            }
            val extraBottom = MobileUiPolicy.imeBottomPadding(
                imeBottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    insetImeBottom
                } else {
                    geometryImeBottom
                },
                systemBarBottom = insetSystemBarBottom,
                maximum = maximum,
                alreadyResizedBy = (
                    requestedPanelHeight - root.height
                ).coerceAtLeast(0),
            )
            imeVisible = extraBottom > dp(48)
            if (scroll.paddingBottom != 0) {
                scroll.setPadding(
                    scroll.paddingLeft,
                    scroll.paddingTop,
                    scroll.paddingRight,
                    0,
                )
            }
            if (::stickyActions.isInitialized) {
                // Reserve layout space instead of drawing the actions over editors.
                val actionsLayout = stickyActions.layoutParams as LinearLayout.LayoutParams
                if (actionsLayout.bottomMargin != extraBottom) {
                    actionsLayout.bottomMargin = extraBottom
                    stickyActions.layoutParams = actionsLayout
                }
            }
            revealFocusedEditor()
        }

        private fun revealFocusedEditor() {
            val editor = focusedEditor() ?: return
            scroll.post {
                if (!editor.hasFocus() || closed) return@post
                editor.requestRectangleOnScreen(
                    Rect(
                        0,
                        0,
                        editor.width,
                        editor.height + dp(82),
                    ),
                    false,
                )
            }
        }

        private fun launchBridge(
            action: String,
            target: String,
            affectsWriting: Boolean = true,
        ) {
            syncInputs()
            if (affectsWriting) session.invalidateRequestScope()
            persistDraft()
            hideKeyboard()
            bridgeInProgress = true
            root.visibility = View.INVISIBLE
            val bridge = Intent(this@OverlayService, BridgeActivity::class.java)
                .setAction(action)
                .putExtra(BridgeActivity.EXTRA_TARGET, target)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            runCatching { startActivity(bridge) }
                .onFailure {
                    bridgeInProgress = false
                    restoreAfterBridge()
                    if (isSideChatVisualTarget(target)) {
                        chatScreenNotice = "화면 공유 기능을 열지 못했어요."
                        renderSideChat()
                    } else {
                        showError("시스템 기능을 열지 못했어요.")
                    }
                }
        }

        fun insertSpeech(target: String, text: String) {
            if (text.isBlank()) return
            session.invalidateRequestScope()
            when (target) {
                BridgeActivity.TARGET_SITUATION -> {
                    session.situation = joinText(session.situation, text)
                    situationInput?.setText(session.situation)
                }
                BridgeActivity.TARGET_ANSWER -> {
                    session.answer = joinText(session.answer, text)
                    answerInput?.setText(session.answer)
                    answerInput?.setSelection(session.answer.length)
                }
                else -> {
                    session.rawInput = joinText(session.rawInput, text)
                    input?.setText(session.rawInput)
                    input?.setSelection(session.rawInput.length)
                }
            }
            persistDraft()
        }

        fun setLoading(loading: Boolean, sourceButton: Button? = null) {
            generationInProgress = loading
            if (loading) {
                val active = sourceButton ?: completeButton ?: answerPrimaryButton
                activeLoadingButton = active
                activeLoadingLabel = active?.text?.toString().orEmpty()
                generationButtons.forEach { button ->
                    button.isEnabled = false
                    button.alpha = if (button === active) 1f else 0.34f
                }
                active?.apply {
                    text = if (contentDescription == "다시 강화") {
                        "…"
                    } else {
                        MobileUiPolicy.loadingButtonText()
                    }
                    isActivated = true
                }
            } else {
                activeLoadingButton?.apply {
                    text = activeLoadingLabel
                    isActivated = false
                }
                generationButtons.forEach { button ->
                    button.isEnabled = true
                    button.alpha = 1f
                }
                updateSuggestionPriority()
                activeLoadingButton = null
                activeLoadingLabel = ""
            }
            answerInput?.isEnabled = !loading
            if (loading) error?.visibility = View.GONE
            if (!loading && responsiveRerenderPending) {
                responsiveRerenderPending = false
                syncInputs()
                renderCurrentScreen()
            }
        }

        fun showError(message: String) {
            val target = error
            if (target == null || target.parent == null) {
                Toast.makeText(this@OverlayService, message, Toast.LENGTH_SHORT).show()
            } else {
                target.text = message
                target.visibility = View.VISIBLE
            }
        }

        private fun renderError() {
            error = Ui.label(this@OverlayService, "", 12f, 0xFFFF9B9B.toInt()).apply {
                visibility = View.GONE
                setPadding(dp(5), dp(8), dp(5), 0)
            }
            stickyActions.addView(error, 0)
        }

        fun showMemoryApproval(
            candidates: List<MemoryCandidate>,
            groundingInput: String,
        ) {
            if (candidates.isEmpty() || !preferences.memoryAdditionsEnabled) return
            memoryApprovalBanner?.let { (it.parent as? ViewGroup)?.removeView(it) }
            val preview = candidates.first().value.take(64)
            val banner = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(13), dp(11), dp(10), dp(10))
                background = Ui.rounded(0xFF35323F.toInt(), 14, this@OverlayService)
                elevation = dp(10).toFloat()
            }
            banner.addView(
                Ui.label(
                    this@OverlayService,
                    "이 정보를 기억에 추가할까요?\n$preview" +
                        if (candidates.size > 1) "\n외 ${candidates.size - 1}개" else "",
                    12f,
                    Color.WHITE,
                    true,
                ),
            )
            val actions = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END
                setPadding(0, dp(8), 0, 0)
            }
            val skip = compactAction("추가 안 함", 0xFF44424D.toInt())
            val approve = compactAction("기억에 추가", Ui.ACCENT)
            actions.addView(skip, LinearLayout.LayoutParams(dp(92), dp(38)))
            actions.addView(
                approve,
                LinearLayout.LayoutParams(dp(96), dp(38)).apply { marginStart = dp(7) },
            )
            banner.addView(actions)
            fun dismiss() {
                (banner.parent as? ViewGroup)?.removeView(banner)
                if (memoryApprovalBanner === banner) memoryApprovalBanner = null
            }
            skip.setOnClickListener {
                dismiss()
                Toast.makeText(
                    this@OverlayService,
                    "기억에 추가하지 않았어요.",
                    Toast.LENGTH_SHORT,
                ).show()
            }
            approve.setOnClickListener {
                if (!preferences.memoryAdditionsEnabled) {
                    dismiss()
                    return@setOnClickListener
                }
                val changes = memoryStore.addCandidates(candidates, groundingInput)
                dismiss()
                if (changes.isNotEmpty()) {
                    showMemoryUndo(changes)
                } else {
                    Toast.makeText(
                        this@OverlayService,
                        "추가할 안전한 기억이 없어요.",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
            root.addView(
                banner,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM,
                ).apply {
                    leftMargin = dp(9)
                    rightMargin = dp(9)
                    bottomMargin = dp(9)
                },
            )
            memoryApprovalBanner = banner
        }

        fun showMemoryUndo(changes: List<MemoryChange>) {
            undoBanner?.let { (it.parent as? ViewGroup)?.removeView(it) }
            val summary = changes.firstOrNull()?.after?.value.orEmpty().take(42)
            val banner = LinearLayout(this@OverlayService).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(13), dp(9), dp(7), dp(9))
                background = Ui.rounded(0xFF35323F.toInt(), 14, this@OverlayService)
                elevation = dp(8).toFloat()
            }
            banner.addView(
                Ui.label(
                    this@OverlayService,
                    "다음부터 참고할게요 · $summary",
                    11f,
                    Color.WHITE,
                ),
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            banner.addView(Ui.quietButton(this@OverlayService, "취소") {
                memoryStore.undo(changes)
                (banner.parent as? ViewGroup)?.removeView(banner)
                undoBanner = null
            })
            root.addView(
                banner,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM,
                ).apply {
                    leftMargin = dp(9)
                    rightMargin = dp(9)
                    bottomMargin = dp(8)
                },
            )
            undoBanner = banner
            banner.postDelayed({
                if (undoBanner === banner) {
                    (banner.parent as? ViewGroup)?.removeView(banner)
                    undoBanner = null
                }
            }, 6000)
        }

        private fun backAwareEditText(
            hintText: String,
            textValue: String,
            minRows: Int,
            maxRows: Int,
            textSizeSp: Float,
            showEditTools: Boolean = true,
            nativeEditMenu: Boolean = false,
        ) = PasteFriendlyEditText(
            this@OverlayService,
            minRows,
            maxRows,
            onBack = { handleBack() },
            onEditMenuRequested = { editor ->
                if (showEditTools) editMenuController.show(editor)
            },
            useNativeActionMode = nativeEditMenu,
        ).apply {
            hint = hintText
            setHintTextColor(Ui.PANEL_MUTED)
            setTextColor(Ui.PANEL_TEXT)
            textSize = textSizeSp
            gravity = Gravity.TOP or Gravity.START
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = Ui.inputBackground(this@OverlayService)
            setLineSpacing(dp(2).toFloat(), 1.15f)
            setInitialText(textValue)
            setOnFocusChangeListener { _, hasFocus ->
                if (!hasFocus && editMenuController.editor === this) {
                    editMenuController.hide()
                }
            }
        }

        private fun EditText.watchDraft(onValue: (String) -> Unit) {
            addTextChangedListener(
                object : TextWatcher {
                    override fun beforeTextChanged(
                        sequence: CharSequence?,
                        start: Int,
                        count: Int,
                        after: Int,
                    ) = Unit

                    override fun onTextChanged(
                        sequence: CharSequence?,
                        start: Int,
                        before: Int,
                        count: Int,
                    ) {
                        session.invalidateRequestScope()
                        onValue(sequence?.toString().orEmpty())
                        mainHandler.removeCallbacks(persistRunnable)
                        mainHandler.postDelayed(persistRunnable, DRAFT_DEBOUNCE_MS)
                    }

                    override fun afterTextChanged(editable: Editable?) = Unit
                },
            )
        }

        private fun syncInputs() {
            situationInput?.let { session.situation = it.text.toString() }
            input?.let { session.rawInput = it.text.toString() }
            answerInput?.let { session.answer = it.text.toString() }
            chatInput?.let { chatDraft = it.text.toString() }
        }

        private fun resetViewReferences() {
            editMenuController.hide()
            if (::headerHost.isInitialized) headerHost.removeAllViews()
            if (::stickyActions.isInitialized) stickyActions.removeAllViews()
            generationButtons.clear()
            activeLoadingButton = null
            activeLoadingLabel = ""
            memoryApprovalBanner?.let { (it.parent as? ViewGroup)?.removeView(it) }
            memoryApprovalBanner = null
            input = null
            situationInput = null
            answerInput = null
            chatInput = null
            completeButton = null
            answerPrimaryButton = null
            reenhanceButton = null
            suggestionView = null
            suggestionAcceptButton = null
            error = null
        }

        private fun compactAction(text: String, color: Int) = Button(this@OverlayService).apply {
            this.text = text
            isAllCaps = false
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            minWidth = 0
            minimumWidth = 0
            minHeight = 0
            minimumHeight = 0
            setPadding(dp(5), 0, dp(5), 0)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setAutoSizeTextTypeUniformWithConfiguration(
                11,
                13,
                1,
                TypedValue.COMPLEX_UNIT_SP,
            )
            background = Ui.interactive(this@OverlayService, color, 12)
            stateListAnimator = null
        }

        private fun copySideChatAnswer(view: TextView, fullText: String) {
            if (fullText.isBlank()) return
            val start = android.text.Selection.getSelectionStart(view.text)
            val end = android.text.Selection.getSelectionEnd(view.text)
            val selectedText = if (
                start >= 0 &&
                end >= 0 &&
                start != end
            ) {
                fullText.substring(minOf(start, end), maxOf(start, end))
            } else {
                fullText
            }
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("AI 답변", selectedText))
            Toast.makeText(
                this@OverlayService,
                if (selectedText.length == fullText.length) {
                    "AI 답변을 복사했어요."
                } else {
                    "선택한 부분을 복사했어요."
                },
                Toast.LENGTH_SHORT,
            ).show()
        }

        private fun copyAndClose(text: String) {
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("강화한 글", text))
            Toast.makeText(
                this@OverlayService,
                "강화한 글을 복사했어요.",
                Toast.LENGTH_SHORT,
            ).show()
            close()
        }

        private fun focusedEditor(): PasteFriendlyEditText? =
            if (::root.isInitialized) root.findFocus() as? PasteFriendlyEditText else null

        private fun hideImeOnly() {
            if (!::root.isInitialized) return
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(root.windowToken, 0)
        }

        private fun hideKeyboard(preserveEditMenu: Boolean = false) {
            if (!::root.isInitialized) return
            val expandedEditor = editMenuController.editor
                ?.takeIf {
                    preserveEditMenu &&
                        MobileUiPolicy.inlineMenuExpandedAfterBack(
                            editMenuController.isVisible,
                        )
                }
            if (!preserveEditMenu) editMenuController.hide()
            val focused = focusedEditor()
            val token = focused?.windowToken ?: root.windowToken
            focused?.prepareForFocusLoss()
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(token, 0)
            focused?.clearFocus()
            root.requestFocus()
            expandedEditor?.post {
                if (!closed && expandedEditor.parent is LinearLayout) {
                    editMenuController.show(expandedEditor)
                }
            }
        }
    }

    private fun currentScreenSize(): Pair<Int, Int> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = windowManager.currentWindowMetrics.bounds
            bounds.width() to bounds.height()
        } else {
            @Suppress("DEPRECATION")
            val size = Point().also { windowManager.defaultDisplay.getRealSize(it) }
            size.x to size.y
        }

    private fun joinText(existing: String, added: String): String =
        if (existing.isBlank()) added.trim() else "${existing.trimEnd()} ${added.trim()}"

    private data class SessionRequestContext(
        val requestId: Long,
        val generation: Long,
        val historyId: String?,
        val rawInput: String,
        val situation: String,
        val attachments: List<AttachmentRef>,
        val enhancementLevel: Int,
    )

    private data class Session(
        var situation: String = "",
        var rawInput: String = "",
        var answer: String = "",
        var draft: String = "",
        var question: String = "",
        var assumption: String = "",
        var provider: String = "",
        var historyId: String? = null,
        var versions: MutableList<ResultVersion> = mutableListOf(),
        var versionIndex: Int = 0,
        var guessQuestion: Boolean = false,
        var enhancementLevel: Int = EnhancementLevelPolicy.DEFAULT,
        var generation: Long = 0,
        val attachments: MutableList<AttachmentRef> = mutableListOf(),
    ) {
        fun invalidateRequestScope() {
            generation += 1
        }

        fun clear() {
            invalidateRequestScope()
            situation = ""
            rawInput = ""
            answer = ""
            draft = ""
            question = ""
            assumption = ""
            provider = ""
            historyId = null
            versions.clear()
            versionIndex = 0
            guessQuestion = false
            enhancementLevel = EnhancementLevelPolicy.DEFAULT
            attachments.clear()
        }

        fun loadHistory(entry: HistoryEntry) {
            invalidateRequestScope()
            historyId = entry.id
            situation = entry.situation
            rawInput = entry.rawInput
            attachments.clear()
            attachments += entry.attachments.filter { File(it.path).isFile }
            versions = entry.versions.toMutableList()
            versionIndex = entry.selectedVersion.coerceIn(0, versions.lastIndex)
            val selected = versions[versionIndex]
            draft = selected.text
            question = selected.question
            assumption = selected.assumption
            provider = selected.provider
            enhancementLevel = EnhancementLevelPolicy.normalize(selected.enhancementLevel)
            answer = ""
            guessQuestion = false
        }
    }

    companion object {
        const val ACTION_START = "com.example.writingenhancer.action.START"
        const val ACTION_STOP = "com.example.writingenhancer.action.STOP"
        const val ACTION_OPEN = "com.example.writingenhancer.action.OPEN"
        const val ACTION_RESIZE_BUBBLE = "com.example.writingenhancer.action.RESIZE_BUBBLE"
        const val ACTION_ATTACHMENT_RESULT =
            "com.example.writingenhancer.action.ATTACHMENT_RESULT"
        const val ACTION_CAPTURE_CANCELLED =
            "com.example.writingenhancer.action.CAPTURE_CANCELLED"
        const val ACTION_BRIDGE_ERROR = "com.example.writingenhancer.action.BRIDGE_ERROR"
        const val ACTION_SPEECH_RESULT = "com.example.writingenhancer.action.SPEECH_RESULT"

        const val EXTRA_PATH = "path"
        const val EXTRA_NAME = "name"
        const val EXTRA_MIME = "mime"
        const val EXTRA_SIZE = "size"
        const val EXTRA_SOURCE = "source"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_TARGET = "target"
        const val EXTRA_TEXT = "text"

        private const val CHANNEL_ID = "writing_enhancer_bubble"
        private const val NOTIFICATION_ID = 7401
        private const val POSITION_PREFS = "bubble_position"
        private const val PANEL_GEOMETRY_PREFS = "panel_geometry"
        private const val KEY_PANEL_X = "x"
        private const val KEY_PANEL_Y = "y"
        private const val KEY_PANEL_WIDTH = "width"
        private const val KEY_PANEL_HEIGHT = "height"
        private const val STATE_PREFS = "bubble_state"
        private const val STATE_RUNNING = "running"
        private const val STATE_LAST_PANEL_SURFACE = "last_panel_surface"
        private const val LONG_PRESS_MS = 450L
        private const val DRAFT_DEBOUNCE_MS = 350L
        private const val SIDE_CHAT_CAPTURE_STALE_MS = 10L * 60L * 1000L

        fun isMarkedRunning(context: Context): Boolean =
            context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
                .getBoolean(STATE_RUNNING, false)

        /**
         * Delivers a bridge/capture result only while the user still has the bubble on.
         * The running flag is committed synchronously when stopping, so a late one-shot
         * capture cannot create a new OverlayService instance.
         */
        fun startIfMarkedRunning(context: Context, intent: Intent): Boolean {
            if (!isMarkedRunning(context)) return false
            return runCatching {
                context.startService(intent)
                true
            }.getOrDefault(false)
        }

        @android.annotation.SuppressLint("ApplySharedPref")
        private fun setMarkedRunning(context: Context, running: Boolean) {
            // A stop decision must be visible before a late MediaProjection result can
            // call startService; asynchronous apply() would reopen that race window.
            context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(STATE_RUNNING, running)
                .commit()
        }
    }
}

@android.annotation.SuppressLint("ViewConstructor")
private class BackAwareFrameLayout(
    context: Context,
    private val onBack: () -> Unit,
    private val onOutside: (MotionEvent) -> Unit,
) : FrameLayout(context) {
    var outsideEnabled: () -> Boolean = { true }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_OUTSIDE && outsideEnabled()) {
            onOutside(event)
            return true
        }
        return super.dispatchTouchEvent(event)
    }

    override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            onBack()
            return true
        }
        return super.dispatchKeyEventPreIme(event)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            onBack()
            return true
        }
        return super.dispatchKeyEvent(event)
    }
}
