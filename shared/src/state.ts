import {
  MAX_ATTACHMENT_COUNT,
  type AttachmentMetadata,
  type ReferenceAttachment,
  validateAttachmentBatch,
  validateAttachmentMetadata,
} from "./attachments.js";
import {
  WRITING_MODES,
  validateGuessFirstResult,
  type GuessFirstResult,
  type WritingMode,
} from "./contracts.js";
import {
  MEMORY_RETENTIONS,
  validateMemoryCard,
  type MemoryCard,
  type MemoryRetention,
} from "./memory.js";
import type { PromptContext } from "./prompt.js";
import { isMemorySafe } from "./sensitive.js";

export const WRITING_REQUEST_SCHEMA_VERSION = 2 as const;
export const MAX_INPUT_CHARS = 50_000;
export const MAX_CONTEXT_NOTE_CHARS = 2_000;
export const MAX_FEEDBACK_CHARS = 5_000;
export const MAX_COMPLETED_TEXT_CHARS = 50_000;
export const MAX_HISTORY_TITLE_CHARS = 120;
export const MAX_HISTORY_VERSIONS = 30;
export const MAX_HISTORY_ENTRIES = 100;

export interface WritingRequestV2 {
  schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION;
  mode: WritingMode;
  input: string;
  context_note: string | null;
  attachments: ReferenceAttachment[];
  feedback: string | null;
  previous_completed_text: string | null;
}

export const HISTORY_VERSION_SOURCES = [
  "initial",
  "regenerate",
  "feedback",
  "restore",
] as const;

export type HistoryVersionSource = (typeof HISTORY_VERSION_SOURCES)[number];

export interface HistoryVersion {
  id: string;
  sequence: number;
  source: HistoryVersionSource;
  completed_text: string;
  assumption: string;
  follow_up: string;
  created_at: string;
}

export interface HistoryEntry {
  schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION;
  id: string;
  title: string;
  mode: WritingMode;
  source_input: string;
  context_note: string | null;
  attachments: AttachmentMetadata[];
  versions: HistoryVersion[];
  active_version_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Attachment payloads are stored separately by id. Keeping only metadata in a
 * draft/history record avoids duplicating large image blobs on every autosave.
 */
export interface WritingDraft {
  schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION;
  id: string;
  mode: WritingMode;
  input: string;
  context_note: string | null;
  attachments: AttachmentMetadata[];
  feedback: string | null;
  previous_completed_text: string | null;
  history_entry_id: string | null;
  pending_guess: PendingGuessState | null;
  created_at: string;
  updated_at: string;
}

export interface PendingGuessState {
  question: string;
  recommended_answer: string;
  assumption: string;
  asked_at: string;
}

export interface HistoryStore {
  schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION;
  entries: HistoryEntry[];
  selected_entry_id: string | null;
}

export const MEMORY_EDIT_OPERATIONS = ["update", "delete"] as const;
export type MemoryEditOperation = (typeof MEMORY_EDIT_OPERATIONS)[number];

export interface MemoryEditChanges {
  value?: string;
  scope?: string;
  keywords?: string[];
  retention?: MemoryRetention;
}

export interface UpdateMemoryCommand {
  schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION;
  operation: "update";
  memory_id: string;
  changes: MemoryEditChanges;
  edited_at: string;
}

export interface DeleteMemoryCommand {
  schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION;
  operation: "delete";
  memory_id: string;
  edited_at: string;
}

export type MemoryEditCommand = UpdateMemoryCommand | DeleteMemoryCommand;

export interface MemoryEditApplyResult {
  status: "updated" | "deleted" | "rejected";
  cards: MemoryCard[];
  card: MemoryCard | null;
  reason: "invalid_command" | "not_found" | "stale_edit" | "unsafe_final_card" | null;
}

export class StateContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)
  );
}

