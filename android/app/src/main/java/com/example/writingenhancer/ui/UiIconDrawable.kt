package com.example.writingenhancer.ui

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable

enum class UiIcon { HISTORY, CHAT, SETTINGS, CLOSE, NEW, COPY, EDIT, BACK, NEXT, RESIZE }

/** Small, consistent native line icons; no font/emoji substitution across Android devices. */
class UiIconDrawable(private val icon: UiIcon, color: Int) : Drawable() {
    private val pen = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.STROKE
        strokeWidth = 1.7f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    override fun draw(canvas: Canvas) {
        val checkpoint = canvas.save()
        canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
        canvas.scale(bounds.width() / 24f, bounds.height() / 24f)
        fun line(vararg points: Float) {
            val path = Path().apply {
                moveTo(points[0], points[1])
                for (index in 2 until points.size step 2) lineTo(points[index], points[index + 1])
            }
            canvas.drawPath(path, pen)
        }
        when (icon) {
            UiIcon.CLOSE -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
            UiIcon.BACK -> line(14f, 5f, 7f, 12f, 14f, 19f)
            UiIcon.NEXT -> line(10f, 5f, 17f, 12f, 10f, 19f)
            UiIcon.NEW -> { line(12f, 5f, 12f, 19f); line(5f, 12f, 19f, 12f) }
            UiIcon.CHAT -> {
                line(5f, 4f, 19f, 4f, 21f, 6f, 21f, 16f, 19f, 18f,
                    9f, 18f, 4f, 21f, 4f, 18f, 3f, 16f, 3f, 6f, 5f, 4f)
                line(7f, 9f, 17f, 9f); line(7f, 13f, 14f, 13f)
            }
            UiIcon.HISTORY -> {
                canvas.drawArc(4f, 4f, 20f, 20f, -150f, 300f, false, pen)
                line(3f, 3f, 3f, 9f, 8f, 9f)
                line(12f, 7f, 12f, 12f, 16f, 14f)
            }
            UiIcon.COPY -> {
                canvas.drawRoundRect(8f, 8f, 20f, 21f, 2f, 2f, pen)
                line(15f, 4f, 5f, 4f, 4f, 5f, 4f, 15f)
            }
            UiIcon.EDIT -> {
                line(4f, 16f, 16f, 4f, 20f, 8f, 8f, 20f, 4f, 20f, 4f, 16f)
                line(13f, 7f, 17f, 11f)
            }
            UiIcon.SETTINGS -> {
                canvas.drawCircle(12f, 12f, 7f, pen)
                canvas.drawCircle(12f, 12f, 2.5f, pen)
                repeat(8) {
                    val saved = canvas.save()
                    canvas.rotate(it * 45f, 12f, 12f)
                    line(12f, 2f, 12f, 5f)
                    canvas.restoreToCount(saved)
                }
            }
            UiIcon.RESIZE -> { line(8f, 19f, 19f, 8f); line(14f, 19f, 19f, 14f) }
        }
        canvas.restoreToCount(checkpoint)
    }

    override fun setAlpha(alpha: Int) { pen.alpha = alpha; invalidateSelf() }
    override fun setColorFilter(colorFilter: ColorFilter?) { pen.colorFilter = colorFilter; invalidateSelf() }
    @Deprecated("Deprecated in Android")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
