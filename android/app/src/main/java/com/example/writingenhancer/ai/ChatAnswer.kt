package com.example.writingenhancer.ai

import org.json.JSONArray
import org.json.JSONObject

/** 답변 글 안의 출처 위치. [sources]는 답변 출처 목록의 번호다. */
data class AnswerCitation(val start: Int, val end: Int, val sources: List<Int>)

/** 답변 글 안의 굵게·코드 서식 위치. */
data class AnswerStyle(val start: Int, val end: Int, val kind: String) {
    companion object {
        const val BOLD = "bold"
        const val CODE = "code"
        val KINDS = setOf(BOLD, CODE)
    }
}

/** 원래 답변 글 기준의 근거 범위와 출처 번호. */
data class AnswerAnnotation(val start: Int, val end: Int, val source: Int)

data class FormattedAnswer(
    val text: String,
    val citations: List<AnswerCitation>,
    val styles: List<AnswerStyle>,
)

data class ControlBlock(
    val answer: String,
    /** 답변 앞에서 잘라 낸 공백 수. 원래 글 기준 인용 위치를 답변 기준으로 옮길 때 쓴다. */
    val answerOffset: Int,
    val role: String,
    val action: SideChatAction,
    val relatedQueries: List<String>,
)

/**
 * 사이드 채팅 답변 처리. Windows의 desktop/src/renderer/chat-answer.js와 같은 규칙이며
 * shared/rules의 공통 사례(SharedSideChatCasesTest)로 함께 검사한다.
 *  - 스트리밍 중 보여 줄 글과 답변 끝 제어 블록 분리
 *  - 요청 분류(앱 조작·웹 조사·글 상담)
 *  - 출처 표시를 문장 링크로 바꾸고 굵게·코드 서식을 위치와 함께 정리
 * 위치는 모두 UTF-16 글자 단위라 JavaScript 문자열 위치와 같다.
 */
object ChatAnswer {
    const val FENCE = SharedSideChatRules.CONTROL_FENCE

    const val CATEGORY_COMMAND = "command"
    const val CATEGORY_RESEARCH = "research"
    const val CATEGORY_WRITING = "writing"

    // JavaScript 정규식의 \s와 같은 공백 집합.
    private const val WS =
        """\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"""

    private val TERMINATORS = setOf('.', '!', '?', '。', '！', '？', '…')
    private val MARKER = Regex(
        """\(?(?:\[[^\]\n]{1,180}\]\(https?://[^$WS)]+\)|https?://[^$WS]+|[\w.-]+\.[a-z]{2,})\)?""",
        RegexOption.IGNORE_CASE,
    )
    private val MARKDOWN_LINK = Regex(
        """\[([^\]\n]{1,180})\]\((https?://[^$WS)]+)(?:[$WS]+"[^"]*")?\)""",
    )
    private val BARE_URL = Regex("""https?://[^$WS<>()\[\]{}]+""")
    private val MARKUP = Regex(
        """```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*|^#{1,3} ([^\n]+)""",
        RegexOption.MULTILINE,
    )
    private val BULLET = Regex("""^(?:[-*•]|\d{1,2}[.)])[$WS]+""")
    private val HOST = Regex("""^https?://(?:[^/?#@]*@)?([^/?#:]+)""", RegexOption.IGNORE_CASE)

