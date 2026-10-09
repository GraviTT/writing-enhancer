package com.example.writingenhancer.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditMenuPolicyTest {
    @Test
    fun menuActionsReflectClipboardSelectionUndoAndText() {
        val caret = EditMenuPolicy.state(
            textLength = 5,
            selectionStart = 2,
            selectionEnd = 2,
            hasTextClipboard = true,
            canUndo = true,
        )
        assertTrue(caret.canPaste)
        assertTrue(caret.canUndo)
        assertFalse(caret.canCopy)
        assertFalse(caret.canCut)
        assertTrue(caret.canSelectAll)

        val selectedAll = EditMenuPolicy.state(
            textLength = 5,
            selectionStart = 5,
            selectionEnd = 0,
            hasTextClipboard = false,
            canUndo = false,
        )
        assertFalse(selectedAll.canPaste)
        assertFalse(selectedAll.canUndo)
        assertTrue(selectedAll.canCopy)
        assertTrue(selectedAll.canCut)
        assertFalse(selectedAll.canSelectAll)
    }

    @Test
    fun selectionRangeNormalizesDirectionAndRejectsCaret() {
        assertEquals(2 until 5, EditMenuPolicy.selectionRange(8, 5, 2))
        assertNull(EditMenuPolicy.selectionRange(8, 3, 3))
        assertNull(EditMenuPolicy.selectionRange(0, 0, 0))
        assertNull(EditMenuPolicy.selectionRange(8, -2, 99))
    }

    @Test
    fun wordRangeSelectsTheTouchedKoreanWordWithoutSystemActionMode() {
        assertEquals(0 until 2, EditMenuPolicy.wordRange("소설 장면", 1))
        assertEquals(3 until 5, EditMenuPolicy.wordRange("소설 장면", 4))
        assertEquals(3 until 5, EditMenuPolicy.wordRange("소설 장면", 5))
        assertNull(EditMenuPolicy.wordRange("소설 장면", 2))
        assertNull(EditMenuPolicy.wordRange("", 0))
    }

    @Test
    fun undoHistoryIgnoresDuplicatesAndKeepsNewestBoundedSnapshots() {
        val history = EditorUndoHistory(maximumSize = 2)
        val first = EditorSnapshot("가", 1, 1)
        val second = EditorSnapshot("가나", 2, 2)
        val third = EditorSnapshot("가나다", 3, 3)

        history.record(first, "가나")
        history.record(first, "가나")
        history.record(second, "가나다")
        history.record(third, "가나다라")

        assertEquals(third, history.pop())
        assertEquals(second, history.pop())
        assertNull(history.pop())
        assertFalse(history.canUndo())
    }
}
