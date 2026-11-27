package com.example.writingenhancer.preferences

import android.content.Context
import com.example.writingenhancer.ai.AiProvider
import com.example.writingenhancer.ai.AiSelection
import com.example.writingenhancer.security.SecureStore

class AppPreferences(context: Context) {
    private val preferences = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun modelFor(provider: AiProvider): String =
        preferences.getString("ai_model_${provider.id}", null) ?: provider.models.first().first

    fun selectProvider(provider: AiProvider) {
        preferences.edit().putString(KEY_PROVIDER, provider.id)
            .putString("ai_model_${provider.id}", modelFor(provider)).apply()
    }

    fun selectModel(provider: AiProvider, model: String) {
        require(provider.models.any { it.first == model })
        preferences.edit().putString(KEY_PROVIDER, provider.id)
            .putString("ai_model_${provider.id}", model).apply()
    }

    /** Only the initial migration considers existing keys; later key edits never change the choice. */
    fun aiSelection(store: SecureStore): AiSelection? {
        val saved = preferences.getString(KEY_PROVIDER, null)
        if (saved != null) {
            val provider = AiProvider.values().firstOrNull { it.id == saved } ?: return null
            return AiSelection(provider, modelFor(provider))
        }
        val provider = if (!store.contains(SecureStore.OPENAI_KEY) && store.contains(SecureStore.GEMINI_KEY))
            AiProvider.GEMINI else AiProvider.GPT
        return AiSelection(provider, modelFor(provider)).also { selectModel(it.provider, it.model) }
    }

    var bubbleSizeDp: Int
        get() = preferences.getInt(KEY_BUBBLE_SIZE, DEFAULT_BUBBLE_SIZE)
            .coerceIn(MIN_BUBBLE_SIZE, MAX_BUBBLE_SIZE)
        set(value) {
            preferences.edit()
                .putInt(KEY_BUBBLE_SIZE, value.coerceIn(MIN_BUBBLE_SIZE, MAX_BUBBLE_SIZE))
                .apply()
        }

    var memoryAdditionsEnabled: Boolean
        get() = preferences.getBoolean(KEY_MEMORY_ADDITIONS_ENABLED, true)
        set(value) {
            preferences.edit()
                .putBoolean(KEY_MEMORY_ADDITIONS_ENABLED, value)
                .apply()
        }

    var popupOpacityPercent: Int
        get() = preferences.getInt(KEY_POPUP_OPACITY, DEFAULT_POPUP_OPACITY)
            .coerceIn(MIN_POPUP_OPACITY, MAX_POPUP_OPACITY)
        set(value) {
            preferences.edit()
                .putInt(
                    KEY_POPUP_OPACITY,
                    value.coerceIn(MIN_POPUP_OPACITY, MAX_POPUP_OPACITY),
                )
                .apply()
        }

    companion object {
        const val MIN_BUBBLE_SIZE = 44
        const val MAX_BUBBLE_SIZE = 84
        const val DEFAULT_BUBBLE_SIZE = 58
        const val MIN_POPUP_OPACITY = 55
        const val MAX_POPUP_OPACITY = 100
        const val DEFAULT_POPUP_OPACITY = 96

        private const val NAME = "writing_enhancer_preferences"
        private const val KEY_PROVIDER = "ai_provider"
        private const val KEY_BUBBLE_SIZE = "bubble_size_dp"
        private const val KEY_MEMORY_ADDITIONS_ENABLED = "memory_additions_enabled"
        private const val KEY_POPUP_OPACITY = "popup_opacity_percent"
    }
}
