package com.example.writingenhancer.ai

import org.json.JSONArray
import org.json.JSONObject

/** 화면에서 잘라 낸 이미지에서 읽은 글. 글자가 없으면 text·language가 빈 글이다. */
data class ImageTextResult(
    val text: String,
    val language: String,
    val languageName: String,
    val provider: String,
)

data class TranslationResult(val translatedText: String, val provider: String)

/**
 * 화면 글 읽기와 번역 요청을 만들고 답을 읽는 규칙. 지시문은 Windows와 같은
 * shared/rules/writing-rules.json(SharedWritingRules)을 쓴다.
 */
object ScreenTextPolicy {
    /** 모르는 언어 코드는 한국어로 옮긴다. */
    fun translationTarget(code: String?): SharedWritingRules.TranslationTarget {
        val wanted = code.orEmpty().trim().lowercase()
        return SharedWritingRules.TRANSLATION_TARGETS.firstOrNull { it.code == wanted }
            ?: SharedWritingRules.TRANSLATION_TARGETS.first { it.code == "ko" }
    }

    fun translationPrompt(input: String, targetCode: String, situation: String): String =
        SideChatPromptBuilder.fillTemplate(
            SharedWritingRules.TRANSLATION_USER_TEMPLATE,
            mapOf(
                "target" to translationTarget(targetCode).label,
                "situation" to situation.trim().ifEmpty { "없음" },
                "input" to input.trim(),
            ),
        )

    private fun stripFence(jsonText: String): String = jsonText
        .trim()
        .removePrefix("```json")
        .removePrefix("```")
        .removeSuffix("```")
        .trim()

    fun parseImageText(jsonText: String, provider: String): ImageTextResult {
        val root = JSONObject(stripFence(jsonText))
        val text = root.optString("text")
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .trim()
            .take(SharedWritingRules.IMAGE_TEXT_MAX_CHARACTERS)
        val language = if (text.isEmpty()) "" else root.optString("language").trim().lowercase().take(8)
        val languageName = if (text.isEmpty()) "" else root.optString("language_name").trim().take(20)
        return ImageTextResult(text, language, languageName, provider)
    }

    fun parseTranslation(jsonText: String, provider: String): TranslationResult {
        val translated = JSONObject(stripFence(jsonText)).optString("translated_text").trim()
        require(translated.isNotEmpty()) { "AI가 번역문을 반환하지 않았습니다." }
        return TranslationResult(translated, provider)
    }

    private fun stringProperty(description: String) =
        JSONObject().put("type", "string").put("description", description)

    fun imageTextSchema(): JSONObject = JSONObject()
        .put("type", "object")
        .put("additionalProperties", false)
        .put(
            "properties",
            JSONObject()
                .put("text", stringProperty("이미지에서 읽은 글. 없으면 빈 문자열"))
                .put("language", stringProperty("본문의 주 언어 ISO 639-1 코드"))
                .put("language_name", stringProperty("본문 언어의 한국어 이름")),
        )
        .put("required", JSONArray(listOf("text", "language", "language_name")))

    fun translationSchema(): JSONObject = JSONObject()
        .put("type", "object")
        .put("additionalProperties", false)
        .put("properties", JSONObject().put("translated_text", stringProperty("설명 없이 번역문만")))
        .put("required", JSONArray(listOf("translated_text")))
}
