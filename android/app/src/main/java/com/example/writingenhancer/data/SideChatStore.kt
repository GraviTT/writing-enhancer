package com.example.writingenhancer.data

import com.example.writingenhancer.ai.AnswerCitation
import com.example.writingenhancer.ai.AnswerStyle
import com.example.writingenhancer.ai.SearchFollowUpPolicy
import com.example.writingenhancer.ai.SharedSideChatRules
import com.example.writingenhancer.ai.SideChatMessage
import com.example.writingenhancer.ai.SideChatResult
import com.example.writingenhancer.ai.WebSource
import com.example.writingenhancer.ai.WebSourcePolicy
import com.example.writingenhancer.security.SecureStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** AI 답변과 함께 저장할 출처·후속 질문·문장 출처·서식·분류·검색 기록. */
data class SideChatReplyDetails(
    val sources: List<WebSource> = emptyList(),
    val followUpQueries: List<String> = emptyList(),
    val untrustedExternalContext: Boolean = false,
    val sourcesMissing: Boolean = false,
    val citations: List<AnswerCitation> = emptyList(),
    val styles: List<AnswerStyle> = emptyList(),
    val category: String = "",
    val searchQueries: List<String> = emptyList(),
) {
    companion object {
        fun from(result: SideChatResult): SideChatReplyDetails = SideChatReplyDetails(
            sources = result.sources,
            followUpQueries = result.followUpQueries,
            untrustedExternalContext = result.untrustedExternalContext,
            sourcesMissing = result.sourcesMissing,
            citations = result.citations,
            styles = result.styles,
            category = result.category,
            searchQueries = result.searchQueries,
        )
    }
}

object SideChatPolicy {
    const val MAX_MESSAGES = 60
    const val MAX_USER_CHARACTERS = 6_000
    const val MAX_ASSISTANT_CHARACTERS = 12_000
    const val MAX_SEARCH_QUERIES = 8
    private const val MAX_QUERY_CHARACTERS = 120

    fun clean(role: String, content: String): String {
        val maximum = if (role == "assistant") {
            MAX_ASSISTANT_CHARACTERS
        } else {
            MAX_USER_CHARACTERS
        }
        return content.replace("\u0000", "").take(maximum).trim()
    }

    // 답변 글 안의 위치만 남긴다. 범위를 벗어나거나 앞 범위와 겹치면 버린다.
    fun normalizeCitations(
        values: List<AnswerCitation>,
        length: Int,
        sourceCount: Int,
    ): List<AnswerCitation> {
        val kept = mutableListOf<AnswerCitation>()
        values
            .filter { it.start >= 0 && it.start < it.end && it.end <= length }
            .mapNotNull { citation ->
                val sources = citation.sources.filter { it in 0 until sourceCount }.distinct()
                if (sources.isEmpty()) null else citation.copy(sources = sources)
            }
            .sortedBy { it.start }
            .forEach { citation ->
                if (kept.isEmpty() || citation.start >= kept.last().end) kept += citation
            }
        return kept
    }

    fun normalizeStyles(values: List<AnswerStyle>, length: Int): List<AnswerStyle> =
        values
            .filter {
                it.start >= 0 && it.start < it.end && it.end <= length && it.kind in AnswerStyle.KINDS
            }
            .sortedBy { it.start }

    fun normalizeSearchQueries(values: List<String>): List<String> =
        values
            .map { it.replace("\u0000", "").take(MAX_QUERY_CHARACTERS).trim() }
            .filter(String::isNotEmpty)
            .distinct()
            .take(MAX_SEARCH_QUERIES)

