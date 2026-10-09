package com.example.writingenhancer.ui

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan

/** A deliberately small native-text formatter. It never loads HTML, links or remote content. */
object ChatTextFormatter {
    private val markup = Regex("(?m)```[^\\n]*\\n([\\s\\S]*?)```|`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|^#{1,3} ([^\\n]+)$")

    fun render(source: String): CharSequence {
        val result = SpannableStringBuilder()
        var cursor = 0
        for (match in markup.findAll(source)) {
            result.append(source, cursor, match.range.first)
            val group = (1..4).first { match.groups[it] != null }
            val start = result.length
            result.append(match.groupValues[group])
            val span = if (group <= 2) TypefaceSpan("monospace") else StyleSpan(Typeface.BOLD)
            result.setSpan(span, start, result.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            cursor = match.range.last + 1
        }
        result.append(source, cursor, source.length)
        return result
    }
}
