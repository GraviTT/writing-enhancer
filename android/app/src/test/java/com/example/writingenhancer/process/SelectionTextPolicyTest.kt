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

    @Test
    fun situationButtonsFillTheFieldAndClearItWhenPressedAgain() {
        assertEquals("업무 메일", SelectionTextPolicy.toggleSituation("", "업무 메일"))
        assertEquals("", SelectionTextPolicy.toggleSituation(" 업무 메일 ", "업무 메일"))
        assertEquals("사과", SelectionTextPolicy.toggleSituation("친구에게", "사과"))
    }

    @Test
    fun summaryAndHintNameTheChosenLevelAndSituation() {
        assertEquals("3단계 원문 충실", SelectionTextPolicy.optionSummary(3, "  "))
        assertEquals(
            "1단계 핵심 요약 · 메신저로 보내는 답장",
            SelectionTextPolicy.optionSummary(1, "메신저로 보내는 답장"),
        )
        assertEquals("5단계 · 풍부하게 확장 — 원문 글자 수의 약 150~200%", SelectionTextPolicy.levelHint(9))
    }

    @Test
    fun savedLevelWinsOverTheWritingDraftLevel() {
        assertEquals(2, SelectionTextPolicy.initialLevel(saved = 2, draftLevel = 4))
        assertEquals(4, SelectionTextPolicy.initialLevel(saved = null, draftLevel = 4))
        assertEquals(1, SelectionTextPolicy.initialLevel(saved = 0, draftLevel = 4))
    }
}
