package com.example.writingenhancer.ui

import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.roundToInt

class WindowDragTouchListener(
    view: View,
    private val onDelta: (deltaX: Int, deltaY: Int) -> Unit,
    private val onFinished: () -> Unit = {},
) : View.OnTouchListener {
    private val touchSlop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var lastRawX = 0f
    private var lastRawY = 0f
    private var downRawX = 0f
    private var downRawY = 0f
    private var moved = false

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouch(view: View, event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downRawX = event.rawX
                downRawY = event.rawY
                lastRawX = event.rawX
                lastRawY = event.rawY
                moved = false
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                moved = moved ||
                    !MobileUiPolicy.isConfirmedTap(
                        event.rawX - downRawX,
                        event.rawY - downRawY,
                        touchSlop,
                    )
                if (moved) {
                    val deltaX = (event.rawX - lastRawX).roundToInt()
                    val deltaY = (event.rawY - lastRawY).roundToInt()
                    if (deltaX != 0 || deltaY != 0) onDelta(deltaX, deltaY)
                    lastRawX = event.rawX
                    lastRawY = event.rawY
                }
                return true
            }

            MotionEvent.ACTION_UP -> {
                if (!moved) view.performClick()
                onFinished()
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                onFinished()
                return true
            }
        }
        return false
    }
}
