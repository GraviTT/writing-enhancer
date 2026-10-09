package com.example.writingenhancer.data

import com.example.writingenhancer.ai.AttachmentRef
import com.example.writingenhancer.ai.EnhancementLevelPolicy
import com.example.writingenhancer.security.SecureStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Drafts and history may contain private text, so they use the same
 * Android-Keystore-backed encrypted store as API keys and memory cards.
 */
class WorkspaceStore(
    private val secureStore: SecureStore,
    private val attachmentRoot: File? = null,
) {

    @Synchronized
    fun loadDraft(): DraftState {
        val raw = secureStore.getString(SecureStore.WORKING_DRAFT) ?: return DraftState()
        return runCatching { draftFromJson(JSONObject(raw)) }.getOrDefault(DraftState())
    }

    @Synchronized
    fun saveDraft(draft: DraftState) {
        val previousPaths = loadDraft().attachments.mapTo(mutableSetOf()) { it.path }
        if (
            draft.situation.isBlank() &&
            draft.rawInput.isBlank() &&
            draft.answer.isBlank() &&
            draft.question.isBlank() &&
            draft.assumption.isBlank() &&
            !draft.questionFirstActive &&
            draft.historyId.isNullOrBlank() &&
            draft.attachments.isEmpty() &&
            EnhancementLevelPolicy.normalize(draft.enhancementLevel) ==
            EnhancementLevelPolicy.DEFAULT
        ) {
            clearDraft()
        } else {
            secureStore.putString(SecureStore.WORKING_DRAFT, draftToJson(draft).toString())
            deleteUnreferencedAttachments(previousPaths - draft.attachments.map { it.path }.toSet())
        }
    }

    @Synchronized
    fun clearDraft() {
        val previousPaths = loadDraft().attachments.mapTo(mutableSetOf()) { it.path }
        secureStore.remove(SecureStore.WORKING_DRAFT)
        deleteUnreferencedAttachments(previousPaths)
    }

    @Synchronized
    fun listHistory(): List<HistoryEntry> =
        loadHistory().sortedByDescending { it.updatedAt }

    @Synchronized
    fun getHistory(id: String): HistoryEntry? = loadHistory().firstOrNull { it.id == id }

    @Synchronized
    fun addVersion(
        historyId: String?,
        situation: String,
        rawInput: String,
        attachments: List<AttachmentRef>,
        version: ResultVersion,
        now: Long = System.currentTimeMillis(),
    ): HistoryEntry {
        val originalEntries = loadHistory()
        val entries = originalEntries.toMutableList()
        val index = historyId?.let { id -> entries.indexOfFirst { it.id == id } } ?: -1
        val updated = if (index >= 0) {
            val old = entries[index]
            val versions = WorkspacePolicy.trimVersions(old.versions + version)
            old.copy(
                situation = situation,
                rawInput = rawInput,
                attachments = attachments,
                versions = versions,
                selectedVersion = versions.lastIndex,
                updatedAt = now,
            )
        } else {
            HistoryEntry(
                id = UUID.randomUUID().toString(),
                situation = situation,
                rawInput = rawInput,
                attachments = attachments,
                versions = listOf(version),
                selectedVersion = 0,
                createdAt = now,
                updatedAt = now,
            )
        }
        if (index >= 0) entries[index] = updated else entries += updated
        val savedEntries = entries.sortedByDescending { it.updatedAt }
            .take(WorkspacePolicy.MAX_HISTORY)
        saveHistory(savedEntries)
        val previousPaths = originalEntries.flatMapTo(mutableSetOf()) { entry ->
            entry.attachments.map { it.path }
        }
        val savedPaths = savedEntries.flatMapTo(mutableSetOf()) { entry ->
            entry.attachments.map { it.path }
        }
        deleteUnreferencedAttachments(previousPaths - savedPaths)
        return updated
    }

    @Synchronized
    fun selectVersion(id: String, versionIndex: Int): HistoryEntry? {
        val entries = loadHistory().toMutableList()
        val index = entries.indexOfFirst { it.id == id }
        if (index < 0) return null
        val old = entries[index]
        if (old.versions.isEmpty()) return null
        val updated = old.copy(
            selectedVersion = versionIndex.coerceIn(0, old.versions.lastIndex),
            updatedAt = System.currentTimeMillis(),
        )
        entries[index] = updated
        saveHistory(entries)
        return updated
    }

    @Synchronized
    fun deleteHistory(id: String) {
        val existing = loadHistory()
        val removedPaths = existing
            .filter { it.id == id }
            .flatMapTo(mutableSetOf()) { entry -> entry.attachments.map { it.path } }
        saveHistory(existing.filterNot { it.id == id })
        deleteUnreferencedAttachments(removedPaths)
    }

    @Synchronized
    fun deleteUnreferencedAttachments(candidatePaths: Collection<String>) {
        val root = attachmentRoot ?: return
        if (candidatePaths.isEmpty()) return
        val unreferenced = WorkspacePolicy.unreferencedAttachmentPaths(
            candidates = candidatePaths,
            draft = loadDraft(),
            histories = loadHistory(),
        )
        unreferenced.forEach { path ->
            val candidate = File(path)
            if (
                candidate.isFile &&
                runCatching { WorkspacePolicy.isInsideAttachmentRoot(root, candidate) }
                    .getOrDefault(false)
            ) {
                runCatching { candidate.delete() }
            }
        }
    }

    @Synchronized
    fun sweepAttachmentRoot() {
        val candidates = attachmentRoot
            ?.listFiles()
            ?.asSequence()
            ?.filter(File::isFile)
            ?.map(File::getAbsolutePath)
            ?.toSet()
            .orEmpty()
        deleteUnreferencedAttachments(candidates)
    }

    private fun loadHistory(): List<HistoryEntry> {
        val raw = secureStore.getString(SecureStore.ENHANCEMENT_HISTORY) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val versionsJson = item.optJSONArray("versions") ?: JSONArray()
                    val versions = buildList {
                        for (versionIndex in 0 until versionsJson.length()) {
                            val version = versionsJson.optJSONObject(versionIndex) ?: continue
                            add(
                                ResultVersion(
                                    text = version.optString("text"),
                                    question = version.optString("question"),
                                    provider = version.optString("provider"),
                                    createdAt = version.optLong("createdAt"),
                                    assumption = version.optString("assumption"),
                                    enhancementLevel = WorkspacePersistencePolicy
                                        .decodeEnhancementLevel(
                                            hasStoredValue = version.has("enhancementLevel"),
                                            isStoredNull = version.isNull("enhancementLevel"),
                                            storedValue = version.optInt("enhancementLevel"),
                                        ),
                                ),
                            )
                        }
                    }
                    if (versions.isEmpty()) continue
                    add(
                        HistoryEntry(
                            id = item.getString("id"),
                            situation = item.optString("situation"),
                            rawInput = item.optString("rawInput"),
                            attachments = attachmentsFromJson(
                                item.optJSONArray("attachments") ?: JSONArray(),
                            ),
                            versions = versions,
                            selectedVersion = item.optInt(
                                "selectedVersion",
                                versions.lastIndex,
                            ).coerceIn(0, versions.lastIndex),
                            createdAt = item.optLong("createdAt"),
                            updatedAt = item.optLong("updatedAt"),
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun saveHistory(items: List<HistoryEntry>) {
        if (items.isEmpty()) {
            secureStore.remove(SecureStore.ENHANCEMENT_HISTORY)
            return
        }
        val array = JSONArray()
        items.forEach { item ->
            val versions = JSONArray()
            item.versions.forEach { version ->
                versions.put(
                    JSONObject()
                        .put("text", version.text)
                        .put("question", version.question)
                        .put("provider", version.provider)
                        .put("createdAt", version.createdAt)
                        .put("assumption", version.assumption)
                        .put(
                            "enhancementLevel",
                            WorkspacePersistencePolicy.encodeEnhancementLevel(
                                version.enhancementLevel,
                            ),
                        ),
                )
            }
            array.put(
                JSONObject()
                    .put("id", item.id)
                    .put("situation", item.situation)
                    .put("rawInput", item.rawInput)
                    .put("attachments", attachmentsToJson(item.attachments))
                    .put("versions", versions)
                    .put("selectedVersion", item.selectedVersion)
                    .put("createdAt", item.createdAt)
                    .put("updatedAt", item.updatedAt),
            )
        }
        secureStore.putString(SecureStore.ENHANCEMENT_HISTORY, array.toString())
    }

    private fun draftToJson(draft: DraftState) = JSONObject()
        .put("situation", draft.situation)
        .put("rawInput", draft.rawInput)
        .put("answer", draft.answer)
        .put("question", draft.question)
        .put("assumption", draft.assumption)
        .put("questionFirstActive", draft.questionFirstActive)
        .put("historyId", draft.historyId ?: JSONObject.NULL)
        .put("selectedVersion", draft.selectedVersion)
        .put(
            "enhancementLevel",
            WorkspacePersistencePolicy.encodeEnhancementLevel(draft.enhancementLevel),
        )
        .put("attachments", attachmentsToJson(draft.attachments))

    private fun draftFromJson(json: JSONObject) = DraftState(
        situation = json.optString("situation"),
        rawInput = json.optString("rawInput"),
        answer = json.optString("answer"),
        question = json.optString("question"),
        assumption = json.optString("assumption"),
        questionFirstActive = json.optBoolean("questionFirstActive", false),
        historyId = if (json.isNull("historyId")) null else json.optString("historyId"),
        selectedVersion = json.optInt("selectedVersion", 0),
        enhancementLevel = WorkspacePersistencePolicy.decodeEnhancementLevel(
            hasStoredValue = json.has("enhancementLevel"),
            isStoredNull = json.isNull("enhancementLevel"),
            storedValue = json.optInt("enhancementLevel"),
        ),
        attachments = attachmentsFromJson(json.optJSONArray("attachments") ?: JSONArray()),
    )

    private fun attachmentsToJson(items: List<AttachmentRef>): JSONArray {
        val array = JSONArray()
        items.forEach { item ->
            array.put(
                JSONObject()
                    .put("path", item.path)
                    .put("displayName", item.displayName)
                    .put("mimeType", item.mimeType)
                    .put("sizeBytes", item.sizeBytes)
                    .put("source", item.source),
            )
        }
        return array
    }

    private fun attachmentsFromJson(array: JSONArray): List<AttachmentRef> = buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val path = item.optString("path")
            if (path.isBlank()) continue
            add(
                AttachmentRef(
                    path = path,
                    displayName = item.optString("displayName", "첨부 파일"),
                    mimeType = item.optString("mimeType", "application/octet-stream"),
                    sizeBytes = item.optLong("sizeBytes"),
                    source = item.optString("source", "file"),
                ),
            )
        }
    }
}