    fun trim(messages: List<SideChatMessage>): List<SideChatMessage> =
        messages
            .filter { it.role == "user" || it.role == "assistant" }
            .mapNotNull { message ->
                val content = clean(message.role, message.content)
                content.takeIf(String::isNotBlank)?.let {
                    val assistant = message.role == "assistant"
                    val sources = if (assistant) WebSourcePolicy.normalize(message.sources) else emptyList()
                    message.copy(
                        content = it,
                        sources = sources,
                        untrustedExternalContext = assistant &&
                            (message.untrustedExternalContext || sources.isNotEmpty()),
                        sourcesMissing = assistant && message.sourcesMissing,
                        followUpQueries = if (assistant && sources.isNotEmpty()) {
                            SearchFollowUpPolicy.normalize(message.followUpQueries)
                        } else {
                            emptyList()
                        },
                        citations = if (assistant) {
                            normalizeCitations(message.citations, it.length, sources.size)
                        } else {
                            emptyList()
                        },
                        styles = if (assistant) normalizeStyles(message.styles, it.length) else emptyList(),
                        category = message.category.takeIf { assistant && it in SharedSideChatRules.ROLES }
                            .orEmpty(),
                        searchQueries = if (assistant) {
                            normalizeSearchQueries(message.searchQueries)
                        } else {
                            emptyList()
                        },
                    )
                }
            }
            .takeLast(MAX_MESSAGES)

    fun rewriteFromUser(
        messages: List<SideChatMessage>,
        messageId: String,
        content: String,
        now: Long,
    ): List<SideChatMessage>? {
        val index = messages.indexOfFirst { it.id == messageId && it.role == "user" }
        if (index < 0) return null
        val cleaned = clean("user", content)
        if (cleaned.isBlank()) return null
        return trim(
            messages.take(index) +
                messages[index].copy(content = cleaned, createdAt = now),
        )
    }
}

