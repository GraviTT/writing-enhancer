package com.example.writingenhancer.process

/**
 * 다른 앱에서 선택해 보낸 글(Android 텍스트 선택 메뉴의 PROCESS_TEXT)을 다루는 규칙.
 * 받은 글은 사용자 입력과 같게 취급하되, 너무 길면 자른다.
 */
object SelectionTextPolicy {
    const val MAX_ENHANCE_CHARACTERS = 12_000
    const val MAX_CHAT_CHARACTERS = 4_000

    fun clean(value: CharSequence?): String =
        value?.toString().orEmpty()
            .replace("\u0000", "")
            .replace("\r\n", "\n")
            .trim()

    /** 강화할 원문. 비어 있으면 null. */
    fun enhanceInput(value: CharSequence?): String? =
        clean(value).take(MAX_ENHANCE_CHARACTERS).ifEmpty { null }

    /** 사이드 채팅 입력칸에 넣을 글. 선택한 글을 따옴표로 묶고, 뒤에 질문을 이어 쓰게 한 줄을 비운다. */
    fun chatDraft(value: CharSequence?): String? {
        val text = clean(value).ifEmpty { return null }
        val quoted = if (text.length > MAX_CHAT_CHARACTERS) text.take(MAX_CHAT_CHARACTERS) + "…" else text
        return "“$quoted”\n\n"
    }

    /** 보낸 앱의 입력칸을 바꿀 수 있는지. 읽기 전용 표시가 없으면 바꿀 수 있다고 본다. */
    fun canReplace(readOnly: Boolean): Boolean = !readOnly
}
