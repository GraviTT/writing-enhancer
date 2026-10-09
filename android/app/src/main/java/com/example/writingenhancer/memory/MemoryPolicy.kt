package com.example.writingenhancer.memory

import java.util.Locale
import kotlin.math.ln
import kotlin.math.pow

object MemoryPolicy {
    const val MAX_ITEMS = 50
    const val MAX_CANDIDATES_PER_REQUEST = 3
    const val MAX_RETRIEVED = 5

    private val allowedTypes = setOf(
        "style_rule",
        "context_fact",
        "relationship",
        "workflow_rule",
    )
    private val allowedSources = setOf("explicit", "repeated", "inferred")
    private val genericValues = setOf(
        "좋아",
        "싫어",
        "몰라",
        "그냥",
        "알아서",
        "네",
        "아니요",
        "감사",
    )

    private val sensitiveWords = Regex(
        """(?i)(비밀\s*번호|패스워드|password|passcode|pin\s*번호|인증\s*번호|otp|보안\s*코드|""" +
            """api[\s_-]*(?:key|token)|api\s*키|secret|client[\s_-]*secret|access[\s_-]*token|""" +
            """refresh[\s_-]*token|auth[\s_-]*token|bearer\s*token|private\s*key|ssh\s*key|credential|""" +
            """주민\s*등록|여권\s*번호|운전\s*면허|계좌\s*번호|카드\s*번호|cvv|cvc|""" +
            """병력|진단명|처방전|복용\s*약|혈액형|질환|질병|의료\s*정보|건강\s*정보|""" +
            """증상|수술|입원|치료\s*기록|검사\s*결과|정신\s*건강|우울증|알레르기|""" +
            """임신|생리\s*주기|유전\s*질환|성적\s*취향)""",
    )
    private val credentialToken = Regex(
        """(?i)(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|""" +
            """gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|""" +
            """bearer\s+[A-Za-z0-9._~+/-]{12,}=*)""",
    )
    private val residentNumber = Regex("""(?<!\d)\d{6}\s*[- ]?\s*[1-8]\d{6}(?!\d)""")
    private val longFinancialNumber = Regex("""(?<!\d)(?:\d[\s-]?){13,19}(?!\d)""")
    private val phoneNumber = Regex("""(?<!\d)(?:\+?82[\s-]?)?0?1[016789][\s-]?\d{3,4}[\s-]?\d{4}(?!\d)""")
    private val email = Regex("""[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}""")

    fun isSensitive(text: String): Boolean {
        return sensitiveWords.containsMatchIn(text) ||
            credentialToken.containsMatchIn(text) ||
            residentNumber.containsMatchIn(text) ||
            longFinancialNumber.containsMatchIn(text) ||
            phoneNumber.containsMatchIn(text) ||
            email.containsMatchIn(text)
    }

    fun isAcceptable(candidate: MemoryCandidate, rawInput: String): Boolean {
        val value = candidate.value.trim()
        if (candidate.type !in allowedTypes) return false
        if (candidate.sourceKind !in allowedSources) return false
        if (candidate.confidence < 0.74) return false
        if (candidate.sourceKind == "inferred" && candidate.confidence < 0.78) return false
        if (value.length !in 3..240 || candidate.scope.length !in 1..80) return false
        if (normalize(value) in genericValues) return false
        if (
            isSensitive(value) ||
            isSensitive(candidate.scope) ||
            candidate.conflictKey?.let(::isSensitive) == true ||
            candidate.keywords.any(::isSensitive)
        ) return false

        // The provider may paraphrase a rule, but at least one short anchor must
        // occur in the user's own input before it can enter local memory.
        val raw = normalize(rawInput)
        val grounded = candidate.keywords
            .asSequence()
            .map(::normalize)
            .filter { it.length >= 2 }
            .any { raw.contains(it) }
        if (!grounded) return false
        return true
    }

    /**
     * "explicit" is durable only when the user's own typed/voice text carries
     * strong evidence. Provider claims and attachment text are not evidence.
     */
    fun isStronglyGrounded(candidate: MemoryCandidate, rawInput: String): Boolean {
        val raw = normalize(rawInput)
        val canonicalRaw = canonical(rawInput)
        val canonicalValue = canonical(candidate.value)
        if (canonicalValue.length >= 3 && canonicalRaw.contains(canonicalValue)) return true
        val keywordAnchors = candidate.keywords
            .map(::normalize)
            .filter { it.length >= 2 }
            .distinct()
        if (keywordAnchors.size < 2) return false
        return keywordAnchors.count { raw.contains(it) } >= 2
    }

    fun groundedSource(candidate: MemoryCandidate, rawInput: String): String =
        if (
            candidate.sourceKind in setOf("explicit", "repeated") &&
            !isStronglyGrounded(candidate, rawInput)
        ) {
            "inferred"
        } else {
            candidate.sourceKind
        }

    fun isSafeMemoryItem(item: MemoryItem): Boolean =
        !isSensitive(item.value) &&
            !isSensitive(item.scope) &&
            item.conflictKey?.let(::isSensitive) != true &&
            item.keywords.none(::isSensitive)