function isStringWithin(
  value: unknown,
  maximum: number,
  allowEmpty = true,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isNullableStringWithin(
  value: unknown,
  maximum: number,
): value is string | null {
  return value === null || isStringWithin(value, maximum);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isMode(value: unknown): value is WritingMode {
  return (
    typeof value === "string" &&
    WRITING_MODES.includes(value as WritingMode)
  );
}

function hasUniqueAttachmentIds(attachments: readonly AttachmentMetadata[]): boolean {
  return new Set(attachments.map((attachment) => attachment.id)).size === attachments.length;
}

function validateMetadataList(value: unknown): value is AttachmentMetadata[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ATTACHMENT_COUNT &&
    value.every(validateAttachmentMetadata) &&
    hasUniqueAttachmentIds(value)
  );
}

export function validateWritingRequestV2(
  value: unknown,
): value is WritingRequestV2 {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "schema_version",
      "mode",
      "input",
      "context_note",
      "attachments",
      "feedback",
      "previous_completed_text",
    ])
  ) {
    return false;
  }
  if (value.schema_version !== WRITING_REQUEST_SCHEMA_VERSION) return false;
  if (!isMode(value.mode)) return false;
  if (!isStringWithin(value.input, MAX_INPUT_CHARS)) return false;
  if (!isNullableStringWithin(value.context_note, MAX_CONTEXT_NOTE_CHARS)) {
    return false;
  }
  if (!validateAttachmentBatch(value.attachments)) return false;
  if (!isNullableStringWithin(value.feedback, MAX_FEEDBACK_CHARS)) return false;
  if (
    !isNullableStringWithin(
      value.previous_completed_text,
      MAX_COMPLETED_TEXT_CHARS,
    )
  ) {
    return false;
  }

  if (value.mode === "enhance") {
    const hasInput = value.input.trim().length > 0;
    const hasContext =
      typeof value.context_note === "string" &&
      value.context_note.trim().length > 0;
    const hasFeedback =
      typeof value.feedback === "string" &&
      value.feedback.trim().length > 0;
    if (
      !hasInput &&
      !hasContext &&
      !hasFeedback &&
      value.attachments.length === 0
    ) {
      return false;
    }
  }
  return true;
}

export function validateHistoryVersion(
  value: unknown,
): value is HistoryVersion {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "id",
      "sequence",
      "source",
      "completed_text",
      "assumption",
      "follow_up",
      "created_at",
    ])
  ) {
    return false;
  }
  return (
    isId(value.id) &&
    Number.isInteger(value.sequence) &&
    (value.sequence as number) >= 1 &&
    typeof value.source === "string" &&
    HISTORY_VERSION_SOURCES.includes(value.source as HistoryVersionSource) &&
    isStringWithin(value.completed_text, MAX_COMPLETED_TEXT_CHARS, false) &&
    isStringWithin(value.assumption, 240, false) &&
    isStringWithin(value.follow_up, 240, false) &&
    isIsoDate(value.created_at)
  );
}

export function validateHistoryEntry(value: unknown): value is HistoryEntry {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "schema_version",
      "id",
      "title",
      "mode",
      "source_input",
      "context_note",
      "attachments",
      "versions",
      "active_version_id",
      "created_at",
      "updated_at",
    ])
  ) {
    return false;
  }
  if (
    value.schema_version !== WRITING_REQUEST_SCHEMA_VERSION ||
    !isId(value.id) ||
    !isStringWithin(value.title, MAX_HISTORY_TITLE_CHARS, false) ||
    !isMode(value.mode) ||
    !isStringWithin(value.source_input, MAX_INPUT_CHARS) ||
    !isNullableStringWithin(value.context_note, MAX_CONTEXT_NOTE_CHARS) ||
    !validateMetadataList(value.attachments) ||
    !Array.isArray(value.versions) ||
    value.versions.length === 0 ||
    value.versions.length > MAX_HISTORY_VERSIONS ||
    !value.versions.every(validateHistoryVersion) ||
    !isId(value.active_version_id) ||
    !isIsoDate(value.created_at) ||
    !isIsoDate(value.updated_at)
  ) {
    return false;
  }

  const versionIds = value.versions.map((version) => version.id);
  const sequences = value.versions.map((version) => version.sequence);
  return (
    new Set(versionIds).size === versionIds.length &&
    new Set(sequences).size === sequences.length &&
    sequences.every((sequence, index) => sequence === index + 1) &&
    versionIds.includes(value.active_version_id) &&
    Date.parse(value.updated_at) >= Date.parse(value.created_at)
  );
}

