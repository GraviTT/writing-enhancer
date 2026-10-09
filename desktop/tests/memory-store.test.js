"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MAX_MEMORIES,
  MemoryStore,
  containsSensitiveInfo
} = require("../src/lib/memory-store");

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".test-memory-"));
  const filePath = path.join(directory, "memories.json");
  try {
    return run(new MemoryStore(filePath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function candidate(overrides = {}) {
  return {
    type: "style_rule",
    value: "업무 메시지는 결론부터 짧게 작성한다.",
    scope: "업무 메시지",
    confidence: 0.9,
    source: "explicit",
    conflict_key: "work_message_length",
    keywords: ["업무", "메시지", "짧게"],
    ...overrides
  };
}

test("민감한 정보 후보는 거부한다", () => {
  assert.equal(containsSensitiveInfo("내 API key는 abc123이다"), true);

  withStore((store) => {
    const ids = store.addCandidates([
      candidate({ value: "내 계좌번호 123-456-789를 문장에 넣는다." })
    ]);
    assert.deepEqual(ids, []);
    assert.equal(store.list().length, 0);
  });
});

test("AI 추론 기억은 영구 저장하지 않고 8시간 TTL을 둔다", () => {
  withStore((store) => {
    store.addCandidates([
      candidate({
        source: "inferred",
        confidence: 0.9,
        conflict_key: null
      })
    ]);
    const [card] = store.list();

    assert.equal(card.sourceKind, "inferred");
    assert.equal(card.retention, "session");
    assert.ok(Date.parse(card.expiresAt) > Date.now());
    assert.ok(Date.parse(card.expiresAt) <= Date.now() + 8 * 60 * 60 * 1_000 + 1_000);
  });
});

test("동일 후보는 합치고 반복 증거를 승격한다", () => {
  withStore((store) => {
    const inferred = candidate({ source: "inferred", confidence: 0.9 });
    store.addCandidates([inferred]);
    store.addCandidates([{ ...inferred, source: "repeated" }]);
    const [card] = store.list();

    assert.equal(store.list().length, 1);
    assert.equal(card.evidenceCount, 2);
    assert.equal(card.source, "repeated");
    assert.equal(card.retention, "long_term");
  });
});

test("강한 명시적 기억과 충돌하는 추론은 저장하지 않는다", () => {
  withStore((store) => {
    store.addCandidates([candidate()]);
    const ids = store.addCandidates([
      candidate({
        value: "업무 메시지는 배경부터 길게 작성한다.",
        source: "inferred",
        confidence: 0.95
      })
    ]);

    assert.deepEqual(ids, []);
    assert.equal(store.list().length, 1);
    assert.match(store.list()[0].value, /결론부터/);
  });
});

test("기억 편집 시 같은 conflictKey의 중복 카드를 하나로 병합한다", () => {
  withStore((store) => {
    const [id] = store.addCandidates([candidate()]);
    const original = store.list()[0];
    store.memories.push({
      ...original,
      id: "legacy-duplicate",
      value: "업무 메시지는 배경부터 길게 작성한다.",
      evidenceCount: 2,
      useCount: 3,
      keywords: ["업무", "배경"]
    });

    const updated = store.update(id, {
      value: "업무 메시지는 결론과 다음 행동부터 간결하게 작성한다.",
      scope: "업무 메시지"
    });
    const cards = store.list();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, id);
    assert.equal(cards[0].value, updated.value);
    assert.equal(cards[0].evidenceCount, 3);
    assert.equal(cards[0].useCount, 3);
    assert.ok(cards[0].keywords.includes("배경"));
  });
});

test("기억 예산은 50장을 넘지 않고 검색은 최대 5장이다", () => {
  withStore((store) => {
    for (let index = 0; index < MAX_MEMORIES + 8; index += 1) {
      store.addCandidates([
        candidate({
          value: `프로젝트 ${index} 관련 글은 핵심 결론부터 작성한다.`,
          scope: `프로젝트 ${index}`,
          conflict_key: null,
          keywords: ["프로젝트", String(index)]
        })
      ]);
    }

    assert.equal(store.list().length, MAX_MEMORIES);
    assert.ok(store.search("프로젝트 관련 문장", 20).length <= 5);
  });
});