    fun mergeUserEdit(
        primary: MemoryItem,
        duplicates: List<MemoryItem>,
        value: String,
        scope: String,
        now: Long,
    ): MemoryItem? {
        val merged = primary.copy(
            value = value.trim(),
            scope = scope.trim().ifBlank { "general" },
            keywords = (primary.keywords + duplicates.flatMap { it.keywords })
                .map(String::trim)
                .filter(String::isNotBlank)
                .distinctBy(::canonical)
                .take(8),
            sourceKind = "explicit",
            confidence = 1.0,
            retention = "long_term",
            evidenceCount = primary.evidenceCount + duplicates.sumOf { it.evidenceCount },
            useCount = primary.useCount + duplicates.sumOf { it.useCount },
            createdAt = minOf(primary.createdAt, duplicates.minOfOrNull { it.createdAt } ?: primary.createdAt),
            updatedAt = now,
            lastUsedAt = (listOfNotNull(primary.lastUsedAt) +
                duplicates.mapNotNull { it.lastUsedAt }).maxOrNull(),
            lastDecayedAt = now,
            expiresAt = null,
        )
        return merged.takeIf(::isSafeMemoryItem)
    }

    fun canonical(value: String): String =
        normalize(value).replace(Regex("""[^\p{L}\p{N}]"""), "")

    fun selectRelevant(
        items: List<MemoryItem>,
        query: String,
        now: Long = System.currentTimeMillis(),
    ): List<MemoryItem> {
        val queryTokens = tokens(query)
        return items
            .asSequence()
            .filter { it.expiresAt == null || it.expiresAt > now }
            .map { item ->
                val itemTokens = tokens(
                    "${item.scope} ${item.value} ${item.keywords.joinToString(" ")}",
                )
                val overlap = if (queryTokens.isEmpty()) {
                    0.0
                } else {
                    queryTokens.count { queryToken ->
                        itemTokens.any {
                            it.contains(queryToken) || queryToken.contains(it)
                        }
                    }.toDouble() / queryTokens.size
                }
                val broadPreference = if (
                    item.type == "style_rule" &&
                    isGlobalScope(item.scope)
                ) 0.45 else 0.0
                val repetition = ln((item.evidenceCount + 1).toDouble()) * 0.12
                val lastActivity = item.lastUsedAt ?: item.updatedAt
                val recencyDays = ((now - lastActivity).coerceAtLeast(0L) / DAY_MS).toDouble()
                val recency = 0.2 / (1.0 + recencyDays / 30.0)
                val usage = ln((item.useCount + 1).toDouble()) * 0.05
                item to (
                    overlap * 2.0 +
                        broadPreference +
                        repetition +
                        recency +
                        usage +
                        item.confidence * 0.3
                    )
            }
            .filter { (_, score) -> score > 0.05 }
            .sortedByDescending { (_, score) -> score }
            .take(MAX_RETRIEVED)
            .map { it.first }
            .toList()
    }

    fun decay(
        items: List<MemoryItem>,
        now: Long = System.currentTimeMillis(),
    ): List<MemoryItem> = items.mapNotNull { item ->
        if (item.expiresAt != null && item.expiresAt <= now) return@mapNotNull null
        val elapsedDays = ((now - item.lastDecayedAt).coerceAtLeast(0L) / DAY_MS).toDouble()
        val halfLifeDays = when (item.retention) {
            "session" -> 1.0
            "temporary" -> 45.0
            else -> 540.0
        }
        val confidence = (item.confidence * 0.5.pow(elapsedDays / halfLifeDays))
            .coerceIn(0.0, 1.0)
        if (confidence < 0.2 && item.retention != "long_term") {
            null
        } else {
            item.copy(confidence = confidence, lastDecayedAt = now)
        }
    }

    fun sourceRank(sourceKind: String): Int = when (sourceKind) {
        "explicit" -> 3
        "repeated" -> 2
        else -> 1
    }

    fun retentionRank(retention: String): Int = when (retention) {
        "long_term" -> 3
        "temporary" -> 2
        else -> 1
    }

    fun retentionFor(type: String, sourceKind: String): Pair<String, Long?> {
        if (sourceKind == "inferred") return "session" to (8L * 60L * 60L * 1000L)
        if (type == "context_fact") {
            val duration = if (sourceKind == "repeated") 90L * DAY_MS else 30L * DAY_MS
            return "temporary" to duration
        }
        return "long_term" to null
    }

    fun budget(items: List<MemoryItem>, now: Long): List<MemoryItem> =
        items.sortedByDescending { item ->
            val ageDays = ((now - item.updatedAt).coerceAtLeast(0L) / DAY_MS).toDouble()
            retentionRank(item.retention) * 10.0 +
                sourceRank(item.sourceKind) * 4.0 +
                item.confidence * 5.0 +
                ln((item.useCount + 1).toDouble()) -
                ageDays / 365.0
        }.take(MAX_ITEMS)

    private fun tokens(text: String): Set<String> =
        normalize(text)
            .split(Regex("""[^\p{L}\p{N}]+"""))
            .filter { it.length >= 2 }
            .toSet()

    private fun normalize(text: String): String =
        text.lowercase(Locale.ROOT)
            .replace(Regex("""\s+"""), " ")
            .trim()

    private fun isGlobalScope(scope: String): Boolean =
        normalize(scope) in setOf("global", "general", "all", "전체", "전역", "모든 글")

    private const val DAY_MS = 24L * 60L * 60L * 1000L
}
