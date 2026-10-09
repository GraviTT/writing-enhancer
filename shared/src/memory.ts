import {
  MEMORY_CANDIDATE_TYPES,
  MEMORY_SOURCES,
  type MemoryCandidate,
  type MemoryCandidateType,
  type MemorySource,
} from "./contracts.js";
import { isMemorySafe } from "./sensitive.js";

export const MAX_MEMORY_CARDS = 50;
export const MAX_RETRIEVED_MEMORIES = 5;
export const MAX_MEMORY_PROMPT_CHARS = 1_200;
export const MAX_MEMORY_PROMPT_ESTIMATED_TOKENS = 600;

export const MEMORY_PROVENANCE_ORIGINS = [
  "user_input",
  "user_feedback",
  "user_edit",
  "repeated_observation",
  "attachment",
  "model_inference",
] as const;

export type MemoryProvenanceOrigin =
  (typeof MEMORY_PROVENANCE_ORIGINS)[number];

export interface MemoryCandidateProvenance {
  origin: MemoryProvenanceOrigin;
  userConfirmed?: boolean;
}

export const MEMORY_RETENTIONS = [
  "session",
  "temporary",
  "long_term",
] as const;

export type MemoryRetention = (typeof MEMORY_RETENTIONS)[number];

export interface MemoryCard {
  id: string;
  type: MemoryCandidateType;
  value: string;
  scope: string;
  keywords: string[];
  confidence: number;
  source: MemorySource;
  conflictKey: string | null;
  retention: MemoryRetention;
  evidenceCount: number;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastDecayedAt: string;
  expiresAt: string | null;
}

export const memoryCardJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "type",
    "value",
    "scope",
    "keywords",
    "confidence",
    "source",
    "conflictKey",
    "retention",
    "evidenceCount",
    "useCount",
    "createdAt",
    "updatedAt",
    "lastUsedAt",
    "lastDecayedAt",
    "expiresAt",
  ],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 120,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    },
    type: { type: "string", enum: [...MEMORY_CANDIDATE_TYPES] },
    value: { type: "string", minLength: 1, maxLength: 240 },
    scope: { type: "string", minLength: 1, maxLength: 80 },
    keywords: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    source: { type: "string", enum: [...MEMORY_SOURCES] },
    conflictKey: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 120 },
        { type: "null" },
      ],
    },
    retention: { type: "string", enum: [...MEMORY_RETENTIONS] },
    evidenceCount: { type: "integer", minimum: 1 },
    useCount: { type: "integer", minimum: 0 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    lastUsedAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    lastDecayedAt: { type: "string", format: "date-time" },
    expiresAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
} as const;

export interface SaveMemoryOptions {
  now?: Date;
  idFactory?: () => string;
  /**
   * Must be derived by the application from the actual input channel. The
   * model-provided candidate.source is never sufficient provenance by itself.
   */
  provenance?: MemoryCandidateProvenance;
}

export interface SaveMemoryResult {
  status: "saved" | "merged" | "rejected";
  cards: MemoryCard[];
  card: MemoryCard | null;
  reason: string | null;
  supersededIds: string[];
}

const GENERIC_VALUES = new Set([
  "좋아",
  "싫어",
  "몰라",
  "그냥",
  "알아서",
  "네",
  "아니요",
  "감사",
]);

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toIso(now: Date): string {
  return now.toISOString();
}

function addMilliseconds(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function makeId(now: Date): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `mem_${now.getTime().toString(36)}_${suffix}`;
}

function retentionFor(
  type: MemoryCandidateType,
  source: MemorySource,
): { retention: MemoryRetention; expiresAfterMs: number | null } {
  if (source === "inferred") {
    return { retention: "session", expiresAfterMs: 8 * 60 * 60 * 1_000 };
  }
  if (type === "context_fact") {
    return {
      retention: "temporary",
      expiresAfterMs:
        source === "repeated"
          ? 90 * 24 * 60 * 60 * 1_000
          : 30 * 24 * 60 * 60 * 1_000,
    };
  }
  return { retention: "long_term", expiresAfterMs: null };
}

function sourceRank(source: MemorySource): number {
  if (source === "explicit") return 3;
  if (source === "repeated") return 2;
  return 1;
}

