package com.example.writingenhancer.ai

import java.net.URI

/** Keeps searched answers readable while source URLs remain available as source buttons. */
object SideChatDisplayPolicy {
    private val markdownLink = Regex(
        """\[([^\]\n]{1,180})]\((https?://[^\s)]+)(?:\s+\"[^\"]*\")?\)""",
        RegexOption.IGNORE_CASE,
    )
    private val angleLink = Regex("""<https?://[^>\s]+>""", RegexOption.IGNORE_CASE)
    private val bareUrl = Regex("""https?://[^\s<>\[\]{}]+""", RegexOption.IGNORE_CASE)

    fun clean(reply: String, externallyGrounded: Boolean): String {
        var visible = reply.replace('\u0000', ' ').trim()
        if (!externallyGrounded) return visible
        visible = markdownLink.replace(visible) { match -> match.groupValues[1].trim() }
        visible = angleLink.replace(visible) { match -> compactLink(match.value.removeSurrounding("<", ">")) }
        visible = bareUrl.replace(visible) { match -> compactLink(match.value) }
        return visible
            .replace(Regex("""[ \t]+\n"""), "\n")
            .replace(Regex("""\n{3,}"""), "\n\n")
            .trim()
    }

    // 진행 표시·적용 카드 문구는 shared/rules에서 Windows와 함께 쓴다.
    const val SOURCES_MISSING_NOTE = SharedSideChatRules.SOURCES_MISSING_NOTE

    /** 답변 대기 중 표시할 단계 문구. 몇 초가 지나면 경과 시간을 붙인다. */
    fun progressLabel(progress: SideChatProgress?, elapsedMillis: Long): String {
        val label = when {
            progress?.stage == SideChatProgress.Stage.FALLBACK -> SharedSideChatRules.PROGRESS_FALLBACK
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

    private fun compactLink(raw: String): String {
        val normalized = raw.trimEnd('.', ',', ';', ':', '!', '?', ')')
        val host = runCatching { URI(normalized).host.orEmpty() }
            .getOrDefault("")
            .removePrefix("www.")
        return if (host.isBlank()) "[출처]" else "[$host]"
    }
}
