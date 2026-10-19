package com.example.writingenhancer.ai

import com.example.writingenhancer.capture.CaptureImagePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Windows의 desktop/tests/screen-read.test.js와 같은 사례를 확인한다.
class ScreenTextPolicyTest {
    @Test
    fun translationPromptMatchesTheWindowsTemplate() {
        assertEquals(
            "옮길 언어: 일본어\n상황: 없음\n\n번역할 글:\nThanks!",
            ScreenTextPolicy.translationPrompt(" Thanks! ", "ja", ""),
        )
        assertTrue(ScreenTextPolicy.translationPrompt("x", "xx", "업무 메일").startsWith("옮길 언어: 한국어\n상황: 업무 메일"))
        assertEquals("ko", ScreenTextPolicy.translationTarget(null).code)
        assertEquals("영어", ScreenTextPolicy.translationTarget(" EN ").label)
    }

    @Test
    fun imageTextIsTrimmedAndEmptyImagesHaveNoLanguage() {
        val read = ScreenTextPolicy.parseImageText(
            "{\"text\":\"  Hello\\r\\nworld  \",\"language\":\"EN\",\"language_name\":\"영어\"}",
            "GPT",
        )
        assertEquals("Hello\nworld", read.text)
        assertEquals("en", read.language)
        assertEquals("영어", read.languageName)
        val empty = ScreenTextPolicy.parseImageText(
            "```json\n{\"text\":\"\",\"language\":\"ko\",\"language_name\":\"한국어\"}\n```",
            "Gemini",
        )
        assertEquals("", empty.text)
        assertEquals("", empty.language)
        assertEquals("", empty.languageName)
    }

    @Test
    fun translationNeedsText() {
        assertEquals(
            "Please review the attached file.",
            ScreenTextPolicy.parseTranslation("{\"translated_text\":\" Please review the attached file. \"}", "GPT").translatedText,
        )
        val failure = runCatching { ScreenTextPolicy.parseTranslation("{\"translated_text\":\"  \"}", "GPT") }
        assertTrue(failure.isFailure)
    }

    @Test
    fun schemasRequireEveryField() {
        assertEquals(
            listOf("text", "language", "language_name"),
            ScreenTextPolicy.imageTextSchema().getJSONArray("required").let { array -> List(array.length()) { array.getString(it) } },
        )
        assertEquals("translated_text", ScreenTextPolicy.translationSchema().getJSONArray("required").getString(0))
        assertTrue(SharedWritingRules.IMAGE_TEXT_SYSTEM.contains("[?]"))
        assertTrue(SharedWritingRules.TRANSLATION_TARGETS.any { it.code == "ko" })
    }

    @Test
    fun screenReadCapturesKeepNearlyFullResolution() {
        assertEquals(1080, CaptureImagePolicy.fitReadCapture(1080, 2640).width)
        assertEquals(2640, CaptureImagePolicy.fitReadCapture(1080, 2640).height)
        assertEquals(3200, CaptureImagePolicy.fitReadCapture(1440, 3600).height)
        assertEquals(1920, CaptureImagePolicy.fitCapture(1080, 2640).height)
    }
}
