"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_MEMORIES = 50;
const MAX_RETRIEVED = 5;
const VALID_TYPES = new Set(["style_rule", "context_fact", "relationship", "workflow_rule"]);
const VALID_SOURCES = new Set(["explicit", "repeated", "inferred"]);
const DAY_MS = 86_400_000;

const SENSITIVE_PATTERNS = [
  /(?:비밀\s*번호|패스워드|password|passwd|api[\s_-]*key|secret|access[\s_-]*token|refresh[\s_-]*token|otp|인증\s*번호)/iu,
  /\b\d{6}-?[1-4]\d{6}\b/u,
  /(?:\d[ -]?){13,19}/u,
  /(?:계좌\s*번호|카드\s*번호|주민\s*등록|여권\s*번호|운전\s*면허|보안\s*코드|cvc|cvv)/iu,
  /(?:질환|진단|처방|복용|병력|정신\s*건강|혈액형|보험\s*번호)/iu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}/u
];

const HALF_LIFE_DAYS = {
  session: 1,
  temporary: 45,
  long_term: 540
};

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsSensitiveInfo(...values) {
  const text = normalizeText(values.filter(Boolean).join(" "));
  return !text || SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function tokenize(value) {
  const words = normalizeKey(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length > 1))];
}

function lexicalScore(queryTokens, card) {
  if (queryTokens.length === 0) {
    return 0;
  }

  const cardTokens = new Set(
    tokenize(`${card.scope} ${card.type} ${card.value} ${(card.keywords || []).join(" ")}`)
  );
  let hits = 0;
  for (const queryToken of queryTokens) {
    if (
      [...cardTokens].some(
        (cardToken) => cardToken.includes(queryToken) || queryToken.includes(cardToken)
      )
    ) {
      hits += 1;
    }
  }
  return hits / Math.sqrt(queryTokens.length * Math.max(cardTokens.size, 1));
}

function sourceRank(source) {
  if (source === "explicit") return 3;
  if (source === "repeated") return 2;
  return 1;
}

function retentionRank(retention) {
  if (retention === "long_term") return 3;
  if (retention === "temporary") return 2;
  return 1;
}

function retentionPolicy(type, source, now) {
  if (source === "inferred") {
    return {
      retention: "session",
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1_000).toISOString()
    };
  }
  if (type === "context_fact") {
    const days = source === "repeated" ? 90 : 30;
    return {
      retention: "temporary",
      expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString()
    };
  }
  return { retention: "long_term", expiresAt: null };
}

function normalizeKeywords(keywords) {
  const result = [];
  const seen = new Set();
  for (const rawKeyword of Array.isArray(keywords) ? keywords : []) {
    const keyword = normalizeText(rawKeyword).slice(0, 40);
    const key = normalizeKey(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length === 8) break;
  }
  return result;
}

function budgetScore(card, now) {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(card.updatedAt)) / DAY_MS);
  return (
    retentionRank(card.retention) * 10 +
    sourceRank(card.source) * 4 +
    card.confidence * 5 +
    Math.log1p(card.useCount || 0) -
    ageDays / 365
  );
}

class MemoryStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxMemories = Math.min(options.maxMemories ?? MAX_MEMORIES, MAX_MEMORIES);
    this.memories = this.#read();
    this.#decayAndPrune(new Date(), false);
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.slice(0, this.maxMemories) : [];
    } catch {
      return [];
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.memories, null, 2), "utf8");
  }

  #decayAndPrune(now, persist = true) {
    const before = JSON.stringify(this.memories);
    this.memories = this.memories.flatMap((card) => {
      if (card.expiresAt && Date.parse(card.expiresAt) <= now.getTime()) {
        return [];
      }

      const retention = card.retention || "temporary";
      const previousDecay = Date.parse(card.lastDecayedAt || card.updatedAt || card.createdAt);
      const elapsedDays = Math.max(0, (now.getTime() - previousDecay) / DAY_MS);
      const halfLife = HALF_LIFE_DAYS[retention] || HALF_LIFE_DAYS.temporary;
      const confidence = Math.max(0, Math.min(1, card.confidence * 0.5 ** (elapsedDays / halfLife)));
      if (confidence < 0.2 && retention !== "long_term") {
        return [];
      }

      return [
        {
          ...card,
          confidence,
          lastDecayedAt: now.toISOString()
        }
      ];
    });

    if (persist && before !== JSON.stringify(this.memories)) {
      this.#write();
    }
  }

  #enforceBudget(now) {
    this.memories = this.memories
      .sort((left, right) => {
        const difference = budgetScore(right, now) - budgetScore(left, now);
        return difference || String(right.updatedAt).localeCompare(String(left.updatedAt));
      })
      .slice(0, this.maxMemories);
  }

  list() {
    this.#decayAndPrune(new Date());
    return this.memories.map((card) => ({ ...card, keywords: [...(card.keywords || [])] }));
  }

  search(query, limit = MAX_RETRIEVED) {
    const now = new Date();
    this.#decayAndPrune(now, false);
    const queryTokens = tokenize(query);
    const normalizedQuery = normalizeKey(query);

    const matches = this.memories
      .map((card) => {
        const lexical = lexicalScore(queryTokens, card);
        const lastActivity = Date.parse(card.lastUsedAt || card.updatedAt);
        const ageDays = Math.max(0, (now.getTime() - lastActivity) / DAY_MS);
        const recency = 1 / (1 + ageDays / 30);
        const scopeBoost =
          card.scope && normalizedQuery.includes(normalizeKey(card.scope)) ? 0.45 : 0;
        const globalScope = ["general", "global", "전체", "모든 글"].includes(
          normalizeKey(card.scope)
        );
        if (lexical === 0 && !scopeBoost && !globalScope) {
          return { card, score: -1 };
        }
        const score =
          lexical * 5 +
          scopeBoost +
          card.confidence * 0.8 +
          recency * 0.3 +
          Math.log1p(card.useCount || 0) * 0.08;
        return { card, score };
      })
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(limit, MAX_RETRIEVED));

    const usedIds = new Set(matches.map(({ card }) => card.id));
    if (usedIds.size > 0) {
      const timestamp = now.toISOString();
      this.memories = this.memories.map((card) =>
        usedIds.has(card.id)
          ? { ...card, useCount: (card.useCount || 0) + 1, lastUsedAt: timestamp }
          : card
      );
      this.#write();
    }

    return matches.map(({ card }) => ({ ...card, keywords: [...(card.keywords || [])] }));
  }

  addCandidates(candidates) {
    const now = new Date();
    this.#decayAndPrune(now, false);
    const addedIds = [];
    const accepted = Array.isArray(candidates) ? candidates.slice(0, 3) : [];
    let changed = false;

    for (const candidate of accepted) {
      const value = normalizeText(candidate?.value);
      const type = normalizeText(candidate?.type);
      const scope = normalizeText(candidate?.scope) || "general";
      const source = VALID_SOURCES.has(candidate?.source) ? candidate.source : "inferred";
      const confidence = Number(candidate?.confidence);
      const conflictKey = candidate?.conflict_key
        ? normalizeText(candidate.conflict_key).slice(0, 120)
        : null;
      const keywords = normalizeKeywords(candidate?.keywords);

      if (
        !VALID_TYPES.has(type) ||
        value.length < 5 ||
        value.length > 240 ||
        scope.length > 80 ||
        containsSensitiveInfo(value, scope, keywords.join(" ")) ||
        !Number.isFinite(confidence) ||
        confidence < (source === "inferred" ? 0.78 : 0.72)
      ) {
        continue;
      }

      const exact = this.memories.find(
        (card) =>
          card.type === type &&
          normalizeKey(card.scope) === normalizeKey(scope) &&
          normalizeKey(card.value) === normalizeKey(value)
      );

      if (exact) {
        const evidenceCount = (exact.evidenceCount || 1) + 1;
        const mergedSource =
          sourceRank(source) > sourceRank(exact.source)
            ? source
            : exact.source;
        const policy = retentionPolicy(type, mergedSource, now);
        exact.source = mergedSource;
        exact.sourceKind = mergedSource;
        exact.evidenceCount = evidenceCount;
        exact.confidence = Math.min(
          1,
          Math.max(exact.confidence, confidence) + Math.min(0.08, evidenceCount * 0.01)
        );
        exact.keywords = normalizeKeywords([...(exact.keywords || []), ...keywords]);
        exact.updatedAt = now.toISOString();
        exact.lastDecayedAt = now.toISOString();
        exact.retention = policy.retention;
        exact.expiresAt = policy.expiresAt;
        changed = true;
        continue;
      }

      const conflicts = conflictKey
        ? this.memories.filter(
            (card) =>
              card.conflictKey === conflictKey && normalizeKey(card.value) !== normalizeKey(value)
          )
        : [];
      const strongestConflict = conflicts.sort(
        (left, right) => sourceRank(right.source) - sourceRank(left.source)
      )[0];
      if (
        source === "inferred" ||
        (strongestConflict?.source === "explicit" && source !== "explicit")
      ) {
        if (conflicts.length > 0) {
          continue;
        }
      }

      if (conflicts.length > 0) {
        const conflictingIds = new Set(conflicts.map((card) => card.id));
        this.memories = this.memories.filter((card) => !conflictingIds.has(card.id));
      }

      const policy = retentionPolicy(type, source, now);
      const timestamp = now.toISOString();
      const id = crypto.randomUUID();
      this.memories.push({
        id,
        type,
        scope,
        value,
        keywords,
        confidence: Math.min(confidence, 1),
        source,
        sourceKind: source,
        conflictKey,
        retention: policy.retention,
        evidenceCount: 1,
        useCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastUsedAt: null,
        lastDecayedAt: timestamp,
        expiresAt: policy.expiresAt
      });
      addedIds.push(id);
      changed = true;
    }

    if (changed) {
      this.#enforceBudget(now);
      this.#write();
    }

    return addedIds;
  }

  remove(ids) {
    const targets = new Set(Array.isArray(ids) ? ids : [ids]);
    const previousLength = this.memories.length;
    this.memories = this.memories.filter((card) => !targets.has(card.id));
    if (this.memories.length !== previousLength) {
      this.#write();
    }
    return previousLength - this.memories.length;
  }

  update(id, changes) {
    const index = this.memories.findIndex((card) => card.id === id);
    if (index < 0) {
      const error = new Error("수정할 기억을 찾지 못했습니다.");
      error.code = "MEMORY_NOT_FOUND";
      throw error;
    }

    const previous = this.memories[index];
    const value = normalizeText(changes?.value ?? previous.value);
    const scope = normalizeText(changes?.scope ?? previous.scope) || "general";
    const keywords = normalizeKeywords(changes?.keywords ?? previous.keywords);
    if (
      value.length < 5 ||
      value.length > 240 ||
      scope.length > 80 ||
      containsSensitiveInfo(value, scope, keywords.join(" "))
    ) {
      const error = new Error("기억은 5~240자의 민감하지 않은 내용으로 적어 주세요.");
      error.code = "INVALID_MEMORY";
      throw error;
    }

    const now = new Date();
    const policy = retentionPolicy(previous.type, "explicit", now);
    const duplicates = this.memories.filter((card) => {
      if (card.id === id) return false;
      const sameConflict =
        previous.conflictKey && card.conflictKey === previous.conflictKey;
      const sameEditedValue =
        card.type === previous.type &&
        normalizeKey(card.scope) === normalizeKey(scope) &&
        normalizeKey(card.value) === normalizeKey(value);
      return sameConflict || sameEditedValue;
    });
    const duplicateIds = new Set(duplicates.map((card) => card.id));
    const mergedKeywords = normalizeKeywords([
      ...keywords,
      ...duplicates.flatMap((card) => card.keywords || [])
    ]);
    const updated = {
      ...previous,
      value,
      scope,
      keywords: mergedKeywords,
      source: "explicit",
      sourceKind: "explicit",
      confidence: Math.max(
        0.9,
        previous.confidence || 0,
        ...duplicates.map((card) => card.confidence || 0)
      ),
      retention: policy.retention,
      expiresAt: policy.expiresAt,
      evidenceCount:
        (previous.evidenceCount || 1) +
        duplicates.reduce((sum, card) => sum + (card.evidenceCount || 1), 0),
      useCount:
        (previous.useCount || 0) +
        duplicates.reduce((sum, card) => sum + (card.useCount || 0), 0),
      createdAt: [previous, ...duplicates]
        .map((card) => card.createdAt)
        .filter(Boolean)
        .sort()[0] || previous.createdAt,
      lastUsedAt:
        [previous, ...duplicates]
          .map((card) => card.lastUsedAt)
          .filter(Boolean)
          .sort()
          .at(-1) || null,
      updatedAt: now.toISOString(),
      lastDecayedAt: now.toISOString()
    };
    this.memories = this.memories.filter((card) => !duplicateIds.has(card.id));
    const updatedIndex = this.memories.findIndex((card) => card.id === id);
    this.memories[updatedIndex] = updated;
    this.#write();
    return { ...updated, keywords: [...mergedKeywords] };
  }

  clear() {
    const removed = this.memories.length;
    this.memories = [];
    if (removed > 0) {
      this.#write();
    }
    return removed;
  }
}

module.exports = {
  MAX_MEMORIES,
  MAX_RETRIEVED,
  MemoryStore,
  containsSensitiveInfo,
  tokenize
};
