package com.example.writingenhancer.ai

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * text/event-stream 본문을 줄 단위로 받아 data 줄을 모은다. 빈 줄에서 한 이벤트가 끝난다.
 * Windows의 readServerSentEvents와 같은 규칙이다.
 */
class ServerSentEventParser(private val onData: (String) -> Unit) {
    private val data = mutableListOf<String>()

    fun line(raw: String) {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) {
            flush()
        } else if (line.startsWith("data:")) {
            data += line.substring(5).removePrefix(" ")
        }
    }

    fun finish() = flush()

    private fun flush() {
        if (data.isEmpty()) return
        val text = data.joinToString("\n")
        data.clear()
        if (text.isEmpty() || text == "[DONE]") return
        onData(text)
    }
}

/** 스트리밍으로 받은 전체 답변 글과, 끝난 뒤 정리한 근거 위치·출처·검색 기록. */
data class StreamedAnswer(
    val fullText: String,
    /** [fullText] 기준 위치와 [sources] 번호. */
    val annotations: List<AnswerAnnotation>,
    val sources: List<WebSource>,
    val searchQueries: List<String>,
    val usedWebSearch: Boolean,
)

private fun JSONArray?.objects(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optJSONObject(it) }
}

private fun JSONArray?.strings(): List<String> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { opt(it) as? String }
}

private fun cleanQueries(values: List<String>): List<String> =
    values.filter { it.isNotBlank() }.map { it.trim() }

/**
 * OpenAI Responses 스트리밍 이벤트를 모은다. 글 조각은 도착할 때마다 [onDelta]로 넘기고,
 * 끝나면 response.completed의 인용 위치와 검색 기록으로 출처를 만든다.
 */
class OpenAiChatStream(
    private val onDelta: (String) -> Unit,
    private val onSearching: () -> Unit,
) {
    private val streamed = StringBuilder()
    private var completed: JSONObject? = null
    private var failure: String? = null
    private var searching = false

    fun accept(event: JSONObject) {
        val type = event.optString("type")
        val delta = event.opt("delta")
        when {
            type == "response.output_text.delta" && delta is String -> {
                streamed.append(delta)
                onDelta(streamed.toString())
            }
            type.startsWith("response.web_search_call.") -> if (!searching) {
                searching = true
                onSearching()
            }
            type == "response.completed" -> completed = event.optJSONObject("response")
            type == "response.failed" || type == "response.incomplete" || type == "error" -> {
                failure = event.optJSONObject("response")?.optJSONObject("error")?.optString("message")
                    ?.takeIf { it.isNotBlank() }
                    ?: event.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() }
                    ?: event.optString("message").takeIf { it.isNotBlank() }
                    ?: "AI 응답 중 문제가 생겼습니다."
            }
        }
    }

    fun finish(): StreamedAnswer {
        failure?.let { throw IOException(it) }
        val response = completed ?: throw IOException("AI 응답이 끝까지 오지 않았습니다.")
        val output = response.optJSONArray("output").objects()

        // 여러 글 조각이면 앞 조각 길이만큼 인용 위치를 민다.
        val text = StringBuilder()
        data class Cited(val start: Int, val end: Int, val url: String, val title: String)
        val cited = mutableListOf<Cited>()
        output.forEach { item ->
            item.optJSONArray("content").objects().forEach { part ->
                val partText = part.opt("text") as? String ?: return@forEach
                val offset = text.length
                text.append(partText)
                part.optJSONArray("annotations").objects().forEach { annotation ->
                    if (annotation.optString("type") != "url_citation") return@forEach
                    val citation = annotation.optJSONObject("url_citation") ?: annotation
                    cited += Cited(
                        start = offset + citation.optInt("start_index", -1),
                        end = offset + citation.optInt("end_index", -1),
                        url = citation.optString("url"),
                        title = citation.optString("title"),
                    )
                }
            }
        }
        if (text.isEmpty()) (response.opt("output_text") as? String)?.let(text::append)

        val queries = mutableListOf<String>()
        val searched = mutableListOf<WebSource>()
        var usedWebSearch = false
        output.filter { it.optString("type") == "web_search_call" }.forEach { item ->
            usedWebSearch = true
            val action = item.optJSONObject("action") ?: JSONObject()
            val itemQueries = cleanQueries(
                listOfNotNull(action.opt("query") as? String) + action.optJSONArray("queries").strings(),
            )
            itemQueries.forEach { if (it !in queries) queries += it }
            action.optJSONArray("sources").objects().forEach { source ->
                searched += WebSource(
                    title = source.optString("title"),
                    url = source.optString("url"),
                    query = itemQueries.firstOrNull().orEmpty(),
                )
            }
        }

        val sources = WebSourcePolicy.build(cited.map { WebSource(it.title, it.url) }, searched)
        val annotations = cited.mapNotNull { citation ->
            val source = WebSourcePolicy.indexOf(sources, citation.url)
            if (source >= 0) AnswerAnnotation(citation.start, citation.end, source) else null
        }
        return StreamedAnswer(
            fullText = text.ifEmpty { streamed }.toString(),
            annotations = annotations,
            sources = sources,
            searchQueries = queries,
            usedWebSearch = usedWebSearch,
        )
    }
}

