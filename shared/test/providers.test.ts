import assert from "node:assert/strict";
import test from "node:test";
import {
  extractGeminiResult,
  extractOpenAIResult,
  mapGeminiRequest,
  mapOpenAIRequest,
  toGeminiResponseJsonSchema,
} from "../src/providers.js";
import { loadKoreanFixture } from "./helpers.js";

const fixture = loadKoreanFixture();
const sample = fixture.enhancement_cases[0];
assert.ok(sample);

test("OpenAI Responses API 요청에 공통 스키마와 저장 금지를 매핑한다", () => {
  const request = mapOpenAIRequest({
    model: "fixed-openai-model",
    input: sample.input,
  });
  assert.equal(request.provider, "openai");
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.match(request.body.input[1]?.content[0]?.text ?? "", /current_input/);
  assert.match(request.body.input[1]?.content[0]?.text ?? "", /팀장님/);
});

test("Gemini 요청은 공통 계약에서 미지원 문자열 키워드를 제거해 매핑한다", () => {
  const request = mapGeminiRequest({
    model: "fixed-gemini-model",
    input: sample.input,
  });
  assert.equal(
    request.path,
    "/v1beta/models/fixed-gemini-model:generateContent",
  );
  assert.equal(
    request.body.generationConfig.responseMimeType,
    "application/json",
  );
  assert.equal(request.body.store, false);
  assert.deepEqual(
    request.body.generationConfig.responseJsonSchema,
    toGeminiResponseJsonSchema(
      mapOpenAIRequest({
        model: "fixed-openai-model",
        input: sample.input,
      }).body.text.format.schema,
    ),
  );
  const serializedSchema = JSON.stringify(
    request.body.generationConfig.responseJsonSchema,
  );
  assert.doesNotMatch(serializedSchema, /"minLength"|"maxLength"|"pattern"/);
});

test("API 키 없는 mock 응답을 두 provider 모두 동일한 결과로 파싱한다", () => {
  const serialized = JSON.stringify(sample.mock_output);
  const openAIResponse = {
    output: [{ content: [{ type: "output_text", text: serialized }] }],
  };
  const geminiResponse = {
    candidates: [{ content: { parts: [{ text: serialized }] } }],
  };

  assert.deepEqual(extractOpenAIResult(openAIResponse), sample.mock_output);
  assert.deepEqual(extractGeminiResult(geminiResponse), sample.mock_output);
});
