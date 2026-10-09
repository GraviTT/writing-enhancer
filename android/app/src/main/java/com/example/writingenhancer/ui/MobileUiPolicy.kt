package com.example.writingenhancer.ui

enum class PanelScreenState {
    INPUT,
    GUESS,
    RESULT,
    HISTORY,
    CHAT,
}

enum class PanelSurface {
    WRITING,
    SIDE_CHAT;

    companion object {
        fun fromStored(value: String?): PanelSurface =
            entries.firstOrNull { it.name == value } ?: WRITING
    }
}

enum class PanelNavigationAction {
    HIDE_IME,
    RETURN_FROM_HISTORY,
    RETURN_FROM_CHAT,
    CANCEL_GUESS,
    COLLAPSE_PANEL,
}

enum class EditorOutsideAction {
    KEEP_EDITING,
    HIDE_EDITOR,
    COLLAPSE_PANEL,
}

enum class MobileEditorRole {
    RAW,
    SITUATION,
    ANSWER,
}

enum class SideChatMessageAction {
    NONE,
    EDIT_LEFT,
    COPY_RIGHT,
}

data class MobileLayoutProfile(
    val horizontalPaddingDp: Int,
    val verticalPaddingDp: Int,
    val actionHeightDp: Int,
    val rawMinRows: Int,
    val rawMaxRows: Int,
    val answerMinRows: Int,
    val answerMaxRows: Int,
    val resultMinHeightDp: Int,
)

object MobileUiPolicy {
    const val RAW_MIN_ROWS = 4
    const val RAW_MAX_ROWS = 9
    const val ANSWER_MIN_ROWS = 2
    const val ANSWER_MAX_ROWS = 6

    fun layoutProfile(widthDp: Int, heightDp: Int): MobileLayoutProfile {
        require(widthDp > 0 && heightDp > 0)
        val compact = widthDp < 340 || heightDp < 560
        val spacious = widthDp >= 420 && heightDp >= 720
        return when {
            compact -> MobileLayoutProfile(
                horizontalPaddingDp = 9,
                verticalPaddingDp = 8,
                actionHeightDp = 42,
                rawMinRows = 3,
                rawMaxRows = 6,
                answerMinRows = 2,
                answerMaxRows = 4,
                resultMinHeightDp = 96,
            )
            spacious -> MobileLayoutProfile(
                horizontalPaddingDp = 16,
                verticalPaddingDp = 12,
                actionHeightDp = 50,
                rawMinRows = 5,
                rawMaxRows = 11,
                answerMinRows = 3,
                answerMaxRows = 7,
                resultMinHeightDp = 180,
            )
            else -> MobileLayoutProfile(
                horizontalPaddingDp = 13,
                verticalPaddingDp = 10,
                actionHeightDp = 46,
                rawMinRows = RAW_MIN_ROWS,
                rawMaxRows = RAW_MAX_ROWS,
                answerMinRows = ANSWER_MIN_ROWS,
                answerMaxRows = ANSWER_MAX_ROWS,
                resultMinHeightDp = 132,
            )
        }
    }

    fun loadingButtonText(): String = "생성 중…"

    fun showInlineEditTools(role: MobileEditorRole): Boolean =
        role == MobileEditorRole.RAW

    fun showVoiceInput(role: MobileEditorRole): Boolean =
        role == MobileEditorRole.RAW

    fun inlineMenuExpandedAfterBack(wasExpanded: Boolean): Boolean = wasExpanded

    fun surfaceForCollapse(screen: PanelScreenState): PanelSurface =
        if (screen == PanelScreenState.CHAT) PanelSurface.SIDE_CHAT else PanelSurface.WRITING

    fun sideChatMessageAction(
        role: String,
        editable: Boolean,
        busy: Boolean,
        hasMessageId: Boolean,
        hasContent: Boolean,
    ): SideChatMessageAction = when {
        role == "user" && editable && !busy && hasMessageId ->
            SideChatMessageAction.EDIT_LEFT
        role == "assistant" && hasContent -> SideChatMessageAction.COPY_RIGHT
        else -> SideChatMessageAction.NONE
    }

    fun clampedVisibleRows(text: String, minRows: Int, maxRows: Int): Int {
        require(minRows > 0 && maxRows >= minRows)
        val explicitRows = if (text.isEmpty()) 1 else text.count { it == '\n' } + 1
        return explicitRows.coerceIn(minRows, maxRows)
    }

    fun backAction(
        editorActive: Boolean,
        screen: PanelScreenState,
    ): PanelNavigationAction = when {
        editorActive -> PanelNavigationAction.HIDE_IME
        screen == PanelScreenState.HISTORY -> PanelNavigationAction.RETURN_FROM_HISTORY
        screen == PanelScreenState.CHAT -> PanelNavigationAction.RETURN_FROM_CHAT
        screen == PanelScreenState.GUESS -> PanelNavigationAction.CANCEL_GUESS
        else -> PanelNavigationAction.COLLAPSE_PANEL
    }

    fun outsideAction(
        editorActive: Boolean,
        contextMenuLikely: Boolean,
        touchInImeArea: Boolean,
    ): EditorOutsideAction = when {
        editorActive && touchInImeArea -> EditorOutsideAction.KEEP_EDITING
        editorActive && contextMenuLikely -> EditorOutsideAction.KEEP_EDITING
        editorActive -> EditorOutsideAction.HIDE_EDITOR
        else -> EditorOutsideAction.COLLAPSE_PANEL
    }

    fun imeBottomPadding(
        imeBottom: Int,
        systemBarBottom: Int,
        maximum: Int,
        alreadyResizedBy: Int = 0,
    ): Int {
        require(maximum >= 0 && alreadyResizedBy >= 0)
        return (imeBottom - systemBarBottom - alreadyResizedBy)
            .coerceAtLeast(0)
            .coerceAtMost(maximum)
    }

    fun isTouchInImeArea(rawY: Float, visibleFrameBottom: Int): Boolean =
        visibleFrameBottom > 0 && rawY >= visibleFrameBottom

    fun isConfirmedTap(
        deltaX: Float,
        deltaY: Float,
        touchSlop: Int,
    ): Boolean {
        require(touchSlop >= 0)
        return kotlin.math.abs(deltaX) <= touchSlop &&
            kotlin.math.abs(deltaY) <= touchSlop
    }

    fun popupPositionRange(
        popupSize: Int,
        screenSize: Int,
        recoverableEdge: Int,
    ): IntRange {
        require(popupSize > 0 && screenSize > 0 && recoverableEdge > 0)
        val visible = recoverableEdge.coerceAtMost(minOf(popupSize, screenSize))
        return (-popupSize + visible)..(screenSize - visible)
    }

    fun isInRemoveZone(
        rawX: Float,
        rawY: Float,
        screenWidth: Int,
        screenHeight: Int,
        horizontalRadius: Int,
        bottomZoneHeight: Int,
    ): Boolean =
        rawY >= screenHeight - bottomZoneHeight &&
            kotlin.math.abs(rawX - screenWidth / 2f) <= horizontalRadius
}