/**
 * Gemini streamGenerateContent(SSE) 조각을 모은다. 근거 조각은 출처로, 근거 문장은 답변 글에서
 * 찾은 위치로 바꾼다. Gemini의 위치 값은 바이트 기준이라 글자로 다시 찾는다.
 */
class GeminiChatStream(
    private val onDelta: (String) -> Unit,
    private val onSearching: () -> Unit,
) {
    private val streamed = StringBuilder()
    private var grounding: JSONObject? = null
    private var failure: String? = null

    fun accept(chunk: JSONObject) {
        chunk.optJSONObject("error")?.let { error ->
            failure = error.optString("message").ifBlank { "AI 응답 중 문제가 생겼습니다." }
        }
        val candidate = chunk.optJSONArray("candidates")?.optJSONObject(0) ?: return
        val text = candidate.optJSONObject("content")?.optJSONArray("parts").objects()
            .filter { !it.optBoolean("thought", false) }
            .mapNotNull { it.opt("text") as? String }
            .joinToString("")
        if (text.isNotEmpty()) {
            streamed.append(text)
            onDelta(streamed.toString())
        }
        candidate.optJSONObject("groundingMetadata")?.let { metadata ->
            if (grounding == null) onSearching()
            grounding = metadata
        }
    }

    fun finish(): StreamedAnswer {
        failure?.let { throw IOException(it) }
        val text = streamed.toString()
        val metadata = grounding
        val chunks = metadata?.optJSONArray("groundingChunks")
        val chunkList = (0 until (chunks?.length() ?: 0)).map { chunks?.optJSONObject(it) }
        val supports = metadata?.optJSONArray("groundingSupports").objects()
        fun indices(support: JSONObject): List<Int> {
            val values = support.optJSONArray("groundingChunkIndices") ?: return emptyList()
            return (0 until values.length()).mapNotNull { (values.opt(it) as? Number)?.toInt() }
        }
        fun webOf(chunk: JSONObject?): WebSource {
            val web = chunk?.optJSONObject("web") ?: chunk
            return WebSource(
                title = web?.optString("title").orEmpty(),
                url = web?.optString("uri").orEmpty().ifEmpty { web?.optString("url").orEmpty() },
            )
        }
        val citedChunks = supports.flatMap(::indices).toSet()
        val ordered = chunkList.indices.sortedWith(
            compareBy<Int>({ if (it in citedChunks) 0 else 1 }, { it }),
        )
        val sources = WebSourcePolicy.build(
            cited = ordered.filter { it in citedChunks }.map { webOf(chunkList[it]) },
            searched = ordered.filter { it !in citedChunks }.map { webOf(chunkList[it]) },
        )
        val annotations = mutableListOf<AnswerAnnotation>()
        var cursor = 0
        supports.forEach { support ->
            val segment = support.optJSONObject("segment")?.optString("text").orEmpty()
            if (segment.isEmpty()) return@forEach
            var start = text.indexOf(segment, cursor)
            if (start < 0) start = text.indexOf(segment)
            if (start < 0) return@forEach
            cursor = start + segment.length
            indices(support).forEach { chunkIndex ->
                val source = WebSourcePolicy.indexOf(sources, webOf(chunkList.getOrNull(chunkIndex)).url)
                if (source >= 0) annotations += AnswerAnnotation(start, start + segment.length, source)
            }
        }
        val queries = cleanQueries(metadata?.optJSONArray("webSearchQueries").strings())
        val usedWebSearch = metadata != null && (
            chunkList.isNotEmpty() || queries.isNotEmpty() || metadata.has("searchEntryPoint")
            )
        return StreamedAnswer(text, annotations, sources, queries, usedWebSearch)
    }
}

/** 스트리밍으로 받은 답변을 화면용 답변·문장 출처·서식·분류·동작으로 정리한다. */
object SideChatComposer {
    fun compose(answer: StreamedAnswer, request: SideChatRequest, provider: String): SideChatResult {
        val parsed = ChatAnswer.parseControlBlock(answer.fullText)
        if (parsed.answer.isBlank()) throw IOException("AI가 채팅 답변을 반환하지 않았습니다.")
        val grounded = SideChatSearchPolicy.isExternallyGrounded(
            screenContext = request.screenContext,
            sources = answer.sources,
            searchUsed = answer.usedWebSearch,
            untrustedConversation = request.priorExternalContext,
        )
        val formatted = ChatAnswer.formatAnswer(
            parsed.answer,
            answer.annotations.map {
                it.copy(start = it.start - parsed.answerOffset, end = it.end - parsed.answerOffset)
            },
            cleanLinks = grounded,
        )
        return SideChatResult(
            reply = formatted.text,
            action = parsed.action,
            provider = provider,
            sources = answer.sources,
            followUpQueries = SideChatSearchPolicy.visibleFollowUps(
                actionName = parsed.action.name,
                sources = answer.sources,
                queries = parsed.relatedQueries,
            ),
            usedWebSearch = answer.usedWebSearch,
            untrustedExternalContext = grounded,
            actionRequiresConfirmation = SideChatSearchPolicy.requiresConfirmation(parsed.action, grounded),
            citations = formatted.citations,
            styles = formatted.styles,
            category = ChatAnswer.finalCategory(
                parsed.role,
                parsed.action.name,
                answer.sources.isNotEmpty(),
            ),
            searchQueries = answer.searchQueries,
        )
    }
}
