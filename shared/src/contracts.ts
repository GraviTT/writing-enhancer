export const MEMORY_CANDIDATE_TYPES = [
  "style_rule",
  "context_fact",
  "relationship",
  "workflow_rule",
] as const;

export const MEMORY_SOURCES = ["explicit", "repeated", "inferred"] as const;
export const WRITING_MODES = ["enhance", "guess_first"] as const;

export type MemoryCandidateType = (typeof MEMORY_CANDIDATE_TYPES)[number];
export type MemorySource = (typeof MEMORY_SOURCES)[number];
export type WritingMode = (typeof WRITING_MODES)[number];

export interface MemoryCandidate {
  type: MemoryCandidateType;
  value: string;
  scope: string;
  confidence: number;
  source: MemorySource;
  conflict_key: string | null;
  keywords: string[];
}

export interface EnhancementResult {
  completed_text: string;
  assumption: string;
  follow_up: string;
  memory_candidates: MemoryCandidate[];
}

/**
 * The opt-in "알아맞춰 봐" response. A single string (rather than an array)
 * makes the one-question-per-turn behavior part of the data contract.
 * `recommended_answer` is what the app sends when the user chooses "알아서".
 */
export interface GuessFirstResult {
  question: string;
  recommended_answer: string;
  assumption: string;
  memory_candidates: MemoryCandidate[];
}

export type WritingResult = EnhancementResult | GuessFirstResult;

export const memoryCandidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "value",
    "scope",
    "confidence",
    "source",
    "conflict_key",
    "keywords",
  ],
  properties: {
    type: {
      type: "string",
      enum: [...MEMORY_CANDIDATE_TYPES],
    },
    value: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "다음 작업에도 재사용할 수 있는 최소 판단 단위",
    },
    scope: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "이 기억이 적용되는 상황",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    source: {
      type: "string",
      enum: [...MEMORY_SOURCES],
    },
    conflict_key: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 120 },
        { type: "null" },
      ],
      description: "같은 결정 축의 이전 기억을 대체할 때 쓰는 안정된 키",
    },
    keywords: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
  },
} as const;

/**
 * Shared by both provider request mappers. It deliberately contains no
 * provider-specific keywords.
 */
export const enhancementResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "completed_text",
    "assumption",
    "follow_up",
    "memory_candidates",
  ],
  properties: {
    completed_text: {
      type: "string",
      minLength: 1,
      description: "사용자에게 가장 먼저 보여 줄, 바로 사용 가능한 완성문",
    },
    assumption: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "완성에 사용한 가장 중요한 상황/의도 추론 한 문장",
    },
    follow_up: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description:
        "AI의 추천 판단을 포함한 한 가지 후속 질문. 사용자는 '알아서'라고 답할 수 있어야 함",
    },
    memory_candidates: {
      type: "array",
      maxItems: 3,
      items: memoryCandidateJsonSchema,
    },
  },
} as const;

export const guessFirstResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "question",
    "recommended_answer",
    "assumption",
    "memory_candidates",
  ],
  properties: {
    question: {
      type: "string",
      minLength: 2,
      maxLength: 240,
      pattern: "^[^?]*\\?$",
      description: "사용자가 쉽게 답할 수 있는 단 하나의 짧은 질문",
    },
    recommended_answer: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "사용자가 '알아서'를 누를 때 적용할 AI의 추천 답",
    },
    assumption: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "현재 정보로 AI가 가장 가능성이 높다고 본 상황",
    },
    memory_candidates: {
      type: "array",
      maxItems: 3,
      items: memoryCandidateJsonSchema,
    },
  },
} as const;

export type WritingResponseJsonSchema =
  | typeof enhancementResponseJsonSchema
  | typeof guessFirstResponseJsonSchema;

export function responseJsonSchemaForMode(
  mode: WritingMode = "enhance",
): WritingResponseJsonSchema {
  return mode === "guess_first"
    ? guessFirstResponseJsonSchema
    : enhancementResponseJsonSchema;
}

export class ContractValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid enhancement result: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  minLength = 1,
  maxLength = Number.POSITIVE_INFINITY,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= minLength &&
    value.length <= maxLength
  );
}

export function validateMemoryCandidate(
  value: unknown,
): value is MemoryCandidate {
  if (!isRecord(value)) return false;
  const candidateKeys = new Set([
    "type",
    "value",
    "scope",
    "confidence",
    "source",
    "conflict_key",
    "keywords",
  ]);
  if (Object.keys(value).some((key) => !candidateKeys.has(key))) {
    return false;
  }

  return (
    MEMORY_CANDIDATE_TYPES.includes(value.type as MemoryCandidateType) &&
    isBoundedString(value.value, 1, 240) &&
    isBoundedString(value.scope, 1, 80) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    MEMORY_SOURCES.includes(value.source as MemorySource) &&
    (value.conflict_key === null ||
      isBoundedString(value.conflict_key, 1, 120)) &&
    Array.isArray(value.keywords) &&
    value.keywords.length <= 8 &&
    value.keywords.every((keyword) => isBoundedString(keyword, 1, 40))
  );
}

function validateMemoryCandidates(value: unknown): value is MemoryCandidate[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every(validateMemoryCandidate)
  );
}

export function validateEnhancementResult(
  value: unknown,
): value is EnhancementResult {
  if (!isRecord(value)) return false;

  const allowedKeys = new Set([
    "completed_text",
    "assumption",
    "follow_up",
    "memory_candidates",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;

  if (!isBoundedString(value.completed_text)) return false;
  if (!isBoundedString(value.assumption, 1, 240)) return false;
  if (!isBoundedString(value.follow_up, 1, 240)) return false;
  return validateMemoryCandidates(value.memory_candidates);
}

export function validateGuessFirstResult(
  value: unknown,
): value is GuessFirstResult {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "question",
    "recommended_answer",
    "assumption",
    "memory_candidates",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;

  if (!isBoundedString(value.question, 2, 240)) return false;
  const questionMarks = [...value.question].filter((character) => character === "?");
  if (questionMarks.length !== 1 || !value.question.trimEnd().endsWith("?")) {
    return false;
  }
  if (!isBoundedString(value.recommended_answer, 1, 240)) return false;
  if (value.recommended_answer.includes("?")) return false;
  if (!isBoundedString(value.assumption, 1, 240)) return false;
  return validateMemoryCandidates(value.memory_candidates);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

export function parseEnhancementResult(
  input: string | unknown,
): EnhancementResult {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(stripCodeFence(input));
    } catch {
      throw new ContractValidationError(["response is not valid JSON"]);
    }
  }

  if (!validateEnhancementResult(value)) {
    throw new ContractValidationError([
      "response does not match the provider-neutral schema",
    ]);
  }
  return value;
}

export function parseGuessFirstResult(
  input: string | unknown,
): GuessFirstResult {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(stripCodeFence(input));
    } catch {
      throw new ContractValidationError(["response is not valid JSON"]);
    }
  }

  if (!validateGuessFirstResult(value)) {
    throw new ContractValidationError([
      "response does not match the guess-first schema",
    ]);
  }
  return value;
}

export function parseWritingResult(
  input: string | unknown,
  mode: WritingMode = "enhance",
): WritingResult {
  return mode === "guess_first"
    ? parseGuessFirstResult(input)
    : parseEnhancementResult(input);
}
