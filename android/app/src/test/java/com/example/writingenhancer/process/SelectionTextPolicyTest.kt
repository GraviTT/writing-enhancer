package com.example.writingenhancer.process

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SelectionTextPolicyTest {
    @Test
    fun enhanceInputIsTrimmedAndLimited() {
        assertEquals("내일 회의 미뤄줘", SelectionTextPolicy.enhanceInput("  내일 회의 미뤄줘\r\n"))
        assertNull(SelectionTextPolicy.enhanceInput("   "))
        assertNull(SelectionTextPolicy.enhanceInput(null))
        assertEquals(
            SelectionTextPolicy.MAX_ENHANCE_CHARACTERS,
            SelectionTextPolicy.enhanceInput("가".repeat(20_000))!!.length,
        )
        assertEquals("a\nb", SelectionTextPolicy.enhanceInput("a\u0000\r\nb"))
    }

    @Test
    fun chatDraftQuotesTheSelectionAndLeavesRoomForAQuestion() {
        assertEquals("“이 문장 어때?”\n\n", SelectionTextPolicy.chatDraft(" 이 문장 어때? "))
        assertNull(SelectionTextPolicy.chatDraft(""))
        val long = SelectionTextPolicy.chatDraft("나".repeat(5_000))!!
        assertTrue(long.endsWith("…”\n\n"))
        assertEquals(SelectionTextPolicy.MAX_CHAT_CHARACTERS + 5, long.length)
    }

    @Test
    fun replaceOnlyWhenTheSourceIsEditable() {
        assertTrue(SelectionTextPolicy.canReplace(readOnly = false))
        assertFalse(SelectionTextPolicy.canReplace(readOnly = true))
    }
}
