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
    fun foreignTextOpensInTranslationMode() {
        assertTrue(SelectionTextPolicy.suggestsTranslation("Your order has shipped!"))
        assertTrue(SelectionTextPolicy.suggestsTranslation("今日はいい天気ですね"))
        assertFalse(SelectionTextPolicy.suggestsTranslation("내일 회의 자료 보내 줄게"))
        assertFalse(SelectionTextPolicy.suggestsTranslation("API 키 확인"))
        assertFalse(SelectionTextPolicy.suggestsTranslation("ok"))
        assertTrue(SelectionTextPolicy.suggestsTranslation("안녕하세요", "en"))
        assertFalse(SelectionTextPolicy.suggestsTranslation("Hello", "ko"))
    }

    @Test
    fun screenTextLabelsAndTranslationSummaries() {
        assertEquals(
            "화면에서 읽은 글 · 영어 · 114자 · 고쳐 써도 돼요",
            SelectionTextPolicy.originalLabel(114, fromScreen = true, languageName = "영어"),
        )
        assertEquals("번역 · 한국어", SelectionTextPolicy.translationSummary("한국어", " "))
        assertEquals("번역 · 영어 · 업무 메일", SelectionTextPolicy.translationSummary("영어", "업무 메일"))
        assertEquals("번역 → 한국어", SelectionTextPolicy.translationHistorySituation("한국어", ""))
    }

    @Test
    fun savedLevelWinsOverTheWritingDraftLevel() {
        assertEquals(2, SelectionTextPolicy.initialLevel(saved = 2, draftLevel = 4))
        assertEquals(4, SelectionTextPolicy.initialLevel(saved = null, draftLevel = 4))
        assertEquals(1, SelectionTextPolicy.initialLevel(saved = 0, draftLevel = 4))
    }
}
