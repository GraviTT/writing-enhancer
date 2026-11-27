package com.example.writingenhancer.ai

import com.example.writingenhancer.security.SecureStore
import org.json.JSONObject
import java.io.IOException

/** Gemini may precede or split the actual answer with non-answer parts. */
internal fun geminiAnswerText(response: JSONObject): String {
    val parts = response.optJSONArray("candidates")?.optJSONObject(0)
        ?.optJSONObject("content")?.optJSONArray("parts")
    return buildString {
        if (parts != null) for (i in 0 until parts.length()) {
            val part = parts.optJSONObject(i) ?: continue
            if (!part.optBoolean("thought") && part.has("text")) append(part.getString("text"))
        }
    }.takeIf { it.isNotBlank() } ?: throw IOException("Gemini 응답에 글이 없습니다.")
}

enum class AiProvider(val id: String, val label: String, val keyName: String) {
    GPT("openai", "GPT", SecureStore.OPENAI_KEY),
    GEMINI("gemini", "Gemini", SecureStore.GEMINI_KEY);

    val models get() = ModelCatalog.models.getValue(id)
}

data class AiSelection(val provider: AiProvider, val model: String) {
    /** Resolve exactly one key and send exactly once. A rejected model never selects a substitute. */
    fun <T> call(
        readKey: (String) -> String?,
        openAi: (String, String) -> T,
        gemini: (String, String) -> T,
    ): T {
        require(provider.models.any { it.first == model }) { "설정에서 사용할 ${provider.label} 모델을 다시 선택해 주세요." }
        val key = readKey(provider.keyName)?.takeUnless { it.isBlank() } ?: throw MissingApiKeyException(provider.label)
        return when (provider) {
            AiProvider.GPT -> openAi(key, model)
            AiProvider.GEMINI -> gemini(key, model)
        }
    }
}