export function validatePendingGuessState(
  value: unknown,
): value is PendingGuessState {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "question",
      "recommended_answer",
      "assumption",
      "asked_at",
    ])
  ) {
    return false;
  }
  return (
    validateGuessFirstResult({
      question: value.question,
      recommended_answer: value.recommended_answer,
      assumption: value.assumption,
      memory_candidates: [],
    }) && isIsoDate(value.asked_at)
  );
}

export function validateWritingDraft(value: unknown): value is WritingDraft {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "schema_version",
      "id",
      "mode",
      "input",
      "context_note",
      "attachments",
      "feedback",
      "previous_completed_text",
      "history_entry_id",
      "pending_guess",
      "created_at",
      "updated_at",
    ])
  ) {
    return false;
  }
  return (
    value.schema_version === WRITING_REQUEST_SCHEMA_VERSION &&
    isId(value.id) &&
    isMode(value.mode) &&
    isStringWithin(value.input, MAX_INPUT_CHARS) &&
    isNullableStringWithin(value.context_note, MAX_CONTEXT_NOTE_CHARS) &&
    validateMetadataList(value.attachments) &&
    isNullableStringWithin(value.feedback, MAX_FEEDBACK_CHARS) &&
    isNullableStringWithin(
      value.previous_completed_text,
      MAX_COMPLETED_TEXT_CHARS,
    ) &&
    (value.history_entry_id === null || isId(value.history_entry_id)) &&
    (value.pending_guess === null ||
      (value.mode === "guess_first" &&
        validatePendingGuessState(value.pending_guess))) &&
    isIsoDate(value.created_at) &&
    isIsoDate(value.updated_at) &&
    Date.parse(value.updated_at) >= Date.parse(value.created_at)
  );
}

function validateMemoryEditChanges(value: unknown): value is MemoryEditChanges {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["value", "scope", "keywords", "retention"])) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (
    "value" in value &&
    !isStringWithin(value.value, 240, false)
  ) {
    return false;
  }
  if (
    "scope" in value &&
    !isStringWithin(value.scope, 80, false)
  ) {
    return false;
  }
  if (
    "keywords" in value &&
    (!Array.isArray(value.keywords) ||
      value.keywords.length > 8 ||
      !value.keywords.every(
        (keyword) =>
          isStringWithin(keyword, 40, false),
      ))
  ) {
    return false;
  }
  if (
    "retention" in value &&
    !MEMORY_RETENTIONS.includes(value.retention as MemoryRetention)
  ) {
    return false;
  }
  return isMemorySafe(
    typeof value.value === "string" ? value.value : "",
    typeof value.scope === "string" ? value.scope : "",
    Array.isArray(value.keywords) ? (value.keywords as string[]) : [],
  );
}

export function validateMemoryEditCommand(
  value: unknown,
): value is MemoryEditCommand {
  if (!isRecord(value)) return false;
  const commonValid =
    value.schema_version === WRITING_REQUEST_SCHEMA_VERSION &&
    isId(value.memory_id) &&
    isIsoDate(value.edited_at);
  if (!commonValid) return false;

  if (value.operation === "delete") {
    return hasOnlyKeys(value, [
      "schema_version",
      "operation",
      "memory_id",
      "edited_at",
    ]);
  }
  if (value.operation === "update") {
    return (
      hasOnlyKeys(value, [
        "schema_version",
        "operation",
        "memory_id",
        "changes",
        "edited_at",
      ]) && validateMemoryEditChanges(value.changes)
    );
  }
  return false;
}

export function writingRequestToPromptContext(
  request: WritingRequestV2,
): PromptContext {
  if (!validateWritingRequestV2(request)) {
    throw new StateContractError("invalid WritingRequestV2");
  }
  const context: PromptContext = {
    input: request.input,
    mode: request.mode,
    attachments: request.attachments.map((attachment) => ({ ...attachment })),
  };
  if (request.context_note !== null) context.contextNote = request.context_note;
  if (request.feedback !== null) context.feedback = request.feedback;
  if (request.previous_completed_text !== null) {
    context.previousCompletedText = request.previous_completed_text;
  }
  return context;
}

