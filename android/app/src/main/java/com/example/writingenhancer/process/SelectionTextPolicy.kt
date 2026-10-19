package com.example.writingenhancer.process

import com.example.writingenhancer.ai.EnhancementLevelPolicy

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

    /** 상황 버튼을 누르면 그 상황을 넣고, 이미 들어 있는 상황을 다시 누르면 비운다. */
    fun toggleSituation(current: String, chosen: String): String =
        if (current.trim() == chosen) "" else chosen

    /** 결과 위에 보여 줄 조건 요약. 예: "3단계 원문 충실 · 메신저로 보내는 답장" */
    fun optionSummary(level: Int, situation: String): String {
        val definition = EnhancementLevelPolicy.definition(level)
        val base = "${definition.value}단계 ${definition.label}"
        val trimmed = situation.trim()
        return if (trimmed.isEmpty()) base else "$base · $trimmed"
    }

    /** 단계 버튼 아래 설명. 예: "3단계 · 원문 충실 — 원문 글자 수의 약 90~110%" */
    fun levelHint(level: Int): String {
        val definition = EnhancementLevelPolicy.definition(level)
        return "${definition.value}단계 · ${definition.label} — ${definition.lengthTarget}"
    }

    /** 고쳐 쓸 수 있는 선택한 글 위에 붙는 이름. */
    fun originalLabel(characters: Int): String = "선택한 글 · ${characters}자 · 고쳐 써도 돼요"

    /** 접어 둔 상황 칸을 여는 버튼 글. 상황을 골랐으면 접혀 있어도 보여 준다. */
    fun situationToggleLabel(open: Boolean, situation: String): String = when {
        open -> "상황 접기"
        situation.isBlank() -> "＋ 상황 고르기 · 선택"
        else -> "상황 ✓ ${SituationPresetPolicy.labelFor(situation)}"
    }

    /** 저장해 둔 단계가 없으면 글 강화기에서 쓰던 단계를 쓴다. */
    fun initialLevel(saved: Int?, draftLevel: Int): Int =
        EnhancementLevelPolicy.normalize(saved ?: draftLevel)
}
