package com.example.writingenhancer.ai

data class EnhancementLevelDefinition(
    val value: Int,
    val label: String,
    val instruction: String,
    val lengthTarget: String,
    val minimumLengthRatio: Double,
    val maximumLengthRatio: Double,
)

object EnhancementLevelPolicy {
    const val MIN = 1
    const val MAX = 5
    const val DEFAULT = 3

    val levels: List<EnhancementLevelDefinition> = listOf(
        EnhancementLevelDefinition(
            value = 1,
            label = "핵심 요약",
            instruction = "핵심 의미와 필수 사실만 남기고 반복·군더더기를 적극 제거해 짧고 선명하게 정리한다.",
            lengthTarget = "원문 글자 수의 약 45~60%",
            minimumLengthRatio = 0.45,
            maximumLengthRatio = 0.60,
        ),
        EnhancementLevelDefinition(
            value = 2,
            label = "간결 정리",
            instruction = "중복과 우회 표현을 줄이고 문장 순서를 정리해 원문보다 분명히 간결하게 만든다.",
            lengthTarget = "원문 글자 수의 약 70~85%",
            minimumLengthRatio = 0.70,
            maximumLengthRatio = 0.85,
        ),
        EnhancementLevelDefinition(
            value = 3,
            label = "원문 충실",
            instruction = "원문의 의미·말투·정보량을 유지하고 맞춤법 교정과 구조 최적화에 집중한다.",
            lengthTarget = "원문 글자 수의 약 90~110%",
            minimumLengthRatio = 0.90,
            maximumLengthRatio = 1.10,
        ),
        EnhancementLevelDefinition(
            value = 4,
            label = "내용 보완",
            instruction = "주어진 사실과 문맥 안에서 설명·연결 문장·근거의 표현을 보완해 원문보다 충분히 자세하게 만든다.",
            lengthTarget = "원문 글자 수의 약 120~150%",
            minimumLengthRatio = 1.20,
            maximumLengthRatio = 1.50,
        ),
        EnhancementLevelDefinition(
            value = 5,
            label = "풍부하게 확장",
            instruction = "새 사실을 만들지 않는 범위에서 의도·논리·설명을 충분히 풀어 쓰고 구성과 표현을 폭넓게 확장한다.",
            lengthTarget = "원문 글자 수의 약 150~200%",
            minimumLengthRatio = 1.50,
            maximumLengthRatio = 2.00,
        ),
    )

    fun normalize(value: Int): Int = value.coerceIn(MIN, MAX)

    fun fromPersisted(value: Int?): Int = normalize(value ?: DEFAULT)

    fun captureRequestLevel(value: Int): Int = normalize(value)

    fun definition(value: Int): EnhancementLevelDefinition =
        levels[normalize(value) - MIN]

    fun label(value: Int): String = definition(value).label

    fun targetCharacterRange(
        materialLength: Int,
        value: Int,
    ): IntRange {
        val definition = definition(value)
        val base = materialLength.coerceAtLeast(1)
        val minimum = kotlin.math.round(base * definition.minimumLengthRatio)
            .toInt()
            .coerceAtLeast(1)
        val maximum = kotlin.math.round(base * definition.maximumLengthRatio)
            .toInt()
            .coerceAtLeast(minimum)
        return minimum..maximum
    }
}