class SideChatStore(private val secureStore: SecureStore) {
    @Synchronized
    fun list(): List<SideChatMessage> {
        val raw = secureStore.getString(SecureStore.SIDE_CHAT_MESSAGES) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val sources = sourceList(item.optJSONArray("sources"))
                    add(
                        SideChatMessage(
                            id = item.optString("id").ifBlank { UUID.randomUUID().toString() },
                            role = item.optString("role"),
                            content = item.optString("content"),
                            createdAt = item.optLong("createdAt", System.currentTimeMillis()),
                            sources = sources,
                            followUpQueries = SearchFollowUpPolicy.normalize(
                                stringList(item.optJSONArray("followUpQueries")),
                            ),
                            untrustedExternalContext =
                                item.optBoolean("untrustedExternalContext", false) ||
                                    sources.isNotEmpty(),
                            sourcesMissing = item.optBoolean("sourcesMissing", false),
                            citations = citationList(item.optJSONArray("citations")),
                            styles = styleList(item.optJSONArray("styles")),
                            category = item.optString("category"),
                            searchQueries = stringList(item.optJSONArray("searchQueries")),
                        ),
                    )
                }
            }
        }.map(SideChatPolicy::trim).getOrDefault(emptyList())
    }

    @Synchronized
    fun appendExchange(
        userContent: String,
        assistantContent: String,
        details: SideChatReplyDetails = SideChatReplyDetails(),
    ): List<SideChatMessage> {
        val now = System.currentTimeMillis()
        val user = message("user", userContent, now)
        val assistant = message("assistant", assistantContent, now + 1, details)
        require(user.content.isNotBlank() && assistant.content.isNotBlank())
        return save(list() + user + assistant)
    }

    @Synchronized
    fun appendAssistant(
        assistantContent: String,
        details: SideChatReplyDetails = SideChatReplyDetails(),
    ): List<SideChatMessage> {
        val assistant = message("assistant", assistantContent, System.currentTimeMillis(), details)
        require(assistant.content.isNotBlank())
        return save(list() + assistant)
    }

    @Synchronized
    fun rewriteFromUser(messageId: String, content: String): List<SideChatMessage>? {
        val rewritten = SideChatPolicy.rewriteFromUser(
            messages = list(),
            messageId = messageId,
            content = content,
            now = System.currentTimeMillis(),
        ) ?: return null
        return save(rewritten)
    }

    @Synchronized
    fun clear() {
        secureStore.remove(SecureStore.SIDE_CHAT_MESSAGES)
    }

    private fun message(
        role: String,
        content: String,
        now: Long,
        details: SideChatReplyDetails = SideChatReplyDetails(),
    ): SideChatMessage = SideChatPolicy.trim(
        listOf(
            SideChatMessage(
                id = UUID.randomUUID().toString(),
                role = role,
                content = content,
                createdAt = now,
                sources = details.sources,
                followUpQueries = details.followUpQueries,
                untrustedExternalContext = details.untrustedExternalContext,
                sourcesMissing = details.sourcesMissing,
                citations = details.citations,
                styles = details.styles,
                category = details.category,
                searchQueries = details.searchQueries,
            ),
        ),
    ).firstOrNull() ?: SideChatMessage(UUID.randomUUID().toString(), role, "", now)

    private fun sourceList(array: JSONArray?): List<WebSource> {
        if (array == null) return emptyList()
        val sources = buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                WebSourcePolicy.normalize(
                    item.optString("title"),
                    item.optString("url"),
                )?.copy(
                    cited = item.optBoolean("cited", false),
                    query = item.optString("query"),
                )?.let(::add)
            }
        }
        return WebSourcePolicy.normalize(sources)
    }

    private fun stringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return buildList {
            for (index in 0 until array.length()) add(array.optString(index))
        }
    }

    private fun intList(array: JSONArray?): List<Int> {
        if (array == null) return emptyList()
        return buildList {
            for (index in 0 until array.length()) add(array.optInt(index, -1))
        }
    }

    private fun citationList(array: JSONArray?): List<AnswerCitation> {
        if (array == null) return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                add(
                    AnswerCitation(
                        start = item.optInt("start", -1),
                        end = item.optInt("end", -1),
                        sources = intList(item.optJSONArray("sources")),
                    ),
                )
            }
        }
    }

    private fun styleList(array: JSONArray?): List<AnswerStyle> {
        if (array == null) return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                add(AnswerStyle(item.optInt("start", -1), item.optInt("end", -1), item.optString("kind")))
            }
        }
    }

    private fun save(messages: List<SideChatMessage>): List<SideChatMessage> {
        val normalized = SideChatPolicy.trim(messages)
        if (normalized.isEmpty()) {
            secureStore.remove(SecureStore.SIDE_CHAT_MESSAGES)
            return emptyList()
        }
        val array = JSONArray()
        normalized.forEach { message ->
            val sources = JSONArray()
            message.sources.forEach { source ->
                sources.put(
                    JSONObject()
                        .put("title", source.title)
                        .put("url", source.url)
                        .put("cited", source.cited)
                        .put("query", source.query),
                )
            }
            val citations = JSONArray()
            message.citations.forEach { citation ->
                val indices = JSONArray()
                citation.sources.forEach(indices::put)
                citations.put(
                    JSONObject()
                        .put("start", citation.start)
                        .put("end", citation.end)
                        .put("sources", indices),
                )
            }
            val styles = JSONArray()
            message.styles.forEach { style ->
                styles.put(
                    JSONObject()
                        .put("start", style.start)
                        .put("end", style.end)
                        .put("kind", style.kind),
                )
            }
            array.put(
                JSONObject()
                    .put("id", message.id)
                    .put("role", message.role)
                    .put("content", message.content)
                    .put("createdAt", message.createdAt)
                    .put("sources", sources)
                    .put("followUpQueries", JSONArray(message.followUpQueries))
                    .put("untrustedExternalContext", message.untrustedExternalContext)
                    .put("sourcesMissing", message.sourcesMissing)
                    .put("citations", citations)
                    .put("styles", styles)
                    .put("category", message.category)
                    .put("searchQueries", JSONArray(message.searchQueries)),
            )
        }
        secureStore.putString(SecureStore.SIDE_CHAT_MESSAGES, array.toString())
        return normalized
    }
}
