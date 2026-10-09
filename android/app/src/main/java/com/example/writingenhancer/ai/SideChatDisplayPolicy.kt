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

    const val SOURCES_MISSING_NOTE =
        "웹 출처를 확인하지 못한 답변이에요. 중요한 내용은 직접 확인해 주세요."

    private const val PREVIEW_CHARACTERS = 600

    private val pendingActionLabels = mapOf(
        "replace_source" to "원문을 이 내용으로 바꾸기",
        "set_situation" to "상황 안내를 이 내용으로 바꾸기",
        "replace_result" to "이 내용을 새 결과 버전으로 추가",
        "set_follow_up_reply" to "후속 요구 입력란에 넣기",
        "enhance" to "지금 원문으로 완성하기",
        "reenhance" to "원문 기준으로 다시 강화하기",
        "copy_result" to "강화한 글 복사하기",
        "new_writing" to "현재 작업을 비우고 새 글 시작",
        "guess_intent" to "알아맞춰 봐 실행",
    )

    private val actionsWithText = setOf(
        "replace_source",
        "set_situation",
        "replace_result",
        "set_follow_up_reply",
    )

    /** 답변 대기 중 표시할 단계 문구. 3초가 지나면 경과 시간을 붙인다. */
    fun progressLabel(progress: SideChatProgress?, elapsedMillis: Long): String {
        val base = when {
            progress?.stage == SideChatProgress.Stage.FALLBACK -> "다른 AI로 다시 시도하는 중"
            progress?.searchRequired == true -> "웹에서 찾아보는 중"
            else -> "답변을 준비하는 중"
        }
        val seconds = elapsedMillis / 1_000
        return if (seconds >= 3) "$base · ${seconds}초" else base
    }

    fun pendingActionLabel(action: SideChatAction): String =
        if (action.name == "set_enhancement_level") {
            "강화 범위를 ${action.value.ifBlank { "?" }}단계로 바꾸기"
        } else {
            pendingActionLabels[action.name] ?: "글 강화기 동작 실행"
        }

    fun pendingActionPreview(action: SideChatAction): String? {
        val value = action.value.trim()
        if (action.name !in actionsWithText || value.isBlank()) return null
        return if (value.length > PREVIEW_CHARACTERS) {
            value.take(PREVIEW_CHARACTERS) + "…"
        } else {
            value
        }
    }

    private fun compactLink(raw: String): String {
        val normalized = raw.trimEnd('.', ',', ';', ':', '!', '?', ')')
        val host = runCatching { URI(normalized).host.orEmpty() }
            .getOrDefault("")
            .removePrefix("www.")
        return if (host.isBlank()) "[출처]" else "[$host]"
    }
}
