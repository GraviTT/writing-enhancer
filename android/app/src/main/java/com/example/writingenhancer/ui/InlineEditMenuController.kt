package com.example.writingenhancer.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import com.example.writingenhancer.ui.Ui.dp

class InlineEditMenuController(
    private val context: Context,
    private val dark: Boolean,
) {
    private var menuView: View? = null
    var editor: PasteFriendlyEditText? = null
        private set

    val isVisible: Boolean
        get() = menuView != null

    fun menuButton(target: PasteFriendlyEditText): Button = Button(context).apply {
        text = "⋯"
        contentDescription = "편집 메뉴"
        isAllCaps = false
        textSize = 18f
        setTextColor(if (dark) Color.WHITE else Ui.INK)
        minWidth = 0
        minimumWidth = 0
        minHeight = 0
        minimumHeight = 0
        setPadding(0, 0, 0, context.dp(3))
        background = Ui.interactive(context, if (dark) Ui.PANEL_RAISED else 0xFFE4E0EC.toInt())
        stateListAnimator = null
        setOnClickListener {
            if (isVisible && editor === target) {
                hide()
            } else {
                target.requestEditMenu()
            }
        }
    }

    fun show(target: PasteFriendlyEditText) {
        if (target.parent !is LinearLayout) return
        hide()
        val parent = target.parent as LinearLayout
        val state = EditMenuPolicy.state(
            textLength = target.text?.length ?: 0,
            selectionStart = target.selectionStart,
            selectionEnd = target.selectionEnd,
            hasTextClipboard = target.hasTextClipboard(),
            canUndo = target.canUndo(),
        )
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dp(3), context.dp(3), context.dp(3), context.dp(3))
            background = Ui.rounded(
                if (dark) 0xFF292831.toInt() else 0xFFF1EFF5.toInt(),
                13,
                context,
            )
        }

        fun addAction(
            label: String,
            enabled: Boolean,
            action: () -> Unit,
        ) {
            val button = Button(context).apply {
                text = label
                isAllCaps = false
                textSize = 11f
                setTextColor(if (dark) Color.WHITE else Ui.INK)
                minWidth = 0
                minimumWidth = 0
                minHeight = 0
                minimumHeight = 0
                setPadding(context.dp(2), 0, context.dp(2), 0)
                background = Ui.interactive(context, if (dark) Ui.PANEL_FIELD else 0xFFE4E0EC.toInt())
                stateListAnimator = null
                isEnabled = enabled
                alpha = if (enabled) 1f else 0.34f
                isFocusable = false
                setOnClickListener { action() }
            }
            row.addView(
                button,
                LinearLayout.LayoutParams(0, context.dp(39), 1f).apply {
                    marginStart = if (row.childCount == 0) 0 else context.dp(3)
                },
            )
        }

        addAction("붙여넣기", state.canPaste) {
            target.pasteFromClipboard()
            hide()
        }
        addAction("되돌리기", state.canUndo) {
            target.undoLastEdit()
            hide()
        }
        addAction("복사", state.canCopy) {
            target.copySelection()
            hide()
        }
        addAction("잘라내기", state.canCut) {
            target.cutSelection()
            hide()
        }
        addAction("전체 선택", state.canSelectAll) {
            target.selectAll()
            show(target)
        }

        val index = parent.indexOfChild(target)
        parent.addView(
            row,
            index + 1,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                context.dp(45),
            ).apply {
                topMargin = context.dp(5)
                bottomMargin = context.dp(4)
            },
        )
        menuView = row
        editor = target
        row.post {
            row.requestRectangleOnScreen(
                Rect(0, 0, row.width, row.height + context.dp(12)),
                false,
            )
        }
    }

    fun hide() {
        menuView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        menuView = null
        editor = null
    }
}
