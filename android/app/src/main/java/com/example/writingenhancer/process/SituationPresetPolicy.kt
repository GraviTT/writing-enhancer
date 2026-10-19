package com.example.writingenhancer.process

import com.example.writingenhancer.ai.SharedWritingRules
import org.json.JSONArray
import org.json.JSONObject

/**
 * 선택한 글 강화 창의 상황 버튼 목록. 사용자가 버튼을 저장·삭제할 수 있고,
 * 고친 적이 없으면 shared/rules/writing-rules.json의 기본 목록을 쓴다.
 * Windows는 desktop/src/renderer/situation-presets.js에 같은 규칙이 있다.
 */
object SituationPresetPolicy {
    data class Preset(val label: String, val text: String)

    /** reason: "" | "empty" | "duplicate" | "full" */
    data class AddResult(val list: List<Preset>, val added: Boolean, val reason: String)

    private val whitespace = Regex("""\s+""")

    fun clean(value: String?, maximum: Int): String {
        val text = value.orEmpty().replace(whitespace, " ").trim()
        return takeCodePoints(text, maximum).trim()
    }

    fun defaults(): List<Preset> = SharedWritingRules.SITUATIONS.map { Preset(it.label, it.text) }

    /** 버튼 이름. 설명이 길면 앞부분만 쓰고 말줄임표를 붙인다. */
    fun labelFor(text: String): String {
        val value = clean(text, SharedWritingRules.MAX_SITUATION_TEXT)
        val maximum = SharedWritingRules.MAX_SITUATION_LABEL
        if (value.codePointCount(0, value.length) <= maximum) return value
        return takeCodePoints(value, maximum - 1).trim() + "…"
    }

    /** 저장된 목록을 정리한다. null이면(고친 적 없음) 기본 목록을 돌려준다. */
    fun normalize(list: List<Preset>?): List<Preset> {
        if (list == null) return defaults()
        val seen = mutableSetOf<String>()
        val result = mutableListOf<Preset>()
        for (item in list) {
            val text = clean(item.text, SharedWritingRules.MAX_SITUATION_TEXT)
            if (text.isEmpty() || !seen.add(text)) continue
            val label = clean(item.label, SharedWritingRules.MAX_SITUATION_LABEL).ifEmpty { labelFor(text) }
            result += Preset(label, text)
            if (result.size >= SharedWritingRules.MAX_SITUATIONS) break
        }
        return result
    }

    fun add(list: List<Preset>?, text: String): AddResult {
        val current = normalize(list)
        val value = clean(text, SharedWritingRules.MAX_SITUATION_TEXT)
        return when {
            value.isEmpty() -> AddResult(current, false, "empty")
            current.any { it.text == value } -> AddResult(current, false, "duplicate")
            current.size >= SharedWritingRules.MAX_SITUATIONS -> AddResult(current, false, "full")
            else -> AddResult(current + Preset(labelFor(value), value), true, "")
        }
    }

    fun remove(list: List<Preset>?, text: String): List<Preset> = normalize(list).filter { it.text != text }

    fun encode(list: List<Preset>): String = JSONArray().apply {
        for (item in list) put(JSONObject().put("label", item.label).put("text", item.text))
    }.toString()

    /** 저장된 글을 읽는다. 없거나 깨졌으면 null(기본 목록 사용). */
    fun decode(json: String?): List<Preset>? {
        if (json.isNullOrBlank()) return null
        return runCatching {
            val array = JSONArray(json)
            List(array.length()) { index ->
                val item = array.optJSONObject(index)
                Preset(item?.optString("label").orEmpty(), item?.optString("text").orEmpty())
            }
        }.getOrNull()?.let { normalize(it) }
    }

    private fun takeCodePoints(text: String, maximum: Int): String {
        if (text.codePointCount(0, text.length) <= maximum) return text
        return text.substring(0, text.offsetByCodePoints(0, maximum))
    }
}
