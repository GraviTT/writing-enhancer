package com.example.writingenhancer.data

import com.example.writingenhancer.ai.AttachmentRef
import com.example.writingenhancer.ai.EnhancementLevelPolicy
import java.io.File

data class DraftState(
    val situation: String = "",
    val rawInput: String = "",
    val answer: String = "",
    val question: String = "",
    val assumption: String = "",
    val questionFirstActive: Boolean = false,
    val historyId: String? = null,
    val selectedVersion: Int = 0,
    val attachments: List<AttachmentRef> = emptyList(),
    val enhancementLevel: Int = EnhancementLevelPolicy.DEFAULT,
) {
    fun shouldResumeQuestion(): Boolean = questionFirstActive && question.isNotBlank()
    fun shouldResumeResult(): Boolean = !questionFirstActive && !historyId.isNullOrBlank()
}

data class ResultVersion(
    val text: String,
    val question: String,
    val provider: String,
    val createdAt: Long,
    val assumption: String = "",
    val enhancementLevel: Int = EnhancementLevelPolicy.DEFAULT,
)

data class HistoryEntry(
    val id: String,
    val situation: String,
    val rawInput: String,
    val attachments: List<AttachmentRef>,
    val versions: List<ResultVersion>,
    val selectedVersion: Int,
    val createdAt: Long,
    val updatedAt: Long,
)

object WorkspacePolicy {
    const val MAX_HISTORY = 40
    const val MAX_VERSIONS = 12
    const val MAX_ATTACHMENTS = 5
    const val MAX_ATTACHMENT_BYTES = 8L * 1024L * 1024L
    // Base64 expands binary data by roughly 4/3. A 12MB local cap keeps the
    // serialized Gemini request plus prompt below its 20MB inline limit.
    const val MAX_TOTAL_ATTACHMENT_BYTES = 12L * 1024L * 1024L

    fun previousVersionIndex(current: Int, versionCount: Int): Int =
        if (versionCount <= 0) 0 else (current - 1).coerceAtLeast(0)

    fun nextVersionIndex(current: Int, versionCount: Int): Int =
        if (versionCount <= 0) 0 else (current + 1).coerceAtMost(versionCount - 1)

    fun isRequestGenerationCurrent(captured: Long, current: Long): Boolean =
        captured == current

    fun enhancementLevelForVersion(
        versions: List<ResultVersion>,
        index: Int,
        fallback: Int = EnhancementLevelPolicy.DEFAULT,
    ): Int = versions.getOrNull(index)
        ?.enhancementLevel
        ?.let(EnhancementLevelPolicy::normalize)
        ?: EnhancementLevelPolicy.normalize(fallback)

    fun resumedEnhancementLevel(
        draft: DraftState,
        selectedHistory: HistoryEntry?,
    ): Int = if (draft.shouldResumeResult() && selectedHistory != null) {
        enhancementLevelForVersion(
            versions = selectedHistory.versions,
            index = selectedHistory.selectedVersion,
            fallback = draft.enhancementLevel,
        )
    } else {
        EnhancementLevelPolicy.normalize(draft.enhancementLevel)
    }

    fun resultVersionForRequest(
        text: String,
        question: String,
        provider: String,
        createdAt: Long,
        assumption: String,
        capturedRequestLevel: Int,
    ): ResultVersion = ResultVersion(
        text = text,
        question = question,
        provider = provider,
        createdAt = createdAt,
        assumption = assumption,
        enhancementLevel = EnhancementLevelPolicy.captureRequestLevel(
            capturedRequestLevel,
        ),
    )

    fun canAttach(existing: List<AttachmentRef>, sizeBytes: Long): Boolean =
        sizeBytes in 1..MAX_ATTACHMENT_BYTES &&
            existing.size < MAX_ATTACHMENTS &&
            existing.sumOf { it.sizeBytes } + sizeBytes <= MAX_TOTAL_ATTACHMENT_BYTES

    fun trimVersions(versions: List<ResultVersion>): List<ResultVersion> =
        versions.takeLast(MAX_VERSIONS)

    fun unreferencedAttachmentPaths(
        candidates: Collection<String>,
        draft: DraftState,
        histories: Collection<HistoryEntry>,
    ): Set<String> {
        val referenced = buildSet {
            addAll(draft.attachments.map { it.path })
            histories.forEach { addAll(it.attachments.map { attachment -> attachment.path }) }
        }
        return candidates.filterTo(mutableSetOf()) { it !in referenced }
    }

    fun isInsideAttachmentRoot(root: File, candidate: File): Boolean {
        val rootPath = root.canonicalFile.toPath()
        val candidatePath = candidate.canonicalFile.toPath()
        return candidatePath != rootPath && candidatePath.startsWith(rootPath)
    }
}

object WorkspacePersistencePolicy {
    fun decodeEnhancementLevel(
        hasStoredValue: Boolean,
        isStoredNull: Boolean,
        storedValue: Int,
    ): Int = EnhancementLevelPolicy.fromPersisted(
        storedValue.takeIf { hasStoredValue && !isStoredNull },
    )

    fun encodeEnhancementLevel(value: Int): Int =
        EnhancementLevelPolicy.normalize(value)
}
