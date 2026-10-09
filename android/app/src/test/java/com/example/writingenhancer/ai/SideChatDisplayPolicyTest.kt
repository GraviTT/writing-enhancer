package com.example.writingenhancer.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SideChatDisplayPolicyTest {
    @Test
    fun searchedAnswerKeepsLinkLabelButHidesLongRawUrl() {
        val raw = "캐릭터 설명입니다. ([m.namu.moe](https://m.namu.moe/w/%ED%81%90%EC%96%B4?utm_source=openai))"
        val clean = SideChatDisplayPolicy.clean(raw, externallyGrounded = true)

        assertEquals("캐릭터 설명입니다. (m.namu.moe)", clean)
        assertFalse(clean.contains("https://"))
        assertFalse(clean.contains("utm_source"))
    }

    @Test
    fun bareSearchUrlBecomesCompactDomainAndLocalAnswerIsUntouched() {
        val searched = SideChatDisplayPolicy.clean(
            "자세한 내용 https://www.example.com/a/very/long/path?q=1",
            externallyGrounded = true,
        )
        assertTrue(searched.contains("[example.com]"))
        assertEquals(
            "https://example.com을 문장에 넣어 줘",
            SideChatDisplayPolicy.clean(
                "https://example.com을 문장에 넣어 줘",
                externallyGrounded = false,
            ),
        )
    }
}
