// 자동 생성 파일입니다. 직접 고치지 마세요.
// 원본: shared/rules/ — 고친 뒤 shared 폴더에서 `npm run rules`를 실행하세요.
package com.example.writingenhancer.ai

object ModelCatalog {
    val models: Map<String, List<Pair<String, String>>> = mapOf(
        "openai" to listOf(
            "gpt-5.6-terra" to "GPT-5.6 Terra",
            "gpt-6.2-sol" to "GPT-6.2 Sol",
            "gpt-6.2-astra" to "GPT-6.2 Astra",
            "gpt-6.1-terra" to "GPT-6.1 Terra",
            "gpt-6-luna" to "GPT-6 Luna",
        ),
        "gemini" to listOf(
            "gemini-3.6-flash" to "Gemini 3.6 Flash",
            "gemini-4-hydrogen" to "Gemini 4 Hydrogen",
            "gemini-4-neon" to "Gemini 4 Neon",
            "gemini-4-carbon" to "Gemini 4 Carbon",
            "gemini-4-argon" to "Gemini 4 Argon",
            "gemini-3.8-flash" to "Gemini 3.8 Flash",
        ),
    )
}
