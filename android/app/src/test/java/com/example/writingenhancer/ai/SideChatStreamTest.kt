package com.example.writingenhancer.ai

import com.example.writingenhancer.data.SideChatPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** 사이드 채팅 스트리밍 응답(SSE)을 모아 답변·문장 출처·분류로 정리하는 과정을 확인한다. */
class SideChatStreamTest {
    private val context = SideChatWritingContext("input", "", "", "", "", "", 3, 0, 0, emptyList())

    private fun request(input: String = "질문", priorExternal: Boolean = false) =
        SideChatRequest(input, emptyList(), context, priorExternalContext = priorExternal)

    private fun control(role: String, action: String = "none", value: String = "", related: List<String> = emptyList()) =
        "\n\n```app-control\n" + JSONObject()
            .put("role", role)
            .put("action", JSONObject().put("name", action).put("value", value))
            .put("related_queries", JSONArray(related))
            .toString() + "\n```"

    private fun feed(lines: String, accept: (JSONObject) -> Unit) {
        val parser = ServerSentEventParser { data -> accept(JSONObject(data)) }
        lines.split("\n").forEach(parser::line)
        parser.finish()
    }

    @Test
    fun serverSentEventsJoinDataLinesAndSkipCommentsAndDone() {
        val events = mutableListOf<String>()
        val parser = ServerSentEventParser(events::add)
        listOf(": keep-alive", "data: {\"a\":", "data: 1}\r", "", "data: [DONE]", "", "data: {\"b\":2}")
            .forEach(parser::line)
        parser.finish()
        assertEquals(listOf("{\"a\":\n1}", "{\"b\":2}"), events)
    }

    @Test
    fun openAiStreamShowsDeltasAndLinksCitedSentence() {
        val deltas = mutableListOf<String>()
        var searching = 0
        val stream = OpenAiChatStream(onDelta = deltas::add, onSearching = { searching += 1 })
        val text = "회의 목표부터 확인하세요. ([example.com](https://example.com/meeting))" +
            control("research", related = listOf("체크리스트는?"))
        val marker = "[example.com](https://example.com/meeting)"
        val completed = JSONObject()
            .put("type", "response.completed")
            .put(
                "response",
                JSONObject().put(
                    "output",
                    JSONArray()
                        .put(
                            JSONObject()
                                .put("type", "web_search_call")
                                .put(
                                    "action",
                                    JSONObject()
                                        .put("query", "회의 준비 순서")
                                        .put(
                                            "sources",
                                            JSONArray()
                                                .put(JSONObject().put("title", "공식 안내").put("url", "https://example.com/meeting"))
                                                .put(JSONObject().put("title", "다른 자료").put("url", "https://example.org/other")),
                                        ),
                                ),
                        )
                        .put(
                            JSONObject()
                                .put("type", "message")
                                .put(
                                    "content",
                                    JSONArray().put(
                                        JSONObject()
                                            .put("type", "output_text")
                                            .put("text", text)
                                            .put(
                                                "annotations",
                                                JSONArray().put(
                                                    JSONObject()
                                                        .put("type", "url_citation")
                                                        .put("start_index", text.indexOf(marker))
                                                        .put("end_index", text.indexOf(marker) + marker.length)
                                                        .put("url", "https://example.com/meeting")
                                                        .put("title", "공식 안내"),
                                                ),
                                            ),
                                    ),
                                ),
                        ),
                ),
            )
        val half = text.length / 2
        stream.accept(JSONObject().put("type", "response.web_search_call.searching"))
        stream.accept(JSONObject().put("type", "response.output_text.delta").put("delta", text.substring(0, half)))
        stream.accept(JSONObject().put("type", "response.output_text.delta").put("delta", text.substring(half)))
        stream.accept(completed)

        assertEquals(1, searching)
        assertEquals(text, deltas.last())
        val result = SideChatComposer.compose(stream.finish(), request(), "GPT")
        assertEquals("회의 목표부터 확인하세요.", result.reply)
        assertEquals(listOf(AnswerCitation(0, result.reply.length, listOf(0))), result.citations)
        assertEquals(ChatAnswer.CATEGORY_RESEARCH, result.category)
        assertEquals(listOf("체크리스트는?"), result.followUpQueries)
        assertEquals(listOf("회의 준비 순서"), result.searchQueries)
        assertEquals(listOf(true, false), result.sources.map { it.cited })
        assertEquals("회의 준비 순서", result.sources.first().query)
        assertTrue(result.usedWebSearch)
        assertTrue(result.untrustedExternalContext)
    }

    @Test
    fun openAiStreamFailureAndIncompleteStreamAreErrors() {
        val failed = OpenAiChatStream({}, {})
        failed.accept(
            JSONObject()
                .put("type", "response.failed")
                .put("response", JSONObject().put("error", JSONObject().put("message", "server error"))),
        )
        assertEquals("server error", runCatching { failed.finish() }.exceptionOrNull()?.message)
        val unfinished = OpenAiChatStream({}, {})
        unfinished.accept(JSONObject().put("type", "response.output_text.delta").put("delta", "중간까지"))
        assertTrue(runCatching { unfinished.finish() }.exceptionOrNull() is IOException)
    }

