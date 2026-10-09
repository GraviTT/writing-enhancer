package com.example.writingenhancer.memory

data class MemoryCandidate(
    val type: String,
    val value: String,
    val scope: String,
    val confidence: Double,
    val sourceKind: String,
    val conflictKey: String?,
    val keywords: List<String>,
)

data class MemoryItem(
    val id: String,
    val type: String,
    val value: String,
    val scope: String,
    val keywords: List<String>,
    val confidence: Double,
    val sourceKind: String,
    val conflictKey: String?,
    val retention: String,
    val evidenceCount: Int,
    val useCount: Int,
    val createdAt: Long,
    val updatedAt: Long,
    val lastUsedAt: Long?,
    val lastDecayedAt: Long,
    val expiresAt: Long?,
)

data class MemoryChange(
    val before: MemoryItem?,
    val after: MemoryItem,
    val superseded: List<MemoryItem> = emptyList(),
)
