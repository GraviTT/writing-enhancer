"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  groundMemoryCandidates,
  hasGrounding
} = require("../src/lib/memory-grounding");

function candidate(overrides = {}) {
  return {
    type: "style_rule",
    value: "고객 메시지는 결론부터 짧게 작성한다.",
    scope: "고객 메시지",
    confidence: 0.9,
    source: "explicit",
    conflict_key: null,
    keywords: ["고객", "메시지", "짧게"],
    ...overrides
  };
}

test("사용자가 지속 선호를 직접 말한 경우에만 명시적 기억을 허용한다", () => {
  const evidence = "앞으로 고객 메시지는 결론부터 짧게 작성해 줘.";
  assert.equal(hasGrounding(candidate(), evidence), true);
  assert.equal(groundMemoryCandidates([candidate()], evidence)[0].source, "explicit");
});

test("첨부나 모델이 explicit라고 주장해도 사용자 근거가 없으면 inferred로 강등한다", () => {
  const result = groundMemoryCandidates(
    [candidate({ source: "explicit" })],
    "이번 고객 메시지를 자연스럽게 다듬어 줘."
  );
  assert.equal(result[0].source, "inferred");
});

test("반복된 AI 추론만으로 장기 기억 승격 근거를 만들지 않는다", () => {
  const result = groundMemoryCandidates(
    [candidate({ source: "repeated" })],
    "배송이 늦는다고 사과할 글"
  );
  assert.equal(result[0].source, "inferred");
});