    private fun isSpace(char: Char): Boolean = when (char) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', '\u00A0', '\u1680',
        '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF',
        -> true
        else -> char in '\u2000'..'\u200A'
    }

    private fun trimStart(text: String): String = text.trimStart(::isSpace)

    private fun trimEnd(text: String): String = text.trimEnd(::isSpace)

    private fun trim(text: String): String = text.trim(::isSpace)

    private fun clean(value: String?): String = value.orEmpty().replace("\u0000", "")

    /** 스트리밍 중에는 제어 블록과, 제어 블록 시작이 잘려 들어온 꼬리를 보여 주지 않는다. */
    fun visibleStreamText(accumulated: String): String {
        val text = clean(accumulated)
        val fence = text.indexOf(FENCE)
        if (fence >= 0) return trimEnd(text.substring(0, fence))
        for (length in minOf(FENCE.length - 1, text.length) downTo 1) {
            if (text.endsWith(FENCE.substring(0, length))) return text.substring(0, text.length - length)
        }
        return text
    }

    private fun parseLooseJson(body: String): JSONObject? {
        runCatching { return JSONObject(trim(body)) }
        val start = body.indexOf('{')
        val end = body.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        return runCatching { JSONObject(body.substring(start, end + 1)) }.getOrNull()
    }

    private fun normalizeAction(value: JSONObject?): SideChatAction {
        val name = (value?.opt("name") as? String)?.takeIf { it in SharedSideChatRules.ACTION_NAMES }
        if (name == null || name == SideChatAction.NONE) return SideChatAction()
        val raw = value?.opt("value")
        val text = if (raw == null || raw == JSONObject.NULL) "" else raw.toString()
        return SideChatAction(name, clean(text).take(SharedSideChatRules.ACTION_VALUE_CHARACTERS))
    }

    private fun normalizeQueries(values: JSONArray?): List<String> {
        if (values == null) return emptyList()
        val queries = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        for (index in 0 until values.length()) {
            val value = values.opt(index) as? String ?: continue
            val query = trim(clean(value)).take(SharedSideChatRules.RELATED_QUERY_CHARACTERS)
            if (query.isEmpty() || !seen.add(query.lowercase())) continue
            queries += query
            if (queries.size >= SharedSideChatRules.RELATED_QUERIES) break
        }
        return queries
    }

    /** 답변 끝의 제어 블록에서 분류·동작·후속 질문을 읽는다. 블록이 없거나 깨져도 답변은 살린다. */
    fun parseControlBlock(full: String): ControlBlock {
        val text = clean(full)
        val fence = text.lastIndexOf(FENCE)
        val head = if (fence < 0) text else text.substring(0, fence)
        val trimmedStart = trimStart(head)
        val answer = trimEnd(trimmedStart)
        val answerOffset = head.length - trimmedStart.length
        if (fence < 0) return ControlBlock(answer, answerOffset, "", SideChatAction(), emptyList())
        var body = text.substring(fence + FENCE.length)
        val close = body.indexOf("```")
        if (close >= 0) body = body.substring(0, close)
        val control = parseLooseJson(body)
        val role = (control?.opt("role") as? String)?.takeIf { it in SharedSideChatRules.ROLES }.orEmpty()
        return ControlBlock(
            answer = answer,
            answerOffset = answerOffset,
            role = role,
            action = normalizeAction(control?.opt("action") as? JSONObject),
            relatedQueries = normalizeQueries(control?.opt("related_queries") as? JSONArray),
        )
    }

    fun finalCategory(parsedRole: String, actionName: String, hasSources: Boolean): String = when {
        actionName.isNotEmpty() && actionName != SideChatAction.NONE -> CATEGORY_COMMAND
        hasSources || parsedRole == CATEGORY_RESEARCH -> CATEGORY_RESEARCH
        else -> CATEGORY_WRITING
    }

    fun categoryLabel(category: String, hasSources: Boolean): String = when (category) {
        CATEGORY_COMMAND -> SharedSideChatRules.ROLE_COMMAND
        CATEGORY_RESEARCH -> if (hasSources) {
            SharedSideChatRules.ROLE_RESEARCH
        } else {
            SharedSideChatRules.ROLE_RESEARCH_WITHOUT_SOURCES
        }
        else -> SharedSideChatRules.ROLE_WRITING
    }

    /** 주소의 사이트 이름(소문자, www. 제외). 두 앱이 같은 결과를 내도록 URL 해석기 대신 직접 읽는다. */
    fun hostOf(url: String?): String {
        val match = HOST.find(trim(url.orEmpty())) ?: return ""
        return match.groupValues[1].lowercase().removePrefix("www.")
    }

    private fun hostLabel(url: String): String {
        val host = hostOf(url.trimEnd { it in ".,;:!?)" })
        return if (host.isEmpty()) "[출처]" else "[$host]"
    }

    private data class Edit(val start: Int, val end: Int, val replacement: String)

    private class Applied(val text: String, private val edits: List<Pair<Edit, IntRange>>) {
        // 원래 위치를 새 위치로 옮긴다. 지운 범위 안의 위치는 bias에 따라 그 범위의 앞이나 뒤로 붙인다.
        fun map(index: Int, atEnd: Boolean): Int {
            var delta = 0
            for ((edit, output) in edits) {
                if (edit.end <= index) {
                    delta += edit.replacement.length - (edit.end - edit.start)
                } else if (edit.start < index) {
                    return if (atEnd) output.last + 1 else output.first
                } else {
                    break
                }
            }
            return index + delta
        }
    }

    // 정렬되고 겹치지 않는 편집을 적용한다.
    private fun applyEdits(text: String, edits: List<Edit>): Applied {
        val output = StringBuilder()
        var cursor = 0
        val applied = mutableListOf<Pair<Edit, IntRange>>()
        for (edit in edits) {
            output.append(text, cursor, edit.start)
            val outStart = output.length
            output.append(edit.replacement)
            applied += edit to (outStart until output.length)
            cursor = edit.end
        }
        output.append(text, cursor, text.length)
        return Applied(output.toString(), applied)
    }

    private fun overlaps(start: Int, end: Int, ranges: List<Edit>): Boolean =
        ranges.any { start < it.end && it.start < end }

    /** 출처 표시 바로 앞의 문장 범위. 목록 기호와 앞뒤 공백은 링크에서 뺀다. */
    fun sentenceBefore(text: String, anchor: Int): IntRange? {
        var end = minOf(anchor, text.length)
        while (end > 0 && isSpace(text[end - 1])) end -= 1
        if (end == 0) return null
        var start = 0
        for (index in end - 2 downTo 0) {
            val char = text[index]
            if (char == '\n') {
                start = index + 1
                break
            }
            if (char in TERMINATORS && isSpace(text[index + 1])) {
                start = index + 1
                break
            }
        }
        while (start < end && isSpace(text[start])) start += 1
        BULLET.find(text.substring(start, end))?.let { start += it.value.length }
        return if (start < end) start until end else null
    }

    private fun trimRange(text: String, start: Int, end: Int): IntRange? {
        var from = start
        var to = end
        while (from < to && isSpace(text[from])) from += 1
        while (to > from && isSpace(text[to - 1])) to -= 1
        return if (from < to) from until to else null
    }

    private class CitationBuilder(var start: Int, var end: Int, val sources: MutableList<Int>)

    private fun addCitation(citations: MutableList<CitationBuilder>, range: IntRange?, source: Int) {
        if (range == null) return
        val end = range.last + 1
        val target = citations.firstOrNull { it.start == range.first && it.end == end }
            ?: CitationBuilder(range.first, end, mutableListOf()).also(citations::add)
        if (source !in target.sources) target.sources += source
    }

    private fun mergeCitations(citations: List<CitationBuilder>): List<AnswerCitation> {
        val merged = mutableListOf<CitationBuilder>()
        citations.sortedWith(compareBy({ it.start }, { it.end })).forEach { citation ->
            val previous = merged.lastOrNull()
            if (previous != null && citation.start < previous.end) {
                previous.end = maxOf(previous.end, citation.end)
                citation.sources.forEach { if (it !in previous.sources) previous.sources += it }
            } else {
                merged += CitationBuilder(citation.start, citation.end, citation.sources.toMutableList())
            }
        }
        return merged.map { AnswerCitation(it.start, it.end, it.sources.toList()) }
    }

    /**
     * 답변 글을 화면용으로 정리한다.
     * 링크 모양의 출처 표시는 지우고 바로 앞 문장에 출처를 연결하며, 일반 글 범위는 그대로 연결한다.
     * [cleanLinks]가 true면(검색·화면 답변) 남은 마크다운 링크는 제목만, 맨 URL은 [도메인]으로 줄인다.
     */
    fun formatAnswer(
        raw: String,
        annotations: List<AnswerAnnotation> = emptyList(),
        cleanLinks: Boolean = false,
    ): FormattedAnswer {
        val source = clean(raw)
        val valid = annotations.filter {
            it.source >= 0 && it.start >= 0 && it.end <= source.length && it.start < it.end
        }

        val markers = mutableListOf<AnswerAnnotation>()
        val spans = mutableListOf<AnswerAnnotation>()
        for (item in valid) {
            if (MARKER.matches(trim(source.substring(item.start, item.end)))) {
                var start = item.start
                var end = item.end
                if (source[start] != '(' && start > 0 && source[start - 1] == '(' &&
                    end < source.length && source[end] == ')'
                ) {
                    start -= 1
                    end += 1
                }
                if (start > 0 && source[start - 1] == ' ') start -= 1
                markers += AnswerAnnotation(start, end, item.source)
            } else {
                spans += item
            }
        }

        val removals = mutableListOf<Edit>()
        markers.sortedBy { it.start }.forEach { marker ->
            val previous = removals.lastOrNull()
            if (previous != null && marker.start <= previous.end) {
                removals[removals.lastIndex] = previous.copy(end = maxOf(previous.end, marker.end))
            } else {
                removals += Edit(marker.start, marker.end, "")
            }
        }
        val linkEdits = mutableListOf<Edit>()
        if (cleanLinks) {
            MARKDOWN_LINK.findAll(source).forEach { match ->
                val start = match.range.first
                val end = match.range.last + 1
                if (!overlaps(start, end, removals)) linkEdits += Edit(start, end, match.groupValues[1])
            }
            BARE_URL.findAll(source).forEach { match ->
                val start = match.range.first
                val end = match.range.last + 1
                if (!overlaps(start, end, removals) && !overlaps(start, end, linkEdits)) {
                    linkEdits += Edit(start, end, hostLabel(match.value))
                }
            }
        }
        val firstPass = applyEdits(source, (removals + linkEdits).sortedBy { it.start })

        val citations = mutableListOf<CitationBuilder>()
        for (marker in markers) {
            val anchor = firstPass.map(marker.start, atEnd = false)
            addCitation(citations, sentenceBefore(firstPass.text, anchor), marker.source)
        }
        for (span in spans) {
            addCitation(
                citations,
                trimRange(
                    firstPass.text,
                    firstPass.map(span.start, atEnd = false),
                    firstPass.map(span.end, atEnd = true),
                ),
                span.source,
            )
        }

        val styleEdits = mutableListOf<Edit>()
        val styleRanges = mutableListOf<AnswerStyle>()
        MARKUP.findAll(firstPass.text).forEach { match ->
            val group = (1..4).first { match.groups[it] != null }
            val content = match.groups[group]!!.range
            val contentStart = content.first
            val contentEnd = content.last + 1
            val matchEnd = match.range.last + 1
            styleEdits += Edit(match.range.first, contentStart, "")
            if (matchEnd > contentEnd) styleEdits += Edit(contentEnd, matchEnd, "")
            styleRanges += AnswerStyle(
                contentStart,
                contentEnd,
                if (group <= 2) AnswerStyle.CODE else AnswerStyle.BOLD,
            )
        }
        val secondPass = applyEdits(firstPass.text, styleEdits)
        // 지운 표시 때문에 앞뒤에 남은 공백을 덜어 내고 위치도 함께 옮긴다. 저장할 때 다시 잘라도 어긋나지 않는다.
        var lead = 0
        while (lead < secondPass.text.length && isSpace(secondPass.text[lead])) lead += 1
        var tail = secondPass.text.length
        while (tail > lead && isSpace(secondPass.text[tail - 1])) tail -= 1
        val text = secondPass.text.substring(lead, tail)
        fun place(start: Int, end: Int): Pair<Int, Int> =
            maxOf(0, secondPass.map(start, atEnd = false) - lead) to
                minOf(text.length, secondPass.map(end, atEnd = true) - lead)
        val styles = styleRanges.mapNotNull { range ->
            val (start, end) = place(range.start, range.end)
            if (start < end) AnswerStyle(start, end, range.kind) else null
        }
        val placed = citations.mapNotNull { citation ->
            val (start, end) = place(citation.start, citation.end)
            if (start < end) CitationBuilder(start, end, citation.sources) else null
        }
        return FormattedAnswer(text, mergeCitations(placed), styles)
    }
}
