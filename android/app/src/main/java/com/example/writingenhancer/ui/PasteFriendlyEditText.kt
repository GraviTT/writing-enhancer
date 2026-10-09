package com.example.writingenhancer.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Rect
import android.text.Editable
import android.text.TextWatcher
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.inputmethod.InputMethodManager
import android.widget.EditText

@android.annotation.SuppressLint("ViewConstructor")
class PasteFriendlyEditText(
    context: Context,
    minRows: Int,
    maxRows: Int,
    private val onBack: (() -> Unit)? = null,
    private val onEditMenuRequested: (PasteFriendlyEditText) -> Unit,
    // 길게 누르면 Android 기본 복사·붙여넣기 메뉴를 띄운다. false면 기본 메뉴 대신 앱 자체 편집 메뉴를 연다.
    private val useNativeActionMode: Boolean = true,
) : EditText(context) {
    private val undoHistory = EditorUndoHistory()
    private var beforeEdit: EditorSnapshot? = null
    private var suppressUndoRecording = false
    private var focusedAtTouchDown = false
    private var longPressHandled = false
    private var downTouchX = 0f
    private var downTouchY = 0f
    private var gestureMoved = false
    private var editMenuProtection = false
    private var nativeActionModeActive = false
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

    val contextMenuLikely: Boolean
        get() = longPressHandled ||
            editMenuProtection ||
            nativeActionModeActive ||
            (
                selectionStart >= 0 &&
                    selectionEnd >= 0 &&
                    selectionStart != selectionEnd
                )

    init {
        minLines = minRows
        maxLines = maxRows
        isVerticalScrollBarEnabled = true
        overScrollMode = OVER_SCROLL_IF_CONTENT_SCROLLS
        setHorizontallyScrolling(false)
        showSoftInputOnFocus = false
        isLongClickable = true
        isFocusableInTouchMode = true
        if (useNativeActionMode) {
            customInsertionActionModeCallback = nativeActionModeTracker()
            customSelectionActionModeCallback = nativeActionModeTracker()
        } else {
            val inlineActionModeCallback = object : ActionMode.Callback {
                override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean {
                    protectEditMenuRequest()
                    post { onEditMenuRequested(this@PasteFriendlyEditText) }
                    return false
                }

                override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean = false

                override fun onActionItemClicked(
                    mode: ActionMode?,
                    item: MenuItem?,
                ): Boolean = false

                override fun onDestroyActionMode(mode: ActionMode?) = Unit
            }
            customInsertionActionModeCallback = inlineActionModeCallback
            customSelectionActionModeCallback = inlineActionModeCallback
        }
        addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(
                    sequence: CharSequence?,
                    start: Int,
                    count: Int,
                    after: Int,
                ) {
                    if (!suppressUndoRecording) {
                        beforeEdit = EditorSnapshot(
                            text = sequence?.toString().orEmpty(),
                            selectionStart = selectionStart,
                            selectionEnd = selectionEnd,
                        )
                    }
                }

                override fun onTextChanged(
                    sequence: CharSequence?,
                    start: Int,
                    before: Int,
                    count: Int,
                ) = Unit

                override fun afterTextChanged(editable: Editable?) {
                    if (!suppressUndoRecording) {
                        beforeEdit?.let {
                            undoHistory.record(it, editable?.toString().orEmpty())
                        }
                    }
                    beforeEdit = null
                }
            },
        )
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                focusedAtTouchDown = hasFocus()
                longPressHandled = false
                downTouchX = event.x
                downTouchY = event.y
                gestureMoved = false
                showSoftInputOnFocus = focusedAtTouchDown
                parent?.requestDisallowInterceptTouchEvent(false)
            }

            MotionEvent.ACTION_MOVE -> {
                gestureMoved = gestureMoved ||
                    !MobileUiPolicy.isConfirmedTap(
                        deltaX = event.x - downTouchX,
                        deltaY = event.y - downTouchY,
                        touchSlop = touchSlop,
                    )
            }

            MotionEvent.ACTION_CANCEL -> {
                gestureMoved = true
                longPressHandled = false
            }
        }
        val handled = super.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP && hasFocus()) {
            val confirmedTap = !gestureMoved &&
                MobileUiPolicy.isConfirmedTap(
                    deltaX = event.x - downTouchX,
                    deltaY = event.y - downTouchY,
                    touchSlop = touchSlop,
                )
            when {
                confirmedTap && !longPressHandled -> {
                    showSoftInputOnFocus = true
                    showKeyboard()
                }

                !focusedAtTouchDown && gestureMoved && !contextMenuLikely -> {
                    showSoftInputOnFocus = false
                    clearFocus()
                }
            }
        }
        return handled
    }

    override fun performClick(): Boolean = super.performClick()

    override fun performLongClick(): Boolean {
        longPressHandled = true
        val handled = super.performLongClick()
        postDelayed(
            {
                if (selectionStart == selectionEnd) longPressHandled = false
            },
            LONG_PRESS_PROTECTION_MS,
        )
        return handled
    }

    fun requestEditMenu() {
        if (!hasFocus()) requestFocusFromTouch()
        protectEditMenuRequest()
        onEditMenuRequested(this)
    }

    fun setInitialText(value: String) {
        suppressUndoRecording = true
        try {
            setText(value)
            setSelection(text?.length ?: 0)
            undoHistory.clear()
        } finally {
            suppressUndoRecording = false
            beforeEdit = null
        }
    }

    fun hasTextClipboard(): Boolean = runCatching {
        val clipboard =
            context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.hasPrimaryClip() &&
            clipboard.primaryClipDescription?.hasMimeType("text/*") == true
    }.getOrDefault(false)

    fun canUndo(): Boolean = undoHistory.canUndo()

    fun undoLastEdit(): Boolean {
        val snapshot = undoHistory.pop() ?: return false
        suppressUndoRecording = true
        return try {
            setText(snapshot.text)
            val start = snapshot.selectionStart.coerceIn(0, text?.length ?: 0)
            val end = snapshot.selectionEnd.coerceIn(0, text?.length ?: 0)
            setSelection(start, end)
            true
        } finally {
            suppressUndoRecording = false
            beforeEdit = null
        }
    }

    fun copySelection(): Boolean {
        val current = text?.toString().orEmpty()
        val range = EditMenuPolicy.selectionRange(
            current.length,
            selectionStart,
            selectionEnd,
        ) ?: return false
        val selected = current.substring(range.first, range.last + 1)
        return runCatching {
            val clipboard =
                context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("복사한 글", selected))
        }.isSuccess
    }

    fun cutSelection(): Boolean {
        val current = text?.toString().orEmpty()
        val range = EditMenuPolicy.selectionRange(
            current.length,
            selectionStart,
            selectionEnd,
        ) ?: return false
        if (!copySelection()) return false
        text?.delete(range.first, range.last + 1)
        setSelection(range.first.coerceIn(0, text?.length ?: 0))
        return true
    }

    fun pasteFromClipboard(): Boolean =
        applyClipboardPaste() ||
            runCatching { super.onTextContextMenuItem(android.R.id.paste) }
                .getOrDefault(false)

    override fun onTextContextMenuItem(id: Int): Boolean {
        if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
            return pasteFromClipboard()
        }
        return runCatching { super.onTextContextMenuItem(id) }.getOrDefault(false)
    }

    private fun applyClipboardPaste(): Boolean {
        val edit = runCatching {
            val clipboard =
                context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = clipboard.primaryClip
            clip?.let {
                PastePolicy.resolve(
                    original = text?.toString().orEmpty(),
                    selectionStart = selectionStart,
                    selectionEnd = selectionEnd,
                    hasTextMime = clipboard.primaryClipDescription
                        ?.hasMimeType("text/*") == true,
                    itemCount = it.itemCount,
                    coerceItem = { index -> it.getItemAt(index).coerceToText(context) },
                )
            }
        }.getOrNull()
        if (PastePolicy.shouldUseNativeFallback(edit)) return false
        return runCatching {
            requireNotNull(edit)
            text?.replace(edit.rangeStart, edit.rangeEnd, edit.insertedText)
            setSelection(edit.cursor.coerceIn(0, text?.length ?: 0))
        }.isSuccess
    }

    override fun onFocusChanged(
        focused: Boolean,
        direction: Int,
        previouslyFocusedRect: Rect?,
    ) {
        super.onFocusChanged(focused, direction, previouslyFocusedRect)
        if (!focused) prepareForFocusLoss()
    }

    fun prepareForFocusLoss() {
        longPressHandled = false
        editMenuProtection = false
        nativeActionModeActive = false
        showSoftInputOnFocus = false
    }

    fun consumeContextMenuProtection() {
        if (selectionStart == selectionEnd) longPressHandled = false
    }

    private fun showKeyboard() {
        post {
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun protectEditMenuRequest() {
        editMenuProtection = true
        postDelayed({ editMenuProtection = false }, LONG_PRESS_PROTECTION_MS)
    }

    private fun nativeActionModeTracker() = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean {
            nativeActionModeActive = true
            protectEditMenuRequest()
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean = true

        override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean = false

        override fun onDestroyActionMode(mode: ActionMode?) {
            nativeActionModeActive = false
        }
    }

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        val back = onBack
        if (
            back != null &&
            keyCode == KeyEvent.KEYCODE_BACK &&
            event.action == KeyEvent.ACTION_UP
        ) {
            back()
            return true
        }
        return super.onKeyPreIme(keyCode, event)
    }

    private companion object {
        const val LONG_PRESS_PROTECTION_MS = 1_200L
    }
}
