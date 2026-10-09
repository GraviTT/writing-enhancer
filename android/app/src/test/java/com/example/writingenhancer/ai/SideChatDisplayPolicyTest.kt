package com.example.writingenhancer.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SideChatDisplayPolicyTest {
    @Test
    fun progressLabelShowsStageAndElapsedSecondsAfterThreeSeconds() {
        assertEquals("답변을 준비하는 중", SideChatDisplayPolicy.progressLabel(null, 1_500))
        assertEquals(
            "웹에서 찾아보는 중 · 14초",
            SideChatDisplayPolicy.progressLabel(
                SideChatProgress(SideChatProgress.Stage.REQUESTING, "GPT", searchRequired = true),
                14_200,
            ),
        )
        assertEquals(
            "다른 AI로 다시 시도하는 중 · 41초",
            SideChatDisplayPolicy.progressLabel(
                SideChatProgress(SideChatProgress.Stage.FALLBACK, "Gemini", searchRequired = true),
                41_000,
            ),
        )
    }

    @Test
    fun pendingActionCardDescribesTheChangeAndPreviewsOnlyTextChanges() {
        assertEquals(
            "상황 안내를 이 내용으로 바꾸기",
            SideChatDisplayPolicy.pendingActionLabel(SideChatAction("set_situation", "회의 안내")),
        )
        assertEquals(
            "강화 범위를 4단계로 바꾸기",
            SideChatDisplayPolicy.pendingActionLabel(SideChatAction("set_enhancement_level", "4")),
        )
        assertEquals(
            "회의 안내",
            SideChatDisplayPolicy.pendingActionPreview(SideChatAction("set_situation", " 회의 안내 ")),
        )
        assertEquals(null, SideChatDisplayPolicy.pendingActionPreview(SideChatAction("enhance", "")))
        val long = "가".repeat(700)
        val preview = SideChatDisplayPolicy.pendingActionPreview(SideChatAction("replace_source", long))
        assertEquals(601, preview?.length)
        assertTrue(preview.orEmpty().endsWith("…"))
    }
}