function candidateWithVerifiedProvenance(
  candidate: MemoryCandidate,
  provenance: MemoryCandidateProvenance | undefined,
): {
  candidate: MemoryCandidate;
  allowInferredPromotion: boolean;
} {
  const origin = provenance?.origin ?? "model_inference";
  const userConfirmed = provenance?.userConfirmed === true;
  let source: MemorySource;
  if (
    userConfirmed ||
    origin === "user_input" ||
    origin === "user_feedback" ||
    origin === "user_edit"
  ) {
    source = "explicit";
  } else if (origin === "repeated_observation") {
    source = "repeated";
  } else {
    source = "inferred";
  }
  return {
    candidate: { ...candidate, source },
    allowInferredPromotion:
      userConfirmed ||
      origin === "user_input" ||
      origin === "user_feedback" ||
      origin === "user_edit" ||
      origin === "repeated_observation",
  };
}

function retentionRank(retention: MemoryRetention): number {
  if (retention === "long_term") return 3;
  if (retention === "temporary") return 2;
  return 1;
}

function deduplicateKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    const key = normalize(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed.slice(0, 40));
    if (result.length === 8) break;
  }
  return result;
}

function isExactMatch(card: MemoryCard, candidate: MemoryCandidate): boolean {
  return (
    card.type === candidate.type &&
    normalize(card.scope) === normalize(candidate.scope) &&
    normalize(card.value) === normalize(candidate.value)
  );
}

function createCard(
  candidate: MemoryCandidate,
  now: Date,
  idFactory: () => string,
): MemoryCard {
  const policy = retentionFor(candidate.type, candidate.source);
  const timestamp = toIso(now);
  return {
    id: idFactory(),
    type: candidate.type,
    value: candidate.value.trim(),
    scope: candidate.scope.trim(),
    keywords: deduplicateKeywords(candidate.keywords),
    confidence: candidate.confidence,
    source: candidate.source,
    conflictKey: candidate.conflict_key,
    retention: policy.retention,
    evidenceCount: 1,
    useCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: null,
    lastDecayedAt: timestamp,
    expiresAt:
      policy.expiresAfterMs === null
        ? null
        : addMilliseconds(now, policy.expiresAfterMs),
  };
}

export function mergeMemoryCard(
  existing: MemoryCard,
  candidate: MemoryCandidate,
  now = new Date(),
  options: { allowInferredPromotion?: boolean } = {},
): MemoryCard {
  const evidenceCount = existing.evidenceCount + 1;
  const source: MemorySource =
    sourceRank(candidate.source) > sourceRank(existing.source)
      ? candidate.source
      : existing.source === "inferred" &&
          evidenceCount >= 2 &&
          options.allowInferredPromotion !== false
        ? "repeated"
        : existing.source;
  const policy = retentionFor(existing.type, source);
  const timestamp = toIso(now);

  return {
    ...existing,
    value:
      sourceRank(candidate.source) >= sourceRank(existing.source)
        ? candidate.value.trim()
        : existing.value,
    scope:
      sourceRank(candidate.source) >= sourceRank(existing.source)
        ? candidate.scope.trim()
        : existing.scope,
    keywords: deduplicateKeywords([
      ...existing.keywords,
      ...candidate.keywords,
    ]),
    confidence: Math.min(
      1,
      Math.max(existing.confidence, candidate.confidence) +
        Math.min(0.08, evidenceCount * 0.01),
    ),
    source,
    conflictKey: candidate.conflict_key ?? existing.conflictKey,
    retention: policy.retention,
    evidenceCount,
    updatedAt: timestamp,
    lastDecayedAt: timestamp,
    expiresAt:
      policy.expiresAfterMs === null
        ? null
        : addMilliseconds(now, policy.expiresAfterMs),
  };
}

function budgetScore(card: MemoryCard, now: Date): number {
  const ageDays = Math.max(
    0,
    (now.getTime() - new Date(card.updatedAt).getTime()) /
      (24 * 60 * 60 * 1_000),
  );
  return (
    retentionRank(card.retention) * 10 +
    sourceRank(card.source) * 4 +
    card.confidence * 5 +
    Math.log1p(card.useCount) -
    ageDays / 365
  );
}

