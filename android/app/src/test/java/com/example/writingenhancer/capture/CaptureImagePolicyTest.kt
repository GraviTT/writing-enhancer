package com.example.writingenhancer.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureImagePolicyTest {
    @Test
    fun captureFitPreservesAspectRatioAndBoundsTheLongEdge() {
        val portrait = CaptureImagePolicy.fitCapture(1_440, 3_200)
        val landscape = CaptureImagePolicy.fitCapture(3_200, 1_440)

        assertEquals(1_920, portrait.height)
        assertEquals(864, portrait.width)
        assertEquals(1_920, landscape.width)
        assertEquals(864, landscape.height)
        assertTrue(kotlin.math.abs(portrait.width.toDouble() / portrait.height - 0.45) < 0.001)
    }

    @Test
    fun pngRetryShrinksProgressivelyButNeverBelowReadableFloor() {
        var size = CaptureDimensions(1_920, 1_080)
        var previousLongEdge = maxOf(size.width, size.height)
        repeat(12) {
            size = CaptureImagePolicy.nextPngSize(size.width, size.height)
            val nextLongEdge = maxOf(size.width, size.height)
            assertTrue(nextLongEdge <= previousLongEdge)
            assertTrue(nextLongEdge >= CaptureImagePolicy.MIN_OUTPUT_LONG_EDGE)
            previousLongEdge = nextLongEdge
        }
        assertEquals(CaptureImagePolicy.MIN_OUTPUT_LONG_EDGE, previousLongEdge)
    }
}
