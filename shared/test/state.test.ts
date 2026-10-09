import assert from "node:assert/strict";
import test from "node:test";
import { saveMemory } from "../src/memory.js";
import { mapOpenAIRequest } from "../src/providers.js";
import {
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_VERSIONS,
  applyMemoryEditCommand,
  buildGuessFirstContinuation,
  createHistoryEntry,
  deleteHistoryEntry,
  pendingGuessFromResult,
  pruneHistoryEntries,
  readHistoryEntry,
  selectHistoryEntry,
  updateHistoryEntry,
  validateHistoryEntry,
  validateHistoryStore,
  validateHistoryVersion,
  validateMemoryEditCommand,
  validateWritingDraft,
  validateWritingRequestV2,
  writingRequestToPromptContext,
  type HistoryStore,
} from "../src/state.js";
import { loadV2Fixture } from "./helpers.js";

const fixture = loadV2Fixture();

test("상황 안내·첨부를 포함한 v2 요청 계약을 검증한다", () => {
  assert.equal(validateWritingRequestV2(fixture.writing_request), true);
  assert.equal(fixture.writing_request.context_note?.includes("협력사"), true);

  assert.equal(
    validateWritingRequestV2({
      ...fixture.writing_request,
      input: "",
      context_note: null,
      attachments: [],
    }),
    false,
  );
  assert.equal(
    validateHistoryEntry({
      ...fixture.history_entry,
      versions: fixture.history_entry.versions.map((version, index) => ({
        ...version,
        sequence: index === 0 ? 1 : 3,
      })),
    }),
    false,
  );
  assert.equal(
    validateWritingRequestV2({
      ...fixture.writing_request,
      mode: "guess_first",
      input: "",
      context_note: null,
      attachments: [],
    }),
    true,
  );
});

test("히스토리 항목은 재강화 버전과 현재 되돌리기 지점을 보존한다", () => {
  assert.equal(validateHistoryEntry(fixture.history_entry), true);
  assert.equal(fixture.history_entry.versions.length, 2);
  assert.equal(fixture.history_entry.active_version_id, "version_002");
  assert.ok(fixture.history_entry.versions.every(validateHistoryVersion));

  assert.equal(
    validateHistoryEntry({
      ...fixture.history_entry,
      active_version_id: "missing_version",
    }),
    false,
  );
  assert.equal(
    validateHistoryEntry({
      ...fixture.history_entry,
      versions: fixture.history_entry.versions.map((version) => ({
        ...version,
        sequence: 1,
      })),
    }),
    false,
  );
  assert.equal(
    validateHistoryEntry({
      ...fixture.history_entry,
      versions: Array.from(
        { length: MAX_HISTORY_VERSIONS + 1 },
        (_, index) => ({
          ...fixture.history_entry.versions[0],
          id: `version_${index}`,
          sequence: index + 1,
        }),
      ),
      active_version_id: "version_0",
    }),
    false,
  );
});

test("임시 저장 계약은 빈 초안도 허용하고 시간 역행·원본 blob은 거부한다", () => {
  assert.equal(validateWritingDraft(fixture.draft), true);
  assert.equal(
    validateWritingDraft({
      ...fixture.draft,
      input: "",
      context_note: null,
      attachments: [],
    }),
    true,
  );
  assert.equal(
    validateWritingDraft({
      ...fixture.draft,
      updated_at: "2026-07-28T11:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    validateWritingDraft({
      ...fixture.draft,
      attachments: [
        {
          ...fixture.draft.attachments[0],
          data_base64: "iVBORw0KGgo=",
        },
      ],
    }),
    false,
  );
});

test("사용자 기억 수정·삭제 계약을 검증하고 민감정보 저장은 계속 막는다", () => {
  assert.equal(validateMemoryEditCommand(fixture.memory_edits.update), true);
  assert.equal(validateMemoryEditCommand(fixture.memory_edits.delete), true);

  assert.equal(
    validateMemoryEditCommand({
      ...fixture.memory_edits.update,
      changes: {},
    }),
    false,
  );
  assert.equal(
    validateMemoryEditCommand({
      ...fixture.memory_edits.update,
      changes: {
        value: "연락처는 010-1234-5678이다.",
      },
    }),
    false,
  );
  assert.equal(
    validateMemoryEditCommand({
      ...fixture.memory_edits.delete,
      changes: { value: "삭제하면서 수정" },
    }),
    false,
  );
});

test("snake_case v2 요청을 단일 adapter로 PromptContext에 옮기고 2턴째 enhance로 전환한다", () => {
  const guessRequest = {
    ...fixture.writing_request,
    mode: "guess_first" as const,
  };
  const firstContext = writingRequestToPromptContext(guessRequest);
  assert.equal(firstContext.contextNote, guessRequest.context_note);
  assert.equal(firstContext.previousCompletedText, undefined);
  const firstEnvelope = mapOpenAIRequest({
    model: "fixed-openai-model",
    ...firstContext,
  });
  assert.equal(firstEnvelope.body.text.format.name, "writing_guess_first");

  const continuation = buildGuessFirstContinuation(
    guessRequest,
    fixture.guess_first_output,
    "알아서",
  );
  assert.equal(continuation.mode, "enhance");
  assert.match(
    continuation.feedback ?? "",
    new RegExp(fixture.guess_first_output.recommended_answer),
  );
  const secondEnvelope = mapOpenAIRequest({
    model: "fixed-openai-model",
    ...writingRequestToPromptContext(continuation),
  });
  assert.equal(secondEnvelope.body.text.format.name, "writing_enhancement");
  assert.match(
    secondEnvelope.body.input[1]?.content[0].text ?? "",
    /알아맞춰 봐 확인/,
  );
});

