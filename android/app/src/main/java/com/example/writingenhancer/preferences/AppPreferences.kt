package com.example.writingenhancer.preferences

import android.content.Context

class AppPreferences(context: Context) {
    private val preferences = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

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
        private const val KEY_BUBBLE_SIZE = "bubble_size_dp"
        private const val KEY_MEMORY_ADDITIONS_ENABLED = "memory_additions_enabled"
        private const val KEY_POPUP_OPACITY = "popup_opacity_percent"
    }
}