export function enforceMemoryBudget(
  cards: readonly MemoryCard[],
  now = new Date(),
  limit = MAX_MEMORY_CARDS,
): MemoryCard[] {
  const boundedLimit = Math.max(0, Math.min(limit, MAX_MEMORY_CARDS));
  return [...cards]
    .sort((left, right) => {
      const difference = budgetScore(right, now) - budgetScore(left, now);
      return difference || right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, boundedLimit);
}

export function saveMemory(
  cards: readonly MemoryCard[],
  candidate: MemoryCandidate,
  options: SaveMemoryOptions = {},
): SaveMemoryResult {
  const now = options.now ?? new Date();
  const idFactory = options.idFactory ?? (() => makeId(now));
  const verified = candidateWithVerifiedProvenance(
    candidate,
    options.provenance,
  );
  const effectiveCandidate = verified.candidate;
  const value = effectiveCandidate.value.trim();
  const normalizedValue = normalize(value);

  if (!value || GENERIC_VALUES.has(normalizedValue)) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "not_reusable",
      supersededIds: [],
    };
  }
  if (
    !isMemorySafe(
      effectiveCandidate.value,
      effectiveCandidate.scope,
      effectiveCandidate.keywords,
    )
  ) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "sensitive_information",
      supersededIds: [],
    };
  }
  if (
    effectiveCandidate.source === "inferred" &&
    effectiveCandidate.confidence < 0.78
  ) {
    return {
      status: "rejected",
      cards: [...cards],
      card: null,
      reason: "low_confidence_inference",
      supersededIds: [],
    };
  }

  const exact = cards.find((card) =>
    isExactMatch(card, effectiveCandidate),
  );
  if (exact) {
    const merged = mergeMemoryCard(exact, effectiveCandidate, now, {
      allowInferredPromotion: verified.allowInferredPromotion,
    });
    const next = cards.map((card) => (card.id === exact.id ? merged : card));
    return {
      status: "merged",
      cards: enforceMemoryBudget(next, now),
      card: merged,
      reason: null,
      supersededIds: [],
    };
  }

  const conflicts =
    effectiveCandidate.conflict_key === null
      ? []
      : cards.filter(
          (card) =>
            card.conflictKey === effectiveCandidate.conflict_key &&
            normalize(card.value) !== normalizedValue,
        );

  if (conflicts.length > 0) {
    const strongest = conflicts.sort(
      (left, right) => sourceRank(right.source) - sourceRank(left.source),
    )[0];
    if (
      effectiveCandidate.source === "inferred" ||
      (strongest?.source === "explicit" &&
        effectiveCandidate.source !== "explicit")
    ) {
      return {
        status: "rejected",
        cards: [...cards],
        card: null,
        reason: "conflicts_with_stronger_memory",
        supersededIds: [],
      };
    }
  }

  const supersededIds = conflicts.map((card) => card.id);
  const remaining = cards.filter((card) => !supersededIds.includes(card.id));
  const created = createCard(effectiveCandidate, now, idFactory);
  return {
    status: "saved",
    cards: enforceMemoryBudget([...remaining, created], now),
    card: created,
    reason: null,
    supersededIds,
  };
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateMemoryCard(value: unknown): value is MemoryCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const card = value as Partial<MemoryCard>;
  return (
    typeof card.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(card.id) &&
    MEMORY_CANDIDATE_TYPES.includes(card.type as MemoryCandidateType) &&
    typeof card.value === "string" &&
    card.value.trim().length > 0 &&
    card.value.length <= 240 &&
    typeof card.scope === "string" &&
    card.scope.trim().length > 0 &&
    card.scope.length <= 80 &&
    Array.isArray(card.keywords) &&
    card.keywords.length <= 8 &&
    card.keywords.every(
      (keyword) =>
        typeof keyword === "string" &&
        keyword.trim().length > 0 &&
        keyword.length <= 40,
    ) &&
    typeof card.confidence === "number" &&
    card.confidence >= 0 &&
    card.confidence <= 1 &&
    MEMORY_SOURCES.includes(card.source as MemorySource) &&
    (card.conflictKey === null ||
      (typeof card.conflictKey === "string" &&
        card.conflictKey.trim().length > 0 &&
        card.conflictKey.length <= 120)) &&
    MEMORY_RETENTIONS.includes(card.retention as MemoryRetention) &&
    Number.isInteger(card.evidenceCount) &&
    (card.evidenceCount ?? 0) >= 1 &&
    Number.isInteger(card.useCount) &&
    (card.useCount ?? -1) >= 0 &&
    isValidDateString(card.createdAt) &&
    isValidDateString(card.updatedAt) &&
    (card.lastUsedAt === null || isValidDateString(card.lastUsedAt)) &&
    isValidDateString(card.lastDecayedAt) &&
    (card.expiresAt === null || isValidDateString(card.expiresAt))
  );
}

