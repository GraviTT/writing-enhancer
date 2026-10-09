import { readFileSync } from "node:fs";
import type {
  EnhancementResult,
  GuessFirstResult,
  MemoryCandidate,
} from "../src/contracts.js";
import type { WritingRequestV2, HistoryEntry, WritingDraft, MemoryEditCommand } from "../src/state.js";

export interface KoreanFixture {
  enhancement_cases: Array<{
    id: string;
    kind: string;
    input: string;
    mock_output: EnhancementResult;
  }>;
  memory_conflict: {
    old: MemoryCandidate;
    new: MemoryCandidate;
  };
}

export function loadKoreanFixture(): KoreanFixture {
  const path = new URL("./fixtures/korean-cases.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as KoreanFixture;
}

export interface V2Fixture {
  writing_request: WritingRequestV2;
  guess_first_output: GuessFirstResult;
  history_entry: HistoryEntry;
  draft: WritingDraft;
  memory_edits: {
    update: MemoryEditCommand;
    delete: MemoryEditCommand;
  };
}

export function loadV2Fixture(): V2Fixture {
  const path = new URL("./fixtures/v2-cases.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as V2Fixture;
}
