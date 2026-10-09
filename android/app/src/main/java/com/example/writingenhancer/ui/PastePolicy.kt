package com.example.writingenhancer.ui

data class PasteEdit(
    val rangeStart: Int,
    val rangeEnd: Int,
    val insertedText: String,
    val resultingText: String,
    val cursor: Int,
)

object PastePolicy {
    fun shouldUseNativeFallback(edit: PasteEdit?): Boolean = edit == null

    fun resolve(
        original: String,
        selectionStart: Int,
        selectionEnd: Int,
        hasTextMime: Boolean,
        itemCount: Int,
        coerceItem: (Int) -> CharSequence?,
    ): PasteEdit? {
        if (!hasTextMime || itemCount <= 0) return null
        val items = try {
            (0 until itemCount).map { index ->
                coerceItem(index)?.toString() ?: return null
            }
        } catch (_: Exception) {
            return null
        }
        if (items.all(String::isEmpty)) return null
        val inserted = items.joinToString(separator = "\n")

        val fallback = original.length
        val first = selectionStart.takeIf { it >= 0 } ?: fallback
        val second = selectionEnd.takeIf { it >= 0 } ?: first
        val rangeStart = minOf(first, second).coerceIn(0, original.length)
        val rangeEnd = maxOf(first, second).coerceIn(rangeStart, original.length)
        return PasteEdit(
            rangeStart = rangeStart,
            rangeEnd = rangeEnd,
            insertedText = inserted,
            resultingText = original.replaceRange(rangeStart, rangeEnd, inserted),
            cursor = rangeStart + inserted.length,
        )
    }
}
