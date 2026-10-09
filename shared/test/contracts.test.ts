import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  guessFirstResponseJsonSchema,
  parseGuessFirstResult,
  parseEnhancementResult,
  parseWritingResult,
  responseJsonSchemaForMode,
  validateEnhancementResult,
  validateGuessFirstResult,
} from "../src/contracts.js";
import {
  GUESS_FIRST_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "../src/prompt.js";
import { loadKoreanFixture, loadV2Fixture } from "./helpers.js";

const fixture = loadKoreanFixture();
const v2Fixture = loadV2Fixture();

test("한국어 횡설수설·맞춤법·프롬프트화 fixture가 공통 계약을 만족한다", () => {
  assert.deepEqual(
    fixture.enhancement_cases.map((item) => item.kind),
    ["횡설수설", "맞춤법", "프롬프트화"],
  );

  for (const item of fixture.enhancement_cases) {
    assert.equal(validateEnhancementResult(item.mock_output), true, item.id);
    assert.equal(Object.keys(item.mock_output)[0], "completed_text");
    assert.ok(item.mock_output.completed_text.length > 10);
    assert.ok(item.mock_output.follow_up.endsWith("?"));
  }
});

test("JSON 문자열과 코드 펜스를 모두 안전하게 파싱한다", () => {
  const output = fixture.enhancement_cases[0]?.mock_output;
  assert.ok(output);
  assert.deepEqual(parseEnhancementResult(JSON.stringify(output)), output);
  assert.deepEqual(
    parseEnhancementResult(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``),
    output,
  );
});

test("스키마 밖 키와 네 개 이상의 기억 후보를 거부한다", () => {
  const output = fixture.enhancement_cases[0]?.mock_output;
  assert.ok(output);
  assert.equal(validateEnhancementResult({ ...output, explanation: "extra" }), false);
  assert.throws(
    () =>
      parseEnhancementResult({
        ...output,
        memory_candidates: Array.from(
          { length: 4 },
          () => output.memory_candidates[0],
        ),
      }),
    ContractValidationError,
  );
});

test("시스템 프롬프트가 제품의 필수 행동을 명시한다", () => {
  for (const phrase of [
    "완성 먼저, 질문은 나중",
    "알아서",
    "사실 잠금",
    "현재 입력과 사용자의 최신 정정은 과거 기억보다 항상 우선",
    "최대 3개",
  ]) {
    assert.match(SYSTEM_PROMPT, new RegExp(phrase));
  }
});

test("기본 모드는 기존 완성 우선 스키마를 그대로 사용한다", () => {
  assert.equal(
    responseJsonSchemaForMode(),
    responseJsonSchemaForMode("enhance"),
  );
  assert.equal(responseJsonSchemaForMode("guess_first"), guessFirstResponseJsonSchema);
  const output = fixture.enhancement_cases[0]?.mock_output;
  assert.ok(output);
  assert.deepEqual(parseWritingResult(output), output);
});

test("알아맞춰 봐 응답은 추천 답이 있는 단일 질문만 허용한다", () => {
  const output = v2Fixture.guess_first_output;
  assert.equal(validateGuessFirstResult(output), true);
  assert.deepEqual(parseGuessFirstResult(JSON.stringify(output)), output);
  assert.deepEqual(parseWritingResult(output, "guess_first"), output);

  assert.equal(
    validateGuessFirstResult({
      ...output,
      question: "누구에게 보내나요? 어떤 분위기인가요?",
    }),
    false,
  );
  assert.equal(
    validateGuessFirstResult({
      ...output,
      recommended_answer: "협력사 담당자가 맞나요?",
    }),
    false,
  );
  assert.equal(
    validateGuessFirstResult({
      ...output,
      completed_text: "질문 전에 만든 완성문",
    }),
    false,
  );
  assert.match(GUESS_FIRST_SYSTEM_PROMPT, /질문은 반드시 한 번에 하나만/);
  assert.match(GUESS_FIRST_SYSTEM_PROMPT, /completed_text나 두 번째 질문을 출력하지 않는다/);
});