test("pending guess를 초안에 저장하며 enhance 전환 뒤에는 남겨두지 않는다", () => {
  const pending = pendingGuessFromResult(
    fixture.guess_first_output,
    "2026-07-28T12:10:00.000Z",
  );
  const waitingDraft = {
    ...fixture.draft,
    mode: "guess_first" as const,
    pending_guess: pending,
  };
  assert.equal(validateWritingDraft(waitingDraft), true);
  assert.equal(
    validateWritingDraft({ ...waitingDraft, mode: "enhance" }),
    false,
  );
  assert.equal(
    validateWritingDraft({
      ...waitingDraft,
      mode: "enhance",
      pending_guess: null,
    }),
    true,
  );
});

test("히스토리 store가 최대 수·prune·CRUD·선택을 불변 방식으로 처리한다", () => {
  const entries = Array.from(
    { length: MAX_HISTORY_ENTRIES + 1 },
    (_, index) => ({
      ...fixture.history_entry,
      id: `history_${index}`,
      title: `기록 ${index}`,
      updated_at: new Date(
        Date.parse("2026-07-28T12:02:00.000Z") + index * 1_000,
      ).toISOString(),
    }),
  );
  const pruned = pruneHistoryEntries(entries);
  assert.equal(pruned.length, MAX_HISTORY_ENTRIES);
  assert.equal(pruned[0]?.id, `history_${MAX_HISTORY_ENTRIES}`);
  assert.equal(pruned.some((entry) => entry.id === "history_0"), false);

  const empty: HistoryStore = {
    schema_version: 2,
    entries: [],
    selected_entry_id: null,
  };
  assert.equal(validateHistoryStore(empty), true);
  const created = createHistoryEntry(empty, fixture.history_entry);
  assert.equal(readHistoryEntry(created, fixture.history_entry.id)?.title, fixture.history_entry.title);
  assert.equal(created.selected_entry_id, fixture.history_entry.id);

  const updatedEntry = {
    ...fixture.history_entry,
    title: "수정된 기록",
    updated_at: "2026-07-28T12:20:00.000Z",
  };
  const updated = updateHistoryEntry(created, updatedEntry);
  assert.equal(readHistoryEntry(updated, updatedEntry.id)?.title, "수정된 기록");
  const deselected = selectHistoryEntry(updated, null);
  assert.equal(deselected.selected_entry_id, null);
  const selected = selectHistoryEntry(deselected, updatedEntry.id);
  assert.equal(selected.selected_entry_id, updatedEntry.id);
  const deleted = deleteHistoryEntry(selected, updatedEntry.id);
  assert.equal(deleted.entries.length, 0);
  assert.equal(deleted.selected_entry_id, null);
  assert.equal(created.entries[0]?.title, fixture.history_entry.title);
});

test("기억 수정은 최종 병합 카드를 민감검사한 뒤 update/delete를 원자 적용한다", () => {
  const base = saveMemory(
    [],
    {
      type: "context_fact",
      value: "연락처 010-1234",
      scope: "업무 연락",
      confidence: 0.9,
      source: "explicit",
      conflict_key: null,
      keywords: ["연락"],
    },
    {
      now: new Date("2026-07-28T09:00:00.000Z"),
      idFactory: () => "memory_atomic",
      provenance: { origin: "user_input" },
    },
  );
  assert.ok(base.card);
  const before = structuredClone(base.cards);
  const unsafe = applyMemoryEditCommand(base.cards, {
    schema_version: 2,
    operation: "update",
    memory_id: "memory_atomic",
    changes: { scope: "5678 관련" },
    edited_at: "2026-07-28T10:00:00.000Z",
  });
  assert.equal(unsafe.status, "rejected");
  assert.equal(unsafe.reason, "unsafe_final_card");
  assert.deepEqual(base.cards, before);
  assert.deepEqual(unsafe.cards, before);

  const updated = applyMemoryEditCommand(base.cards, {
    schema_version: 2,
    operation: "update",
    memory_id: "memory_atomic",
    changes: { value: "협력사에는 업무 시간에 연락한다." },
    edited_at: "2026-07-28T10:00:00.000Z",
  });
  assert.equal(updated.status, "updated");
  assert.equal(updated.card?.source, "explicit");
  assert.equal(base.cards[0]?.value, "연락처 010-1234");

  const deleted = applyMemoryEditCommand(updated.cards, {
    schema_version: 2,
    operation: "delete",
    memory_id: "memory_atomic",
    edited_at: "2026-07-28T11:00:00.000Z",
  });
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.cards.length, 0);
});
