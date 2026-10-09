import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryCandidate } from "../src/contracts.js";
import { saveMemory } from "../src/memory.js";
import {
  containsSensitiveInfo,
  detectSensitiveInfo,
  redactSensitiveInfo,
} from "../src/sensitive.js";

test("한국어 개인정보·인증정보·금융정보를 감지한다", () => {
  const samples = [
    ["비밀번호: qwerty123!", "credential"],
    ["인증번호 123456", "credential"],
    ["주민번호 900101-1234567", "resident_id"],
    ["연락처 010-1234-5678", "phone"],
    ["메일 test@example.com", "email"],
    ["계좌번호 123-456-789012", "bank_account"],
    ["복용약: 아침마다 예시약", "medical"],
    ["연봉: 8천만 원", "financial"],
  ] as const;

  for (const [input, category] of samples) {
    assert.equal(containsSensitiveInfo(input), true, input);
    assert.ok(
      detectSensitiveInfo(input).some((match) => match.category === category),
      input,
    );
    assert.match(redactSensitiveInfo(input), /숨김/);
  }
});

test("민감정보가 섞인 기억 후보는 저장하지 않는다", () => {
  const candidate: MemoryCandidate = {
    type: "context_fact",
    value: "내 이메일은 test@example.com이다.",
    scope: "연락처",
    confidence: 1,
    source: "explicit",
    conflict_key: "identity:email",
    keywords: ["이메일"],
  };
  const result = saveMemory([], candidate);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "sensitive_information");
  assert.equal(result.cards.length, 0);
});