const DEFER_TO_AI_ANSWERS = new Set([
  "",
  "알아서",
  "몰라",
  "모르겠어",
  "그냥",
]);

export function buildGuessFirstContinuation(
  request: WritingRequestV2,
  result: GuessFirstResult,
  userAnswer: string | null = null,
): WritingRequestV2 {
  if (!validateWritingRequestV2(request) || request.mode !== "guess_first") {
    throw new StateContractError("guess-first continuation requires a valid guess_first request");
  }
  if (!validateGuessFirstResult(result)) {
    throw new StateContractError("invalid GuessFirstResult");
  }
  if (userAnswer !== null && typeof userAnswer !== "string") {
    throw new StateContractError("guess-first answer must be text or null");
  }
  const trimmedAnswer = userAnswer?.trim() ?? "";
  const answer = DEFER_TO_AI_ANSWERS.has(trimmedAnswer)
    ? result.recommended_answer
    : trimmedAnswer;
  const turn = [
    "[알아맞춰 봐 확인]",
    `질문: ${result.question}`,
    `답: ${answer}`,
  ].join("\n");
  const feedback = request.feedback
    ? `${request.feedback}\n\n${turn}`
    : turn;
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    throw new StateContractError("guess-first continuation exceeds feedback budget");
  }
  const continuation: WritingRequestV2 = {
    ...request,
    mode: "enhance",
    feedback,
  };
  if (!validateWritingRequestV2(continuation)) {
    throw new StateContractError("generated continuation is invalid");
  }
  return continuation;
}

export function pendingGuessFromResult(
  result: GuessFirstResult,
  askedAt: string,
): PendingGuessState {
  const pending: PendingGuessState = {
    question: result.question,
    recommended_answer: result.recommended_answer,
    assumption: result.assumption,
    asked_at: askedAt,
  };
  if (!validatePendingGuessState(pending)) {
    throw new StateContractError("invalid pending guess state");
  }
  return pending;
}

export function validateHistoryStore(value: unknown): value is HistoryStore {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "schema_version",
      "entries",
      "selected_entry_id",
    ])
  ) {
    return false;
  }
  if (
    value.schema_version !== WRITING_REQUEST_SCHEMA_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_HISTORY_ENTRIES ||
    !value.entries.every(validateHistoryEntry) ||
    !(
      value.selected_entry_id === null ||
      isId(value.selected_entry_id)
    )
  ) {
    return false;
  }
  const ids = value.entries.map((entry) => entry.id);
  return (
    new Set(ids).size === ids.length &&
    (value.selected_entry_id === null ||
      ids.includes(value.selected_entry_id))
  );
}

function requireValidHistoryStore(store: HistoryStore): void {
  if (!validateHistoryStore(store)) {
    throw new StateContractError("invalid HistoryStore");
  }
}

export function pruneHistoryEntries(
  entries: readonly HistoryEntry[],
  limit = MAX_HISTORY_ENTRIES,
): HistoryEntry[] {
  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > MAX_HISTORY_ENTRIES ||
    !entries.every(validateHistoryEntry)
  ) {
    throw new StateContractError("invalid history prune request");
  }
  return [...entries]
    .sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        right.created_at.localeCompare(left.created_at) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

export function createHistoryEntry(
  store: HistoryStore,
  entry: HistoryEntry,
): HistoryStore {
  requireValidHistoryStore(store);
  if (!validateHistoryEntry(entry)) {
    throw new StateContractError("invalid history entry");
  }
  if (store.entries.some((candidate) => candidate.id === entry.id)) {
    throw new StateContractError("history entry already exists");
  }
  const entries = pruneHistoryEntries([entry, ...store.entries]);
  return {
    schema_version: WRITING_REQUEST_SCHEMA_VERSION,
    entries,
    selected_entry_id: entries.some((candidate) => candidate.id === entry.id)
      ? entry.id
      : null,
  };
}

