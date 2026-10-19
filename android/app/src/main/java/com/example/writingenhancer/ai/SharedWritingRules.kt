// 자동 생성 파일입니다. 직접 고치지 마세요.
// 원본: shared/rules/ — 고친 뒤 shared 폴더에서 `npm run rules`를 실행하세요.
package com.example.writingenhancer.ai

object SharedWritingRules {
    data class Situation(val label: String, val text: String)

    const val VERSION = 1
    const val ENHANCE_SPEECH_LEVEL = "말투 맞추기:\n- 완성본의 높임 정도는 사용자 원문을 따른다. 원문이 반말이면 반말로, 존댓말이면 존댓말로 쓰고 해요체·합쇼체 같은 높임 수준도 그대로 둔다.\n- 상황 안내나 사용자의 답에서 말투나 받는 사람(예: 상사, 고객, 친구)을 정했으면 그것을 따른다.\n- 원문이 '팀장님', '고객님', '교수님'처럼 높여야 할 상대에게 직접 하는 말이면 존댓말로 쓴다.\n- 원문이 '-함', '-음', '-듯'으로 끝나는 메모라 말투가 분명하지 않으면 글의 목적과 받는 사람에 맞는 말투를 고른다.\n- follow_up과 assumption은 앱이 사용자에게 하는 말이다. 사용자가 원문이나 답을 반말로 썼으면 반말로, 그 밖에는 해요체로 쓴다."
    const val GUESS_SPEECH_LEVEL = "질문과 추론 설명은 사용자가 반말로 썼으면 반말로, 그 밖에는 해요체로 쓴다."

    val LEVEL_SHORT_LABELS: List<String> = listOf("요약", "간결", "충실", "보완", "확장")

    val SITUATIONS: List<Situation> = listOf(
        Situation("메신저 답장", "메신저로 보내는 답장"),
        Situation("업무 메일", "업무 메일"),
        Situation("상사 보고", "상사에게 하는 보고"),
        Situation("고객 응대", "고객에게 보내는 안내"),
        Situation("공지·안내", "여러 사람에게 알리는 공지"),
        Situation("SNS 글", "SNS에 올리는 글"),
        Situation("부탁·요청", "정중하게 부탁하는 글"),
        Situation("사과", "진심이 전해지는 사과"),
    )
}
