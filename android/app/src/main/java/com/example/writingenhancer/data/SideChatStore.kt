package com.example.writingenhancer.data

import com.example.writingenhancer.ai.SideChatMessage
import com.example.writingenhancer.ai.SearchFollowUpPolicy
import com.example.writingenhancer.ai.WebSource
import com.example.writingenhancer.ai.WebSourcePolicy
import com.example.writingenhancer.security.SecureStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

object SideChatPolicy {
    const val MAX_MESSAGES = 60
    const val MAX_USER_CHARACTERS = 6_000
    const val MAX_ASSISTANT_CHARACTERS = 12_000

    fun clean(role: String, content: String): String {
        val maximum = if (role == "assistant") {
            MAX_ASSISTANT_CHARACTERS
        } else {
            MAX_USER_CHARACTERS
        }
        return content.replace("\u0000", "").take(maximum).trim()
    }

    fun trim(messages: List<SideChatMessage>): List<SideChatMessage> =
        messages
            .filter { it.role == "user" || it.role == "assistant" }
            .mapNotNull { message ->
                val content = clean(message.role, message.content)
                content.takeIf(String::isNotBlank)?.let {
                    val sources = if (message.role == "assistant") {
                        WebSourcePolicy.normalize(message.sources)
                    } else {
                        emptyList()
                    }
                    message.copy(
                        content = it,
                        sources = sources,
                        untrustedExternalContext = message.role == "assistant" &&
                            (message.untrustedExternalContext || sources.isNotEmpty()),
                        followUpQueries = if (
                            message.role == "assistant" && sources.isNotEmpty()
                        ) {
                            SearchFollowUpPolicy.normalize(message.followUpQueries)
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
                            followUpQueries = stringList(item.optJSONArray("followUpQueries")),
                            untrustedExternalContext =
                                item.optBoolean("untrustedExternalContext", false) ||
                                    sources.isNotEmpty(),
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
        assistantSources: List<WebSource> = emptyList(),
        assistantFollowUpQueries: List<String> = emptyList(),
        assistantUntrustedExternalContext: Boolean = false,
    ): List<SideChatMessage> {
        val now = System.currentTimeMillis()
        val user = message("user", userContent, now)
        val assistant = message(
            "assistant",
            assistantContent,
            now + 1,
            assistantSources,
            assistantFollowUpQueries,
            assistantUntrustedExternalContext,
        )
        require(user.content.isNotBlank() && assistant.content.isNotBlank())
        return save(list() + user + assistant)
    }

    @Synchronized
    fun appendAssistant(
        assistantContent: String,
        assistantSources: List<WebSource> = emptyList(),
        assistantFollowUpQueries: List<String> = emptyList(),
        assistantUntrustedExternalContext: Boolean = false,
    ): List<SideChatMessage> {
        val assistant = message(
            "assistant",
            assistantContent,
            System.currentTimeMillis(),
            assistantSources,
            assistantFollowUpQueries,
            assistantUntrustedExternalContext,
        )
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
        sources: List<WebSource> = emptyList(),
        followUpQueries: List<String> = emptyList(),
        untrustedExternalContext: Boolean = false,
    ): SideChatMessage {
        val normalizedSources = if (role == "assistant") {
            WebSourcePolicy.normalize(sources)
        } else {
            emptyList()
        }
        return SideChatMessage(
            id = UUID.randomUUID().toString(),
            role = role,
            content = SideChatPolicy.clean(role, content),
            createdAt = now,
            sources = normalizedSources,
            untrustedExternalContext = role == "assistant" &&
                (untrustedExternalContext || normalizedSources.isNotEmpty()),
            followUpQueries = if (role == "assistant" && normalizedSources.isNotEmpty()) {
                SearchFollowUpPolicy.normalize(followUpQueries)
            } else {
                emptyList()
            },
        )
    }

    private fun sourceList(array: JSONArray?): List<WebSource> {
        if (array == null) return emptyList()
        val sources = buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                WebSourcePolicy.normalize(
                    item.optString("title"),
                    item.optString("url"),
                )?.let(::add)
            }
        }
        return WebSourcePolicy.normalize(sources)
    }

    private fun stringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return SearchFollowUpPolicy.normalize(
            buildList {
                for (index in 0 until array.length()) add(array.optString(index))
            },
        )
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
                        .put("url", source.url),
                )
            }
            val followUpQueries = JSONArray()
            message.followUpQueries.forEach(followUpQueries::put)
            array.put(
                JSONObject()
                    .put("id", message.id)
                    .put("role", message.role)
                    .put("content", message.content)
                    .put("createdAt", message.createdAt)
                    .put("sources", sources)
                    .put("followUpQueries", followUpQueries)
                    .put("untrustedExternalContext", message.untrustedExternalContext),
            )
        }
        secureStore.putString(SecureStore.SIDE_CHAT_MESSAGES, array.toString())
        return normalized
    }
}