export function readHistoryEntry(
  store: HistoryStore,
  id: string,
): HistoryEntry | null {
  requireValidHistoryStore(store);
  if (!isId(id)) throw new StateContractError("invalid history id");
  return store.entries.find((entry) => entry.id === id) ?? null;
}

export function updateHistoryEntry(
  store: HistoryStore,
  entry: HistoryEntry,
): HistoryStore {
  requireValidHistoryStore(store);
  if (!validateHistoryEntry(entry)) {
    throw new StateContractError("invalid history entry");
  }
  if (!store.entries.some((candidate) => candidate.id === entry.id)) {
    throw new StateContractError("history entry not found");
  }
  return {
    ...store,
    entries: pruneHistoryEntries(
      store.entries.map((candidate) =>
        candidate.id === entry.id ? entry : candidate,
      ),
    ),
  };
}

export function deleteHistoryEntry(
  store: HistoryStore,
  id: string,
): HistoryStore {
  requireValidHistoryStore(store);
  if (!isId(id)) throw new StateContractError("invalid history id");
  if (!store.entries.some((entry) => entry.id === id)) {
    throw new StateContractError("history entry not found");
  }
  return {
    ...store,
    entries: store.entries.filter((entry) => entry.id !== id),
    selected_entry_id:
      store.selected_entry_id === id ? null : store.selected_entry_id,
  };
}

export function selectHistoryEntry(
  store: HistoryStore,
  id: string | null,
): HistoryStore {
  requireValidHistoryStore(store);
  if (
    id !== null &&
    (!isId(id) || !store.entries.some((entry) => entry.id === id))
  ) {
    throw new StateContractError("history entry not found");
  }
  return { ...store, selected_entry_id: id };
}

function normalizedEditedKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    const normalized = trimmed.normalize("NFKC").toLocaleLowerCase("ko-KR");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function editedMemoryExpiry(
  existing: MemoryCard,
  retention: MemoryRetention,
  editedAt: string,
  retentionWasChanged: boolean,
): string | null {
  if (retention === "long_term") return null;
  if (!retentionWasChanged && existing.expiresAt !== null) {
    return existing.expiresAt;
  }
  const lifetime =
    retention === "session"
      ? 8 * 60 * 60 * 1_000
      : 30 * 24 * 60 * 60 * 1_000;
  return new Date(Date.parse(editedAt) + lifetime).toISOString();
}

export function applyMemoryEditCommand(
  cards: readonly MemoryCard[],
  command: MemoryEditCommand,
): MemoryEditApplyResult {
  if (
    !cards.every(validateMemoryCard) ||
    !validateMemoryEditCommand(command)
  ) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "invalid_command",
    };
  }
  const existing = cards.find((card) => card.id === command.memory_id);
  if (!existing) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "not_found",
    };
  }
  if (Date.parse(command.edited_at) < Date.parse(existing.updatedAt)) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "stale_edit",
    };
  }
  if (command.operation === "delete") {
    return {
      status: "deleted",
      cards: cards.filter((card) => card.id !== command.memory_id),
      card: null,
      reason: null,
    };
  }

  const retention =
    command.changes.retention ??
    (existing.retention === "session" ? "long_term" : existing.retention);
  const updated: MemoryCard = {
    ...existing,
    value: command.changes.value?.trim() ?? existing.value,
    scope: command.changes.scope?.trim() ?? existing.scope,
    keywords:
      command.changes.keywords === undefined
        ? [...existing.keywords]
        : normalizedEditedKeywords(command.changes.keywords),
    source: "explicit",
    confidence: 1,
    retention,
    evidenceCount: existing.evidenceCount + 1,
    updatedAt: command.edited_at,
    lastDecayedAt: command.edited_at,
    expiresAt: editedMemoryExpiry(
      existing,
      retention,
      command.edited_at,
      command.changes.retention !== undefined,
    ),
  };
  if (
    !validateMemoryCard(updated) ||
    !isMemorySafe(updated.value, updated.scope, updated.keywords)
  ) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "unsafe_final_card",
    };
  }
  return {
    status: "updated",
    cards: cards.map((card) => (card.id === updated.id ? updated : card)),
    card: updated,
    reason: null,
  };
}
