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

    private fun compactLink(raw: String): String {
        val normalized = raw.trimEnd('.', ',', ';', ':', '!', '?', ')')
        val host = runCatching { URI(normalized).host.orEmpty() }
            .getOrDefault("")
            .removePrefix("www.")
        return if (host.isBlank()) "[출처]" else "[$host]"
    }
}