    @Test
    fun geminiStreamFindsGroundedSentenceByText() {
        val deltas = mutableListOf<String>()
        var searching = 0
        val stream = GeminiChatStream(onDelta = deltas::add, onSearching = { searching += 1 })
        val answer = "회의는 2시간 단위로 예약해요. 외부 손님이 있으면 하루 전에 신청해요."
        val text = answer + control("research")
        val half = text.length / 2
        feed(
            "data: " + JSONObject().put(
                "candidates",
                JSONArray().put(
                    JSONObject().put(
                        "content",
                        JSONObject().put("parts", JSONArray().put(JSONObject().put("text", text.substring(0, half)))),
                    ),
                ),
            ) + "\n\n" +
                "data: " + JSONObject().put(
                    "candidates",
                    JSONArray().put(
                        JSONObject()
                            .put(
                                "content",
                                JSONObject().put(
                                    "parts",
                                    JSONArray()
                                        .put(JSONObject().put("text", "생각").put("thought", true))
                                        .put(JSONObject().put("text", text.substring(half))),
                                ),
                            )
                            .put(
                                "groundingMetadata",
                                JSONObject()
                                    .put("webSearchQueries", JSONArray().put("회의실 예약 규정"))
                                    .put(
                                        "groundingChunks",
                                        JSONArray()
                                            .put(JSONObject().put("web", JSONObject().put("title", "example.org").put("uri", "https://example.org/other")))
                                            .put(JSONObject().put("web", JSONObject().put("title", "example.com").put("uri", "https://example.com/rooms"))),
                                    )
                                    .put(
                                        "groundingSupports",
                                        JSONArray().put(
                                            JSONObject()
                                                .put("segment", JSONObject().put("text", "외부 손님이 있으면 하루 전에 신청해요."))
                                                .put("groundingChunkIndices", JSONArray().put(1)),
                                        ),
                                    ),
                            ),
                    ),
                ) + "\n\n",
            stream::accept,
        )

        assertEquals(1, searching)
        assertEquals(text, deltas.last())
        val result = SideChatComposer.compose(stream.finish(), request(), "Gemini")
        assertEquals(answer, result.reply)
        assertEquals(listOf("https://example.com/rooms", "https://example.org/other"), result.sources.map { it.url })
        val citation = result.citations.single()
        assertEquals("외부 손님이 있으면 하루 전에 신청해요.", result.reply.substring(citation.start, citation.end))
        assertEquals(listOf(0), citation.sources)
        assertEquals(listOf("회의실 예약 규정"), result.searchQueries)
    }

    @Test
    fun groundedConversationKeepsActionButRequiresConfirmation() {
        val stream = OpenAiChatStream({}, {})
        val text = "원문에 반영할게요." + control("writing", "replace_source", "외부 답변 내용")
        stream.accept(JSONObject().put("type", "response.output_text.delta").put("delta", text))
        stream.accept(
            JSONObject()
                .put("type", "response.completed")
                .put(
                    "response",
                    JSONObject().put(
                        "output",
                        JSONArray().put(
                            JSONObject()
                                .put("type", "message")
                                .put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", text))),
                        ),
                    ),
                ),
        )
        val grounded = SideChatComposer.compose(stream.finish(), request(priorExternal = true), "GPT")
        assertEquals(SideChatAction("replace_source", "외부 답변 내용"), grounded.action)
        assertEquals(ChatAnswer.CATEGORY_COMMAND, grounded.category)
        assertTrue(grounded.actionRequiresConfirmation)
        assertTrue(grounded.followUpQueries.isEmpty())

        val local = SideChatComposer.compose(
            StreamedAnswer(text, emptyList(), emptyList(), emptyList(), usedWebSearch = false),
            request(),
            "GPT",
        )
        assertFalse(local.actionRequiresConfirmation)
    }

    @Test
    fun emptyAnswerIsAnError() {
        val failure = runCatching {
            SideChatComposer.compose(
                StreamedAnswer(control("writing"), emptyList(), emptyList(), emptyList(), false),
                request(),
                "GPT",
            )
        }.exceptionOrNull()
        assertTrue(failure is IOException)
    }

    @Test
    fun chatGeminiRequestsSendNoStructuredOutputConfig() {
        assertEquals(
            setOf("system_instruction", "contents", "tools"),
            GeminiRequestContract.topLevelFields(searchEnabled = true, structuredOutput = false),
        )
        assertEquals(
            setOf("system_instruction", "contents"),
            GeminiRequestContract.topLevelFields(searchEnabled = false, structuredOutput = false),
        )
    }

    @Test
    fun storedCitationsAndStylesStayInsideTheAnswer() {
        val message = SideChatMessage(
            id = "a",
            role = "assistant",
            content = "  첫 문장. 둘째 문장.  ",
            createdAt = 1,
            sources = listOf(WebSource("자료", "https://example.com/a", cited = true, query = "검색어")),
            citations = listOf(
                AnswerCitation(0, 5, listOf(0, 0, 3)),
                AnswerCitation(3, 9, listOf(0)),
                AnswerCitation(6, 40, listOf(0)),
            ),
            styles = listOf(AnswerStyle(0, 2, AnswerStyle.BOLD), AnswerStyle(0, 2, "italic")),
            category = "research",
            searchQueries = listOf(" 검색어 ", "검색어", ""),
        )
        val stored = SideChatPolicy.trim(listOf(message)).single()
        assertEquals("첫 문장. 둘째 문장.", stored.content)
        assertEquals(listOf(AnswerCitation(0, 5, listOf(0))), stored.citations)
        assertEquals(listOf(AnswerStyle(0, 2, AnswerStyle.BOLD)), stored.styles)
        assertEquals("research", stored.category)
        assertEquals(listOf("검색어"), stored.searchQueries)
        assertTrue(stored.sources.single().cited)
        assertEquals("검색어", stored.sources.single().query)

        val user = SideChatPolicy.trim(listOf(message.copy(role = "user"))).single()
        assertTrue(user.citations.isEmpty() && user.category.isEmpty() && user.searchQueries.isEmpty())
    }
}