const DECAY_HALF_LIFE_DAYS: Record<MemoryRetention, number> = {
  session: 1,
  temporary: 45,
  long_term: 540,
};

export function decayMemories(
  cards: readonly MemoryCard[],
  now = new Date(),
): MemoryCard[] {
  const timestamp = toIso(now);
  return cards.flatMap((card) => {
    if (
      card.expiresAt !== null &&
      Date.parse(card.expiresAt) <= now.getTime()
    ) {
      return [];
    }
    const elapsedDays = Math.max(
      0,
      (now.getTime() - Date.parse(card.lastDecayedAt)) /
        (24 * 60 * 60 * 1_000),
    );
    const decayFactor = 0.5 ** (
      elapsedDays / DECAY_HALF_LIFE_DAYS[card.retention]
    );
    const confidence = Math.max(0, Math.min(1, card.confidence * decayFactor));
    if (confidence < 0.2 && card.retention !== "long_term") return [];
    return [{ ...card, confidence, lastDecayedAt: timestamp }];
  });
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function isGlobalScope(scope: string): boolean {
  const normalizedScope = normalize(scope);
  return [
    "global",
    "general",
    "all",
    "전체",
    "전역",
    "모든 글",
  ].includes(normalizedScope);
}

function relevanceScore(
  card: MemoryCard,
  query: string,
  now: Date,
): number | null {
  const queryNormalized = normalize(query);
  const queryTokens = new Set(tokens(query));
  const searchable = normalize(
    [card.scope, card.value, ...card.keywords].join(" "),
  );
  const searchableTokens = tokens(searchable);
  let lexical = 0;
  for (const token of queryTokens) {
    if (
      searchableTokens.some(
        (candidate) =>
          candidate.includes(token) || token.includes(candidate),
      )
    ) {
      lexical += 1;
    }
  }
  if (queryNormalized && searchable.includes(queryNormalized)) lexical += 3;
  if (lexical === 0 && !isGlobalScope(card.scope)) return null;

  const lastActivity = Date.parse(card.lastUsedAt ?? card.updatedAt);
  const ageDays = Math.max(
    0,
    (now.getTime() - lastActivity) / (24 * 60 * 60 * 1_000),
  );
  const recency = 1 / (1 + ageDays / 30);
  return (
    lexical * 5 +
    card.confidence * 3 +
    recency +
    Math.log1p(card.useCount) * 0.25 +
    retentionRank(card.retention) * 0.1
  );
}

export function retrieveMemories(
  cards: readonly MemoryCard[],
  query: string,
  now = new Date(),
  limit = MAX_RETRIEVED_MEMORIES,
): MemoryCard[] {
  const boundedLimit = Math.max(
    0,
    Math.min(limit, MAX_RETRIEVED_MEMORIES),
  );
  const active = decayMemories(cards, now);
  return active
    .map((card) => ({ card, score: relevanceScore(card, query, now) }))
    .filter(
      (
        entry,
      ): entry is {
        card: MemoryCard;
        score: number;
      } => entry.score !== null,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.card.updatedAt.localeCompare(left.card.updatedAt),
    )
    .slice(0, boundedLimit)
    .map(({ card }) => card);
}

export function markMemoriesUsed(
  cards: readonly MemoryCard[],
  usedIds: readonly string[],
  now = new Date(),
): MemoryCard[] {
  const ids = new Set(usedIds);
  const timestamp = toIso(now);
  return cards.map((card) =>
    ids.has(card.id)
      ? { ...card, useCount: card.useCount + 1, lastUsedAt: timestamp }
      : card,
  );
}
