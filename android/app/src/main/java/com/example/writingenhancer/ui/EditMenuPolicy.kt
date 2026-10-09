package com.example.writingenhancer.ui

data class EditorSnapshot(
    val text: String,
    val selectionStart: Int,
    val selectionEnd: Int,
)

data class EditMenuState(
    val canPaste: Boolean,
    val canUndo: Boolean,
    val canCopy: Boolean,
    val canCut: Boolean,
    val canSelectAll: Boolean,
)

object EditMenuPolicy {
    fun wordRange(text: String, offset: Int): IntRange? {
        if (text.isEmpty()) return null
        var index = offset.coerceIn(0, text.length)
        if (index == text.length) index -= 1
        if (text[index].isWhitespace()) return null
        var start = index
        var endExclusive = index + 1
        while (start > 0 && !text[start - 1].isWhitespace()) start -= 1
        while (endExclusive < text.length && !text[endExclusive].isWhitespace()) {
            endExclusive += 1
        }
        return start until endExclusive
    }

    fun selectionRange(
        textLength: Int,
        selectionStart: Int,
        selectionEnd: Int,
    ): IntRange? {
        if (textLength <= 0 || selectionStart < 0 || selectionEnd < 0) return null
        val start = minOf(selectionStart, selectionEnd).coerceIn(0, textLength)
        val endExclusive = maxOf(selectionStart, selectionEnd).coerceIn(start, textLength)
        return if (start == endExclusive) null else start until endExclusive
    }

    fun state(
        textLength: Int,
        selectionStart: Int,
        selectionEnd: Int,
        hasTextClipboard: Boolean,
        canUndo: Boolean,
    ): EditMenuState {
        val range = selectionRange(textLength, selectionStart, selectionEnd)
        val hasSelection = range != null
        val allSelected = range?.let {
            it.first == 0 && it.last + 1 == textLength
        } == true
        return EditMenuState(
            canPaste = hasTextClipboard,
            canUndo = canUndo,
            canCopy = hasSelection,
            canCut = hasSelection,
            canSelectAll = textLength > 0 && !allSelected,
        )
    }
}

class EditorUndoHistory(private val maximumSize: Int = 40) {
    private val snapshots = java.util.ArrayDeque<EditorSnapshot>()

    init {
        require(maximumSize > 0)
    }

    fun canUndo(): Boolean = snapshots.isNotEmpty()

    fun clear() {
        snapshots.clear()
    }

    fun record(before: EditorSnapshot, afterText: String) {
        if (before.text == afterText) return
        if (snapshots.peekLast() == before) return
        snapshots.addLast(before)
        while (snapshots.size > maximumSize) snapshots.removeFirst()
    }

    fun pop(): EditorSnapshot? = snapshots.pollLast()
}
