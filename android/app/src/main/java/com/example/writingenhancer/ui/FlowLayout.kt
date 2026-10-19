package com.example.writingenhancer.ui

import android.content.Context
import android.view.View
import android.view.ViewGroup

/** 자식을 왼쪽부터 놓다가 자리가 모자라면 다음 줄로 넘기는 배치. 상황 버튼 목록에 쓴다. */
class FlowLayout(context: Context) : ViewGroup(context) {
    var horizontalGap = 0
    var verticalGap = 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val maxWidth = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
        val childSpec = MeasureSpec.makeMeasureSpec(maxWidth.coerceAtLeast(0), MeasureSpec.AT_MOST)
        var lineWidth = 0
        var lineHeight = 0
        var totalHeight = 0
        var widest = 0
        for (index in 0 until childCount) {
            val child = getChildAt(index)
            if (child.visibility == View.GONE) continue
            child.measure(childSpec, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            val width = child.measuredWidth
            if (lineWidth > 0 && lineWidth + horizontalGap + width > maxWidth) {
                totalHeight += lineHeight + verticalGap
                lineWidth = 0
                lineHeight = 0
            }
            lineWidth += if (lineWidth > 0) horizontalGap + width else width
            lineHeight = maxOf(lineHeight, child.measuredHeight)
            widest = maxOf(widest, lineWidth)
        }
        totalHeight += lineHeight
        val measuredWidth = if (MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.EXACTLY) {
            MeasureSpec.getSize(widthMeasureSpec)
        } else {
            widest + paddingLeft + paddingRight
        }
        setMeasuredDimension(measuredWidth, resolveSize(totalHeight + paddingTop + paddingBottom, heightMeasureSpec))
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val maxWidth = right - left - paddingLeft - paddingRight
        var x = 0
        var y = paddingTop
        var lineHeight = 0
        for (index in 0 until childCount) {
            val child = getChildAt(index)
            if (child.visibility == View.GONE) continue
            val width = child.measuredWidth
            if (x > 0 && x + horizontalGap + width > maxWidth) {
                y += lineHeight + verticalGap
                x = 0
                lineHeight = 0
            }
            if (x > 0) x += horizontalGap
            child.layout(paddingLeft + x, y, paddingLeft + x + width, y + child.measuredHeight)
            x += width
            lineHeight = maxOf(lineHeight, child.measuredHeight)
        }
    }
}
