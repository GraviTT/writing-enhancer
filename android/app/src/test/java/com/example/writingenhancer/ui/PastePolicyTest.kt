package com.example.writingenhancer.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PastePolicyTest {
    @Test
    fun pasteReplacesOnlyTheCurrentSelectionAndPlacesCursorAfterIt() {
        val edit = PastePolicy.resolve(
            original = "앞의 오래된 문장 뒤",
            selectionStart = 3,
            selectionEnd = 9,
            hasTextMime = true,
            itemCount = 1,
            coerceItem = { "새 문장" },
        )

        requireNotNull(edit)
        assertEquals(3, edit.rangeStart)
        assertEquals(9, edit.rangeEnd)
        assertEquals("앞의 새 문장 뒤", edit.resultingText)
        assertEquals(7, edit.cursor)
    }

    @Test
    fun reversedSelectionAndMultipleTextItemsAreHandledDeterministically() {
        val edit = PastePolicy.resolve(
            original = "012345",
            selectionStart = 4,
            selectionEnd = 2,
            hasTextMime = true,
            itemCount = 2,
            coerceItem = { index -> if (index == 0) "가" else "나" },
        )

        requireNotNull(edit)
        assertEquals(2, edit.rangeStart)
        assertEquals(4, edit.rangeEnd)
        assertEquals("01가\n나45", edit.resultingText)
    }

    @Test
    fun emptyNonTextAndCoercionFailureLeaveTheOriginalUntouched() {
        assertNull(
            PastePolicy.resolve("원문", 0, 2, false, 1) { "무시" },
        )
        assertNull(
            PastePolicy.resolve("원문", 0, 2, true, 1) { "" },
        )
        assertNull(
            PastePolicy.resolve("원문", 0, 2, true, 1) {
                throw IllegalStateException("clipboard unavailable")
            },
        )
        assertNull(
            PastePolicy.resolve("원문", 0, 2, true, 1) { null },
        )
        assertEquals(
            true,
            PastePolicy.shouldUseNativeFallback(
                PastePolicy.resolve("원문", 0, 2, false, 1) { "무시" },
            ),
        )
        assertEquals(
            false,
            PastePolicy.shouldUseNativeFallback(
                PastePolicy.resolve("원문", 0, 2, true, 1) { "붙여넣기" },
            ),
        )
    }
}
