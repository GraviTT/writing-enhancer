package com.example.writingenhancer.data

import com.example.writingenhancer.ai.SideChatMessage
import com.example.writingenhancer.ai.WebSource
import com.example.writingenhancer.ai.WebSourcePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SideChatPolicyTest {
    @Test
    fun trimPreservesAssistantExternalProvenanceAndNeverAssignsItToUsers() {
        val trimmed = SideChatPolicy.trim(
            listOf(
                SideChatMessage(
                    "u",
                    "user",
                    "질문",
                    1,
                    untrustedExternalContext = true,
                ),
                SideChatMessage(
                    "a",
                    "assistant",
                    "화면 기반 답변",
                    2,
                    untrustedExternalContext = true,
                ),
            ),
        )

        assertFalse(trimmed[0].untrustedExternalContext)
        assertTrue(trimmed[1].untrustedExternalContext)
    }

    @Test
    fun sourcesMissingFlagIsKeptOnlyForAssistantMessages() {
        val trimmed = SideChatPolicy.trim(
            listOf(
                SideChatMessage("u", "user", "최신 규정 검색해줘", 1, sourcesMissing = true),
                SideChatMessage(
                    "a",
                    "assistant",
                    "확인하지 못했어요",
                    2,
                    untrustedExternalContext = true,
                    sourcesMissing = true,
                ),
                SideChatMessage("a2", "assistant", "일반 답변", 3),
            ),
        )

        assertFalse(trimmed[0].sourcesMissing)
        assertTrue(trimmed[1].sourcesMissing)
        assertFalse(trimmed[2].sourcesMissing)
    }

    @Test
    fun messagesAreSanitizedAndBoundedIndependentlyFromWritingHistory() {
        val messages = (0 until SideChatPolicy.MAX_MESSAGES + 5).map { index ->
            SideChatMessage(
                id = "$index",
                role = if (index % 2 == 0) "user" else "assistant",
                content = "\u0000 message-$index ",
                createdAt = index.toLong(),
            )
        }
        val trimmed = SideChatPolicy.trim(messages)

        assertEquals(SideChatPolicy.MAX_MESSAGES, trimmed.size)
        assertEquals("message-5", trimmed.first().content)
        assertEquals("message-64", trimmed.last().content)
        assertTrue(trimmed.none { it.content.contains('\u0000') })
    }

    @Test
    fun editingUserMessageRemovesEverythingAfterIt() {
        val messages = listOf(
            SideChatMessage("u1", "user", "첫 질문", 1),
            SideChatMessage("a1", "assistant", "첫 답", 2),
            SideChatMessage("u2", "user", "둘째 질문", 3),
            SideChatMessage("a2", "assistant", "둘째 답", 4),
        )

        val rewritten = SideChatPolicy.rewriteFromUser(
            messages = messages,
            messageId = "u1",
            content = "수정된 첫 질문",
            now = 10,
        )

        assertEquals(1, rewritten?.size)
        assertEquals("수정된 첫 질문", rewritten?.single()?.content)
        assertEquals(10L, rewritten?.single()?.createdAt)
        assertNull(
            SideChatPolicy.rewriteFromUser(
                messages = messages,
                messageId = "missing",
                content = "내용",
                now = 11,
            ),
        )
    }

    @Test
    fun searchSourcesAreSafeDeduplicatedAndAssistantOnly() {
        val sources = WebSourcePolicy.normalize(
            listOf(
                WebSource("공식 자료", "https://example.com/source"),
                WebSource("중복", "https://example.com/source"),
                WebSource("위험", "javascript:alert(1)"),
            ),
        )
        assertEquals(
            listOf(WebSource("공식 자료", "https://example.com/source")),
            sources,
        )
        val trimmed = SideChatPolicy.trim(
            listOf(
                SideChatMessage("u", "user", "질문", 1, sources),
                SideChatMessage("a", "assistant", "답변", 2, sources),
            ),
        )
        assertTrue(trimmed[0].sources.isEmpty())
        assertEquals(sources, trimmed[1].sources)
    }

    @Test
    fun followUpSearchQueriesAreSanitizedBoundedAndAssistantOnly() {
        val queries = listOf(
            "\u0000 첫 번째 후속 검색 ",
            "첫 번째 후속 검색",
            "두 번째 후속 검색",
            "세 번째 후속 검색",
            "네 번째 후속 검색",
        )
        val trimmed = SideChatPolicy.trim(
            listOf(
                SideChatMessage(
                    id = "u",
                    role = "user",
                    content = "질문",
                    createdAt = 1,
                    followUpQueries = queries,
                ),
                SideChatMessage(
                    id = "a",
                    role = "assistant",
                    content = "검색 답변",
                    createdAt = 2,
                    sources = listOf(WebSource("공식 자료", "https://example.com/search")),
                    followUpQueries = queries,
                ),
            ),
        )

        assertTrue(trimmed[0].followUpQueries.isEmpty())
        assertEquals(
            listOf("첫 번째 후속 검색", "두 번째 후속 검색", "세 번째 후속 검색"),
            trimmed[1].followUpQueries,
        )
    }
}
