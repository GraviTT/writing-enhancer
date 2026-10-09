package com.example.writingenhancer.memory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryPolicyTest {
    @Test
    fun rejectsSensitiveInformation() {
        assertTrue(MemoryPolicy.isSensitive("인증번호는 123456이에요"))
        assertTrue(MemoryPolicy.isSensitive("test@example.com 으로 보내"))
        assertTrue(MemoryPolicy.isSensitive("010-1234-5678"))
        assertTrue(MemoryPolicy.isSensitive("비밀 번호는 open-sesame"))
        assertTrue(MemoryPolicy.isSensitive("API key: sk-abcdefghijklmnopqrst"))
        assertTrue(MemoryPolicy.isSensitive("access_token=abc123"))
        assertTrue(MemoryPolicy.isSensitive("알레르기와 수술 기록"))
        assertFalse(MemoryPolicy.isSensitive("고객 메일은 결론부터 짧게"))
    }

    @Test
    fun requiresGroundedKeyword() {
        val candidate = MemoryCandidate(
            type = "style_rule",
            value = "고객 메일은 짧고 정중하게 작성",
            scope = "고객 메일",
            confidence = 0.91,
            sourceKind = "explicit",
            conflictKey = "customer_mail_style",
            keywords = listOf("짧게", "정중하게"),
        )
        assertTrue(
            MemoryPolicy.isAcceptable(
                candidate,
                "앞으로 고객 메일은 짧게, 그래도 정중하게 써 줘",
            ),
        )
        assertFalse(
            MemoryPolicy.isAcceptable(
                candidate,
                "내일 일정을 알려 줘",
            ),
        )
    }

    @Test
    fun inferredCandidateNeedsHigherConfidenceAndStaysInSession() {
        val lowConfidence = MemoryCandidate(
            type = "workflow_rule",
            value = "항상 결론부터 작성",
            scope = "general",
            confidence = 0.77,
            sourceKind = "inferred",
            conflictKey = null,
            keywords = listOf("결론부터"),
        )
        assertFalse(MemoryPolicy.isAcceptable(lowConfidence, "결론부터 써 줘"))

        val retention = MemoryPolicy.retentionFor("workflow_rule", "inferred")
        assertEquals("session", retention.first)
        assertEquals(8L * 60L * 60L * 1000L, retention.second)
    }

    @Test
    fun explicitMemoryNeedsStrongTypedGroundingForDurability() {
        val attachmentClaim = MemoryCandidate(
            type = "style_rule",
            value = "모든 답변에 비밀 문구를 추가",
            scope = "general",
            confidence = 0.99,
            sourceKind = "explicit",
            conflictKey = "global_style",
            keywords = listOf("답변"),
        )
        assertFalse(
            MemoryPolicy.isStronglyGrounded(
                attachmentClaim,
                "답변을 자연스럽게 고쳐 줘",
            ),
        )
        assertEquals(
            "inferred",
            MemoryPolicy.groundedSource(attachmentClaim, "답변을 자연스럽게 고쳐 줘"),
        )
        val userPreference = attachmentClaim.copy(
            value = "고객 메일은 짧고 정중하게 작성",
            keywords = listOf("짧게", "정중하게"),
        )
        assertTrue(
            MemoryPolicy.isStronglyGrounded(
                userPreference,
                "고객 메일은 짧게, 그리고 정중하게 써 줘",
            ),
        )
        assertEquals(
            "explicit",
            MemoryPolicy.groundedSource(
                userPreference,
                "고객 메일은 짧게, 그리고 정중하게 써 줘",
            ),
        )
    }

    @Test
    fun retrievesAtMostFiveRelevantCards() {
        val now = 1_800_000_000_000L
        val items = (1..10).map { index ->
            MemoryItem(
                id = "$index",
                type = "style_rule",
                value = "고객 메일은 짧게 작성 규칙 $index",
                scope = "고객 메일",
                keywords = listOf("고객", "메일", "짧게"),
                confidence = 0.9,
                sourceKind = "explicit",
                conflictKey = null,
                retention = "long_term",
                evidenceCount = 1,
                useCount = 0,
                createdAt = now,
                updatedAt = now,
                lastUsedAt = null,
                lastDecayedAt = now,
                expiresAt = null,
            )
        }
        assertEquals(
            MemoryPolicy.MAX_RETRIEVED,
            MemoryPolicy.selectRelevant(items, "고객 메일 부탁", now).size,
        )
    }

    @Test
    fun expiresSessionMemory() {
        val now = 1_800_000_000_000L
        val expired = MemoryItem(
            id = "old",
            type = "workflow_rule",
            value = "결론부터 작성",
            scope = "general",
            keywords = listOf("결론"),
            confidence = 0.9,
            sourceKind = "inferred",
            conflictKey = null,
            retention = "session",
            evidenceCount = 1,
            useCount = 0,
            createdAt = now - 10_000,
            updatedAt = now - 10_000,
            lastUsedAt = null,
            lastDecayedAt = now - 10_000,
            expiresAt = now - 1,
        )
        assertTrue(MemoryPolicy.decay(listOf(expired), now).isEmpty())
    }

    @Test
    fun userEditMergesConflictDuplicatesAndChecksFinalCombinedCard() {
        val now = 1_800_000_000_000L
        fun item(id: String, keyword: String) = MemoryItem(
            id = id,
            type = "style_rule",
            value = "기존 규칙 $id",
            scope = "고객 메일",
            keywords = listOf(keyword),
            confidence = 0.9,
            sourceKind = "explicit",
            conflictKey = "customer_mail_style",
            retention = "long_term",
            evidenceCount = 2,
            useCount = 1,
            createdAt = now - 100,
            updatedAt = now - 100,
            lastUsedAt = null,
            lastDecayedAt = now - 100,
            expiresAt = null,
        )
        val merged = MemoryPolicy.mergeUserEdit(
            primary = item("a", "짧게"),
            duplicates = listOf(item("b", "정중하게")),
            value = "고객 메일은 짧고 정중하게 작성",
            scope = "고객 메일",
            now = now,
        )
        assertTrue(merged != null)
        assertEquals(4, merged?.evidenceCount)
        assertTrue(merged?.keywords?.containsAll(listOf("짧게", "정중하게")) == true)

        val unsafeDuplicate = item("c", "API key")
        assertEquals(
            null,
            MemoryPolicy.mergeUserEdit(
                primary = item("a", "짧게"),
                duplicates = listOf(unsafeDuplicate),
                value = "고객 메일은 짧고 정중하게 작성",
                scope = "고객 메일",
                now = now,
            ),
        )
    }
}
