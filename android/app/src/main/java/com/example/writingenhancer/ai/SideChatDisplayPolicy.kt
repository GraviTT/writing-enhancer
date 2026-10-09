package com.example.writingenhancer.ai

/** 사이드 채팅 진행 표시·적용 카드 문구. 답변 서식과 출처 정리는 ChatAnswer가 맡는다. */
object SideChatDisplayPolicy {
    // 진행 표시·적용 카드 문구는 shared/rules에서 Windows와 함께 쓴다.
    const val SOURCES_MISSING_NOTE = SharedSideChatRules.SOURCES_MISSING_NOTE

    /** 답변 대기 중 표시할 단계 문구. 몇 초가 지나면 경과 시간을 붙인다. */
    fun progressLabel(progress: SideChatProgress?, elapsedMillis: Long): String {
        val label = when {
            progress?.stage == SideChatProgress.Stage.FALLBACK -> SharedSideChatRules.PROGRESS_FALLBACK
            progress?.stage == SideChatProgress.Stage.SEARCHING ||
                progress?.searchRequired == true -> SharedSideChatRules.PROGRESS_SEARCHING
            else -> SharedSideChatRules.PROGRESS_REQUESTING
        }
        val seconds = elapsedMillis.coerceAtLeast(0) / 1_000
        return if (seconds >= SharedSideChatRules.PROGRESS_ELAPSED_AFTER_SECONDS) {
            SideChatPromptBuilder.fillTemplate(
                SharedSideChatRules.PROGRESS_ELAPSED,
                mapOf("label" to label, "seconds" to seconds.toString()),
            )
        } else {
            label
        }
    }

    fun pendingActionLabel(action: SideChatAction): String =
        if (action.name == "set_enhancement_level") {
            SideChatPromptBuilder.fillTemplate(
                SharedSideChatRules.PENDING_ENHANCEMENT_LEVEL,
                mapOf("value" to action.value.ifEmpty { "?" }),
            )
        } else {
            SharedSideChatRules.PENDING_ACTION_LABELS[action.name] ?: SharedSideChatRules.PENDING_FALLBACK
        }

    fun pendingActionPreview(action: SideChatAction): String? {
        val value = action.value.trim()
        if (action.name !in SharedSideChatRules.TEXT_VALUE_ACTIONS || value.isEmpty()) return null
        val limit = SharedSideChatRules.PENDING_PREVIEW_CHARACTERS
        return if (value.length > limit) value.take(limit) + "…" else value
    }
}
