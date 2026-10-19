package com.example.writingenhancer.capture

import kotlin.math.roundToInt

data class CaptureDimensions(
    val width: Int,
    val height: Int,
)

/** Keeps a one-shot screen image bounded without changing its aspect ratio. */
object CaptureImagePolicy {
    const val MAX_CAPTURE_LONG_EDGE = 1_920
    const val MIN_OUTPUT_LONG_EDGE = 640
    private const val RETRY_SCALE = 0.82

    // 화면 글 읽기는 작은 글자도 읽어야 하므로 거의 원래 해상도(QHD+ 휴대폰까지)로 찍는다.
    const val MAX_READ_CAPTURE_LONG_EDGE = 3_200

    fun fitCapture(width: Int, height: Int): CaptureDimensions =
        fitWithin(width, height, MAX_CAPTURE_LONG_EDGE)

    fun fitReadCapture(width: Int, height: Int): CaptureDimensions =
        fitWithin(width, height, MAX_READ_CAPTURE_LONG_EDGE)

    fun nextPngSize(width: Int, height: Int): CaptureDimensions {
        val longEdge = maxOf(width, height)
        if (longEdge <= MIN_OUTPUT_LONG_EDGE) {
            return CaptureDimensions(width.coerceAtLeast(1), height.coerceAtLeast(1))
        }
        val nextLongEdge = maxOf(
            MIN_OUTPUT_LONG_EDGE,
            (longEdge * RETRY_SCALE).roundToInt(),
        )
        return fitWithin(width, height, nextLongEdge)
    }

    private fun fitWithin(width: Int, height: Int, maximumLongEdge: Int): CaptureDimensions {
        require(width > 0 && height > 0 && maximumLongEdge > 0)
        val longEdge = maxOf(width, height)
        if (longEdge <= maximumLongEdge) return CaptureDimensions(width, height)
        val scale = maximumLongEdge.toDouble() / longEdge.toDouble()
        return CaptureDimensions(
            width = (width * scale).roundToInt().coerceAtLeast(1),
            height = (height * scale).roundToInt().coerceAtLeast(1),
        )
    }
}
