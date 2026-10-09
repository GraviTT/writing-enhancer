package com.example.writingenhancer.ai

import java.util.Locale

object AttachmentPolicy {
    const val MAX_TEXT_CHARS_PER_FILE = 16_000
    const val MAX_TEXT_CHARS_TOTAL = 28_000

    private val imageMimes = setOf(
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    )
    private val textMimes = setOf(
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
    )

    fun normalizeMime(mimeType: String?, displayName: String): String {
        val normalized = mimeType.orEmpty().lowercase(Locale.ROOT).substringBefore(';').trim()
        if (normalized.isNotBlank() && normalized != "application/octet-stream") return normalized
        return when (displayName.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "pdf" -> "application/pdf"
            "txt" -> "text/plain"
            "md", "markdown" -> "text/markdown"
            "csv" -> "text/csv"
            "json" -> "application/json"
            else -> normalized.ifBlank { "application/octet-stream" }
        }
    }

    fun isSupportedMime(mimeType: String): Boolean =
        mimeType in imageMimes || mimeType == "application/pdf" || mimeType in textMimes

    fun isText(mimeType: String): Boolean = mimeType in textMimes

    fun isBinaryMultimodal(mimeType: String): Boolean =
        mimeType in imageMimes || mimeType == "application/pdf"

    fun magicMatches(mimeType: String, header: ByteArray): Boolean = when (mimeType) {
        "image/jpeg" ->
            header.size >= 3 &&
                header[0] == 0xFF.toByte() &&
                header[1] == 0xD8.toByte() &&
                header[2] == 0xFF.toByte()
        "image/png" -> header.startsWith(
            byteArrayOf(
                0x89.toByte(),
                0x50,
                0x4E,
                0x47,
                0x0D,
                0x0A,
                0x1A,
                0x0A,
            ),
        )
        "image/webp" ->
            header.size >= 12 &&
                header.copyOfRange(0, 4).contentEquals("RIFF".toByteArray()) &&
                header.copyOfRange(8, 12).contentEquals("WEBP".toByteArray())
        "image/gif" ->
            header.startsWith("GIF87a".toByteArray()) ||
                header.startsWith("GIF89a".toByteArray())
        "application/pdf" -> header.indexOf("%PDF-".toByteArray()) in 0..1024
        else -> !isBinaryMultimodal(mimeType)
    }

    fun sanitizeDisplayName(name: String): String {
        val clean = sanitizeExtractedText(name)
            .replace(Regex("""[/\\]"""), "_")
            .replace(Regex("""\s+"""), " ")
            .trim()
            .take(80)
        return clean.ifBlank { "첨부 파일" }
    }

    fun humanReadableSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024L * 1024L ->
            String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0))
    }

    /**
     * Keep normal Unicode text while removing controls that can hide or
     * visually reorder the explicit attachment boundary in the prompt.
     */
    fun sanitizeExtractedText(text: String): String = buildString(text.length) {
        text.forEach { character ->
            val allowedWhitespace = character == '\n' || character == '\t'
            val bidiControl = character in '\u202A'..'\u202E' ||
                character in '\u2066'..'\u2069'
            if ((allowedWhitespace || !character.isISOControl()) && !bidiControl) {
                append(character)
            }
        }
    }.replace(
        Regex("""\[(첨부\s*텍스트\s*(?:시작|끝))"""),
        "［$1",
    )

    private fun ByteArray.startsWith(prefix: ByteArray): Boolean =
        size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }

    private fun ByteArray.indexOf(needle: ByteArray): Int {
        if (needle.isEmpty() || size < needle.size) return -1
        for (start in 0..size - needle.size) {
            if (needle.indices.all { offset -> this[start + offset] == needle[offset] }) {
                return start
            }
        }
        return -1
    }
}
