package com.example.writingenhancer.memory

import com.example.writingenhancer.security.SecureStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class MemoryStore(private val secureStore: SecureStore) {

    fun previewCandidates(
        candidates: List<MemoryCandidate>,
        rawInput: String,
    ): List<MemoryCandidate> = eligibleCandidates(candidates, rawInput)

    @Synchronized
    fun count(): Int = MemoryPolicy.decay(load()).size

    @Synchronized
    fun all(): List<MemoryItem> {
        val active = MemoryPolicy.decay(load())
        save(active)
        return active.sortedByDescending { it.updatedAt }
    }

    @Synchronized
    fun update(id: String, value: String, scope: String): Boolean {
        val cleanedValue = value.trim()
        val cleanedScope = scope.trim().ifBlank { "general" }
        if (
            cleanedValue.length !in 3..240 ||
            cleanedScope.length !in 1..80 ||
            MemoryPolicy.isSensitive(cleanedValue) ||
            MemoryPolicy.isSensitive(cleanedScope)
        ) {
            return false
        }
        val now = System.currentTimeMillis()
        val items = MemoryPolicy.decay(load(), now).toMutableList()
        val index = items.indexOfFirst { it.id == id }
        if (index < 0) return false
        val primary = items[index]
        val conflictKey = primary.conflictKey
        val duplicates = if (conflictKey.isNullOrBlank()) {
            emptyList()
        } else {
            items.filter {
                it.id != primary.id &&
                    MemoryPolicy.canonical(it.conflictKey.orEmpty()) ==
                    MemoryPolicy.canonical(conflictKey)
            }
        }
        val updated = MemoryPolicy.mergeUserEdit(
            primary = primary,
            duplicates = duplicates,
            value = cleanedValue,
            scope = cleanedScope,
            now = now,
        ) ?: return false
        val removedIds = duplicates.mapTo(mutableSetOf()) { it.id }
        val resolved = items.filterNot { it.id == primary.id || it.id in removedIds } + updated
        save(MemoryPolicy.budget(resolved, now))
        return true
    }

    @Synchronized
    fun delete(id: String) {
        save(load().filterNot { it.id == id })
    }

    @Synchronized
    fun relevantFor(
        query: String,
        now: Long = System.currentTimeMillis(),
    ): List<MemoryItem> {
        val active = MemoryPolicy.decay(load(), now)
        val selected = MemoryPolicy.selectRelevant(active, query, now)
        val selectedIds = selected.mapTo(mutableSetOf()) { it.id }
        val marked = active.map {
            if (it.id in selectedIds) {
                it.copy(useCount = it.useCount + 1, lastUsedAt = now)
            } else {
                it
            }
        }
        save(marked)
        return marked.filter { it.id in selectedIds }
            .sortedBy { selectedIds.indexOf(it.id) }
    }

    @Synchronized
    fun addCandidates(
        candidates: List<MemoryCandidate>,
        rawInput: String,
        now: Long = System.currentTimeMillis(),
    ): List<MemoryChange> {
        val accepted = eligibleCandidates(candidates, rawInput)
        if (accepted.isEmpty()) return emptyList()

        val items = MemoryPolicy.decay(load(), now).toMutableList()
        val changes = mutableListOf<MemoryChange>()
        for (candidate in accepted) {
            val canonical = MemoryPolicy.canonical(candidate.value)
            val index = items.indexOfFirst {
                it.type == candidate.type &&
                    MemoryPolicy.canonical(it.scope) == MemoryPolicy.canonical(candidate.scope) &&
                    MemoryPolicy.canonical(it.value) == canonical
            }
            val before = items.getOrNull(index)
            // "repeated" is only trusted when a matching local card already
            // exists. A provider cannot create durable repetition evidence by
            // assertion alone.
            val effectiveSource = if (
                before == null && candidate.sourceKind == "repeated"
            ) {
                "inferred"
            } else {
                candidate.sourceKind
            }
            val mergedSource = when {
                before == null -> effectiveSource
                MemoryPolicy.sourceRank(effectiveSource) >
                    MemoryPolicy.sourceRank(before.sourceKind) -> candidate.sourceKind
                else -> before.sourceKind
            }
            val retentionPolicy = MemoryPolicy.retentionFor(candidate.type, mergedSource)
            val expiresAt = retentionPolicy.second?.let { now + it }
            val after = if (before == null) {
                MemoryItem(
                    id = UUID.randomUUID().toString(),
                    type = candidate.type,
                    value = candidate.value.trim(),
                    scope = candidate.scope.trim().ifBlank { "general" },
                    keywords = candidate.keywords
                        .map(String::trim)
                        .filter(String::isNotBlank)
                        .distinctBy(MemoryPolicy::canonical)
                        .take(8),
                    confidence = candidate.confidence.coerceIn(0.0, 1.0),
                    sourceKind = effectiveSource,
                    conflictKey = candidate.conflictKey,
                    retention = retentionPolicy.first,
                    evidenceCount = 1,
                    useCount = 0,
                    createdAt = now,
                    updatedAt = now,
                    lastUsedAt = null,
                    lastDecayedAt = now,
                    expiresAt = expiresAt,
                )
            } else {
                before.copy(
                    value = if (
                        MemoryPolicy.sourceRank(effectiveSource) >=
                        MemoryPolicy.sourceRank(before.sourceKind)
                    ) {
                        candidate.value.trim()
                    } else {
                        before.value
                    },
                    scope = if (
                        MemoryPolicy.sourceRank(effectiveSource) >=
                        MemoryPolicy.sourceRank(before.sourceKind)
                    ) {
                        candidate.scope.trim()
                    } else {
                        before.scope
                    },
                    keywords = (before.keywords + candidate.keywords)
                        .map(String::trim)
                        .filter(String::isNotBlank)
                        .distinctBy(MemoryPolicy::canonical)
                        .take(8),
                    confidence = (
                        maxOf(before.confidence, candidate.confidence) +
                            minOf(0.08, (before.evidenceCount + 1) * 0.01)
                        ).coerceAtMost(1.0),
                    sourceKind = mergedSource,
                    conflictKey = candidate.conflictKey ?: before.conflictKey,
                    retention = retentionPolicy.first,
                    evidenceCount = before.evidenceCount + 1,
                    updatedAt = now,
                    lastDecayedAt = now,
                    expiresAt = expiresAt,
                )
            }
            if (!MemoryPolicy.isSafeMemoryItem(after)) continue

            val conflicts = if (candidate.conflictKey == null || before != null) {
                emptyList()
            } else {
                items.filter {
                    it.conflictKey == candidate.conflictKey &&
                        MemoryPolicy.canonical(it.value) != canonical
                }
            }
            val strongest = conflicts.maxByOrNull { MemoryPolicy.sourceRank(it.sourceKind) }
            if (
                conflicts.isNotEmpty() &&
                (
                    candidate.sourceKind == "inferred" ||
                        (
                            strongest?.sourceKind == "explicit" &&
                                candidate.sourceKind != "explicit"
                            )
                    )
            ) {
                continue
            }

            if (conflicts.isNotEmpty()) {
                val conflictIds = conflicts.mapTo(mutableSetOf()) { it.id }
                items.removeAll { it.id in conflictIds }
            }
            if (index >= 0) {
                val updatedIndex = items.indexOfFirst { it.id == before?.id }
                if (updatedIndex >= 0) items[updatedIndex] = after else items += after
            } else {
                items += after
            }
            changes += MemoryChange(before, after, conflicts)
        }

        val trimmed = MemoryPolicy.budget(items, now)
        save(trimmed)
        return changes
    }

    private fun eligibleCandidates(
        candidates: List<MemoryCandidate>,
        rawInput: String,
    ): List<MemoryCandidate> = candidates
        .asSequence()
        .map { candidate ->
            candidate.copy(sourceKind = MemoryPolicy.groundedSource(candidate, rawInput))
        }
        .filter { MemoryPolicy.isAcceptable(it, rawInput) }
        .take(MemoryPolicy.MAX_CANDIDATES_PER_REQUEST)
        .toList()

    @Synchronized
    fun undo(changes: List<MemoryChange>) {
        if (changes.isEmpty()) return
        val items = load().associateBy { it.id }.toMutableMap()
        for (change in changes) {
            if (change.before == null) {
                items.remove(change.after.id)
            } else {
                items[change.before.id] = change.before
            }
            change.superseded.forEach { items[it.id] = it }
        }
        save(MemoryPolicy.budget(items.values.toList(), System.currentTimeMillis()))
    }

    @Synchronized
    fun clear() {
        secureStore.remove(SecureStore.MEMORY_CARDS)
    }

    private fun load(): List<MemoryItem> {
        val raw = secureStore.getString(SecureStore.MEMORY_CARDS) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(
                        MemoryItem(
                            id = item.getString("id"),
                            type = item.getString("type"),
                            value = item.getString("value"),
                            scope = item.optString("scope", "general"),
                            keywords = item.optJSONArray("keywords")?.let { keywords ->
                                buildList {
                                    for (keywordIndex in 0 until keywords.length()) {
                                        add(keywords.optString(keywordIndex))
                                    }
                                }
                            }.orEmpty(),
                            confidence = item.optDouble("confidence", 0.75),
                            sourceKind = item.optString("sourceKind", "inferred"),
                            conflictKey = if (item.isNull("conflictKey")) {
                                null
                            } else {
                                item.optString("conflictKey")
                            },
                            retention = item.optString("retention", "session"),
                            evidenceCount = item.optInt("evidenceCount", 1),
                            useCount = item.optInt("useCount", 0),
                            createdAt = item.getLong("createdAt"),
                            updatedAt = item.getLong("updatedAt"),
                            lastUsedAt = if (item.isNull("lastUsedAt")) {
                                null
                            } else {
                                item.getLong("lastUsedAt")
                            },
                            lastDecayedAt = item.optLong(
                                "lastDecayedAt",
                                item.getLong("updatedAt"),
                            ),
                            expiresAt = if (item.isNull("expiresAt")) null else item.getLong("expiresAt"),
                        ),
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    private fun save(items: Collection<MemoryItem>) {
        val array = JSONArray()
        items.forEach { item ->
            array.put(
                JSONObject()
                    .put("id", item.id)
                    .put("type", item.type)
                    .put("value", item.value)
                    .put("scope", item.scope)
                    .put("keywords", JSONArray(item.keywords))
                    .put("confidence", item.confidence)
                    .put("sourceKind", item.sourceKind)
                    .put("conflictKey", item.conflictKey ?: JSONObject.NULL)
                    .put("retention", item.retention)
                    .put("evidenceCount", item.evidenceCount)
                    .put("useCount", item.useCount)
                    .put("createdAt", item.createdAt)
                    .put("updatedAt", item.updatedAt)
                    .put("lastUsedAt", item.lastUsedAt ?: JSONObject.NULL)
                    .put("lastDecayedAt", item.lastDecayedAt)
                    .put("expiresAt", item.expiresAt ?: JSONObject.NULL),
            )
        }
        secureStore.putString(SecureStore.MEMORY_CARDS, array.toString())
    }
}
