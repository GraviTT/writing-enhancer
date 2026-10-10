package com.example.writingenhancer.ui

import android.graphics.Color
import android.graphics.Rect
import android.view.ActionMode
import android.view.Gravity
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import com.example.writingenhancer.ui.Ui.dp

/**
 * 오버레이 창용 글자 선택 메뉴.
 *
 * Android는 길게 눌러 글을 선택하면 창의 바깥 틀(일반 앱 화면의 DecorView)에 떠 있는 메뉴를 만들어 달라고
 * 하는데, 서비스가 WindowManager로 띄운 오버레이 창에는 그 틀이 없어 메뉴가 생기지 않는다.
 * 패널의 바깥 틀이 이 클래스로 대신 만들어 준다. 메뉴 항목(잘라내기·복사·붙여넣기·모두 선택·공유)과
 * 문구, 누른 뒤의 동작은 모두 Android가 채우고 처리한다.
 */
class OverlayTextActionMode(
    private val host: FrameLayout,
    private val originalView: View,
    private val callback: ActionMode.Callback,
    private val onFinished: (OverlayTextActionMode) -> Unit,
) : ActionMode() {
    private val menu: Menu = PopupMenu(host.context, originalView).menu
    private var bar: View? = null
    private var finished = false
    private var hiddenUntil = 0L
    private val reshow = Runnable { render() }

    init {
        type = TYPE_FLOATING
    }

    fun start(): Boolean {
        if (!callback.onCreateActionMode(this, menu)) return false
        invalidate()
        return true
    }

    override fun setTitle(title: CharSequence?) = Unit

    override fun setTitle(resId: Int) = Unit

    override fun setSubtitle(subtitle: CharSequence?) = Unit

    override fun setSubtitle(resId: Int) = Unit

    override fun setCustomView(view: View?) = Unit

    override fun getMenu(): Menu = menu

    override fun getTitle(): CharSequence? = null

    override fun getSubtitle(): CharSequence? = null

    override fun getCustomView(): View? = null

    override fun getMenuInflater(): MenuInflater = MenuInflater(host.context)

    override fun invalidate() {
        if (finished) return
        callback.onPrepareActionMode(this, menu)
        render()
    }

    override fun invalidateContentRect() {
        if (!finished) bar?.let(::place)
    }

    override fun hide(duration: Long) {
        if (finished) return
        val hideFor = when {
            duration == DEFAULT_HIDE_DURATION.toLong() -> 2_000L
            duration <= 0 -> 0L
            else -> minOf(duration, 3_000L)
        }
        host.removeCallbacks(reshow)
        if (hideFor == 0L) {
            render()
            return
        }
        hiddenUntil = System.currentTimeMillis() + hideFor
        bar?.visibility = View.GONE
        host.postDelayed(reshow, hideFor)
    }

    override fun finish() {
        if (finished) return
        finished = true
        host.removeCallbacks(reshow)
        bar?.let(host::removeView)
        bar = null
        callback.onDestroyActionMode(this)
        onFinished(this)
    }

    private fun visibleItems(): List<MenuItem> =
        (0 until menu.size())
            .map(menu::getItem)
            .filter { item ->
                // 다른 앱으로 넘기는 항목(PROCESS_TEXT 등)은 서비스 창에서 결과를 받을 수 없어 뺀다.
                item.isVisible && item.intent == null && item.itemId in SUPPORTED_ITEMS
            }
            .sortedBy { it.order }

    private fun render() {
        if (finished) return
        bar?.let(host::removeView)
        bar = null
        if (System.currentTimeMillis() < hiddenUntil) return
        val items = visibleItems()
        if (items.isEmpty()) return
        val context = host.context
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dp(4), context.dp(4), context.dp(4), context.dp(4))
            background = Ui.rounded(0xFF2D2C35.toInt(), 14, context, Ui.PANEL_STROKE)
            elevation = context.dp(6).toFloat()
            // 메뉴를 누를 때 선택 영역의 초점을 빼앗지 않는다.
            isFocusable = false
        }
        items.forEach { item ->
            row.addView(
                Button(context).apply {
                    text = item.title
                    isAllCaps = false
                    textSize = 14f
                    setTextColor(if (item.isEnabled) Color.WHITE else Ui.PANEL_MUTED)
                    isEnabled = item.isEnabled
                    isFocusable = false
                    minWidth = 0
                    minimumWidth = 0
                    minHeight = context.dp(40)
                    minimumHeight = context.dp(40)
                    setPadding(context.dp(12), 0, context.dp(12), 0)
                    background = Ui.interactive(context, Color.TRANSPARENT, 10)
                    stateListAnimator = null
                    contentDescription = item.title
                    setOnClickListener { if (!finished) callback.onActionItemClicked(this@OverlayTextActionMode, item) }
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(40)),
            )
        }
        host.addView(
            row,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
        bar = row
        row.visibility = View.INVISIBLE
        row.post { if (!finished && bar === row) place(row) }
    }

    // 선택한 글 바로 위에, 자리가 없으면 아래에 둔다. 패널 밖으로 나가지 않게 맞춘다.
    private fun place(row: View) {
        val content = Rect()
        if (callback is ActionMode.Callback2) {
            callback.onGetContentRect(this, originalView, content)
        } else {
            content.set(0, 0, originalView.width, originalView.height)
        }
        val viewLocation = IntArray(2).also(originalView::getLocationInWindow)
        val hostLocation = IntArray(2).also(host::getLocationInWindow)
        content.offset(viewLocation[0] - hostLocation[0], viewLocation[1] - hostLocation[1])
        val gap = host.context.dp(8)
        val width = row.width.takeIf { it > 0 } ?: row.measuredWidth
        val height = row.height.takeIf { it > 0 } ?: row.measuredHeight
        val above = content.top - height - gap
        val y = if (above >= 0) above else minOf(content.bottom + gap, host.height - height)
        val x = (content.centerX() - width / 2).coerceIn(0, maxOf(0, host.width - width))
        row.translationX = x.toFloat()
        row.translationY = y.coerceAtLeast(0).toFloat()
        row.visibility = View.VISIBLE
    }

    companion object {
        // 공유는 Android가 서비스 창에서 새 화면을 열지 못해(앱이 종료됨) 빼고, 편집 항목만 둔다.
        private val SUPPORTED_ITEMS = setOf(
            android.R.id.cut,
            android.R.id.copy,
            android.R.id.paste,
            android.R.id.pasteAsPlainText,
            android.R.id.selectAll,
        )
    }
}
