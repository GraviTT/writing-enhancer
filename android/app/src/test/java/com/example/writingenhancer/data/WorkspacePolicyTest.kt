package com.example.writingenhancer.data

import com.example.writingenhancer.ai.AttachmentRef
import com.example.writingenhancer.ai.EnhancementLevelPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class WorkspacePolicyTest {
    @Test
    fun previousVersionNeverMovesBeforeFirst() {
        assertEquals(0, WorkspacePolicy.previousVersionIndex(0, 3))
        assertEquals(1, WorkspacePolicy.previousVersionIndex(2, 3))
        assertEquals(0, WorkspacePolicy.previousVersionIndex(0, 0))
        assertEquals(1, WorkspacePolicy.nextVersionIndex(0, 3))
        assertEquals(2, WorkspacePolicy.nextVersionIndex(2, 3))
        assertEquals(0, WorkspacePolicy.nextVersionIndex(0, 0))
        assertTrue(WorkspacePolicy.isRequestGenerationCurrent(7, 7))
        assertFalse(WorkspacePolicy.isRequestGenerationCurrent(7, 8))
    }

    @Test
    fun versionHistoryIsBoundedAndKeepsNewestResults() {
        val versions = (0 until WorkspacePolicy.MAX_VERSIONS + 4).map {
            ResultVersion("result-$it", "question", "test", it.toLong())
        }
        val trimmed = WorkspacePolicy.trimVersions(versions)
        assertEquals(WorkspacePolicy.MAX_VERSIONS, trimmed.size)
        assertEquals("result-4", trimmed.first().text)
        assertEquals("result-15", trimmed.last().text)
    }

    @Test
    fun enhancementLevelDefaultsClampsAndRoundTripsAcrossVersions() {
        assertEquals(
            EnhancementLevelPolicy.DEFAULT,
            WorkspacePersistencePolicy.decodeEnhancementLevel(
                hasStoredValue = false,
                isStoredNull = false,
                storedValue = 99,
            ),
        )
        assertEquals(
            EnhancementLevelPolicy.DEFAULT,
            WorkspacePersistencePolicy.decodeEnhancementLevel(
                hasStoredValue = true,
                isStoredNull = true,
                storedValue = 0,
            ),
        )
        assertEquals(
            EnhancementLevelPolicy.MIN,
            WorkspacePersistencePolicy.decodeEnhancementLevel(true, false, -4),
        )
        assertEquals(
            EnhancementLevelPolicy.MAX,
            WorkspacePersistencePolicy.decodeEnhancementLevel(true, false, 99),
        )
        assertEquals(
            EnhancementLevelPolicy.MAX,
            WorkspacePersistencePolicy.encodeEnhancementLevel(99),
        )

        val versions = listOf(
            ResultVersion("교정", "", "test", 1, enhancementLevel = 1),
            ResultVersion("기본", "", "test", 2),
            ResultVersion("적극", "", "test", 3, enhancementLevel = 5),
        )
        var selected = 0
        assertEquals(1, WorkspacePolicy.enhancementLevelForVersion(versions, selected))
        selected = WorkspacePolicy.nextVersionIndex(selected, versions.size)
        selected = WorkspacePolicy.nextVersionIndex(selected, versions.size)
        assertEquals(5, WorkspacePolicy.enhancementLevelForVersion(versions, selected))
        selected = WorkspacePolicy.previousVersionIndex(selected, versions.size)
        selected = WorkspacePolicy.previousVersionIndex(selected, versions.size)
        assertEquals(1, WorkspacePolicy.enhancementLevelForVersion(versions, selected))
        assertEquals(
            EnhancementLevelPolicy.DEFAULT,
            WorkspacePolicy.enhancementLevelForVersion(emptyList(), 0),
        )
        val selectedHistory = HistoryEntry(
            id = "history",
            situation = "",
            rawInput = "",
            attachments = emptyList(),
            versions = versions,
            selectedVersion = 0,
            createdAt = 1,
            updatedAt = 1,
        )
        assertEquals(
            1,
            WorkspacePolicy.resumedEnhancementLevel(
                draft = DraftState(
                    historyId = "history",
                    enhancementLevel = 5,
                ),
                selectedHistory = selectedHistory,
            ),
        )

        var liveSliderLevel = 2
        val capturedRequestLevel =
            EnhancementLevelPolicy.captureRequestLevel(liveSliderLevel)
        liveSliderLevel = 5
        val storedResult = WorkspacePolicy.resultVersionForRequest(
            text = "결과",
            question = "질문",
            provider = "test",
            createdAt = 2,
            assumption = "",
            capturedRequestLevel = capturedRequestLevel,
        )
        assertEquals(2, storedResult.enhancementLevel)
        assertEquals(5, liveSliderLevel)
    }

    @Test
    fun attachmentBudgetChecksCountIndividualAndTotalSize() {
        val oneMegabyte = 1024L * 1024L
        val existing = (1..3).map {
            AttachmentRef("/$it", "$it.png", "image/png", 3L * oneMegabyte)
        }
        assertTrue(WorkspacePolicy.canAttach(existing, oneMegabyte))
        assertFalse(WorkspacePolicy.canAttach(existing, 5L * oneMegabyte))
        assertFalse(
            WorkspacePolicy.canAttach(
                existing +
                    AttachmentRef("/4", "4.png", "image/png", oneMegabyte) +
                    AttachmentRef("/5", "5.png", "image/png", oneMegabyte),
                oneMegabyte,
            ),
        )
        assertFalse(WorkspacePolicy.canAttach(emptyList(), 9L * oneMegabyte))
        assertEquals(12L * oneMegabyte, WorkspacePolicy.MAX_TOTAL_ATTACHMENT_BYTES)
    }

    @Test
    fun pendingGuessRestoresOnlyWithQuestionAndActiveFlag() {
        assertTrue(
            DraftState(
                rawInput = "재료",
                answer = "친구",
                question = "누구에게 보내나요?",
                assumption = "메시지 작성",
                questionFirstActive = true,
            ).shouldResumeQuestion(),
        )
        assertFalse(DraftState(question = "질문", questionFirstActive = false).shouldResumeQuestion())
        assertFalse(DraftState(questionFirstActive = true).shouldResumeQuestion())
        assertTrue(DraftState(historyId = "history-1", selectedVersion = 2).shouldResumeResult())
        assertFalse(
            DraftState(
                question = "진행 중 질문",
                questionFirstActive = true,
                historyId = "history-1",
            ).shouldResumeResult(),
        )
    }

    @Test
    fun attachmentCleanupProtectsDraftHistoryAndRootBoundary() {
        val draftAttachment = AttachmentRef("/private/draft.png", "draft.png", "image/png", 10)
        val historyAttachment = AttachmentRef("/private/history.pdf", "history.pdf", "application/pdf", 10)
        val draft = DraftState(attachments = listOf(draftAttachment))
        val history = HistoryEntry(
            id = "h",
            situation = "",
            rawInput = "",
            attachments = listOf(historyAttachment),
            versions = listOf(ResultVersion("result", "question", "test", 1)),
            selectedVersion = 0,
            createdAt = 1,
            updatedAt = 1,
        )
        assertEquals(
            setOf("/private/orphan.png"),
            WorkspacePolicy.unreferencedAttachmentPaths(
                setOf(draftAttachment.path, historyAttachment.path, "/private/orphan.png"),
                draft,
                listOf(history),
            ),
        )
        val root = File("build/private-attachments")
        assertTrue(
            WorkspacePolicy.isInsideAttachmentRoot(root, File(root, "safe.png")),
        )
        assertFalse(
            WorkspacePolicy.isInsideAttachmentRoot(root, File(root, "../escape.png")),
        )
    }
}
