"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AIClient,
  buildSideChatPrompt,
  buildUserPrompt,
  hasExplicitLengthDirective,
  normalizeResult,
  parseJsonText,
  toGeminiSchema
} = require("../src/lib/ai-client");

function pngData() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString(
    "base64"
  );
}

test("구조화 출력의 snake_case 계약을 내부 결과로 변환한다", () => {
  const parsed = parseJsonText(`\`\`\`json
  {
    "completed_text": "바로 쓸 수 있는 글",
    "assumption": "업무 메시지로 판단함",
    "follow_up": "동료에게 보내는 말로 정리했어요. 더 단호해야 하나요?",
    "memory_candidates": []
  }
  \`\`\``);
  const result = normalizeResult(parsed);

  assert.equal(result.completedText, "바로 쓸 수 있는 글");
  assert.equal(result.assumption, "업무 메시지로 판단함");
  assert.equal(result.memoryCandidates.length, 0);
});

test("OpenAI 요청에 상황·텍스트 참고와 화면 이미지가 실제 멀티모달 입력으로 포함된다", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          completed_text: "팀장님, 검수 일정을 하루 연장하고자 합니다.",
          assumption: "일정 변경 승인 요청",
          follow_up: "승인 요청으로 정리했어요. 더 단호하게 할까요?",
          memory_candidates: []
        })
      })
    };
  };
  const client = new AIClient({
    getApiKey: (provider) => (provider === "openai" ? "test-key" : ""),
    fetchImpl
  });
  const imageData = pngData();
  await client.enhance({
    situation: "팀장에게 보고",
    input: "일정 하루 미뤄야 함",
    attachments: [
      {
        id: "text",
        name: "메모.txt",
        mimeType: "text/plain",
        kind: "text",
        source: "file",
        size: 12,
        text: "품질 검수가 필요함"
      },
      {
        id: "screen",
        name: "현재 화면.png",
        mimeType: "image/png",
        kind: "image",
        source: "screen",
        size: 5,
        data: imageData
      }
    ]
  });

  const userContent = requestBody.input[1].content;
  assert.equal(requestBody.store, false);
  assert.deepEqual(userContent.map((part) => part.type), ["input_text", "input_image"]);
  assert.match(userContent[0].text, /팀장에게 보고/);
  assert.match(userContent[0].text, /품질 검수가 필요함/);
  assert.match(userContent[1].image_url, /^data:image\/png;base64,/);
});

test("알아맞춰 봐는 완성본 대신 질문 스키마로 먼저 호출된다", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          assumption: "고객에게 사과 메시지",
          question: "환불까지 제안해야 하는 상황인가요?"
        })
      })
    };
  };
  const client = new AIClient({
    getApiKey: (provider) => (provider === "openai" ? "test-key" : ""),
    fetchImpl
  });
  const result = await client.guess({ input: "배송 늦음 미안하다고", attachments: [] });
  assert.equal(result.question, "환불까지 제안해야 하는 상황인가요?");
  assert.equal(requestBody.text.format.name, "writing_enhancer_question");
  assert.match(requestBody.input[0].content[0].text, /질문 하나만/u);
});

test("Gemini에도 화면 이미지와 PDF를 inlineData로 전달한다", async () => {
  let requestBody;
  let requestUrl;
  let requestHeaders;
  const fetchImpl = async (url, options) => {
    requestUrl = String(url);
    requestHeaders = options.headers;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    completed_text: "완성된 문장",
                    assumption: "업무 문서",
                    follow_up: "업무용으로 정리했어요. 그대로 쓸까요?",
                    memory_candidates: []
                  })
                }
              ]
            }
          }
        ]
      })
    };
  };
  const client = new AIClient({
    getApiKey: (provider) => (provider === "gemini" ? "test-key" : ""),
    fetchImpl
  });
  const imageBinary = pngData();
  const pdfBinary = Buffer.from("%PDF-1.7\nsafe", "ascii").toString("base64");
  await client.enhance({
    input: "정리",
    attachments: [
      {
        id: "screen",
        name: "현재 화면.png",
        mimeType: "image/png",
        kind: "image",
        source: "screen",
        size: Buffer.from(imageBinary, "base64").length,
        data: imageBinary
      },
      {
        id: "pdf",
        name: "자료.pdf",
        mimeType: "application/pdf",
        kind: "document",
        source: "file",
        size: Buffer.from(pdfBinary, "base64").length,
        data: pdfBinary
      }
    ]
  });
  assert.equal(requestBody.store, undefined);
  assert.doesNotMatch(requestUrl, /[?&]key=/u);
  assert.equal(requestHeaders["x-goog-api-key"], "test-key");
  const parts = requestBody.contents[0].parts;
  assert.equal(parts[1].inlineData.mimeType, "image/png");
  assert.equal(parts[2].inlineData.mimeType, "application/pdf");
  const schemaText = JSON.stringify(requestBody.generationConfig.responseJsonSchema);
  assert.doesNotMatch(schemaText, /maxLength|additionalProperties|pattern/);
});

test("Gemini 스키마 정제는 미지원 문자열 제약을 제거하고 핵심 계약은 보존한다", () => {
  const schema = toGeminiSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", maxLength: 20, pattern: "^a", description: "글" },
      score: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["text"]
  });
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.properties.text.maxLength, undefined);
  assert.equal(schema.properties.text.pattern, undefined);
  assert.equal(schema.properties.text.description, "글");
  assert.equal(schema.properties.score.maximum, 1);
});

test("보유 기억은 최대 다섯 장만 프롬프트에 넣는다", () => {
  const memories = Array.from({ length: 7 }, (_, index) => ({
    scope: "general",
    value: `기억 ${index + 1}`
  }));
  const prompt = buildUserPrompt({ input: "정리해 줘", memories });

  assert.match(prompt, /기억 5/);
  assert.doesNotMatch(prompt, /기억 6/);
});

test("5단계 강화 범위가 단계별 목표 글자 수와 사실 안전 규칙을 프롬프트에 넣는다", () => {
  const summary = buildUserPrompt({
    input: "가".repeat(100),
    enhancementLevel: 1
  });
  const faithful = buildUserPrompt({
    input: "가".repeat(100),
    enhancementLevel: 3
  });
  const expanded = buildUserPrompt({
    input: "가".repeat(100),
    enhancementLevel: 5
  });

  assert.match(summary, /1단계 · 핵심 요약/u);
  assert.match(summary, /45~60자를 목표/u);
  assert.match(faithful, /3단계 · 원문 충실/u);
  assert.match(faithful, /90~110자를 목표/u);
  assert.match(expanded, /5단계 · 풍부하게 확장/u);
  assert.match(expanded, /150~200자를 목표/u);
  assert.match(expanded, /입력에 없는 이름·인물·날짜/u);
});

test("사용자의 구체적인 분량과 직접 요구가 슬라이더보다 우선한다", () => {
  const prompt = buildUserPrompt({
    input: "일정 지연을 팀장에게 보고",
    situation: "업무 메신저로 정확히 3줄",
    enhancementLevel: 5,
    refinement: {
      currentText: "현재 결과",
      followUp: "조금 더 다듬을까요?",
      answer: "결론 우선 구조와 단호한 문체로 바꿔 줘"
    }
  });

  assert.match(prompt, /직접 요구는 기본 강화 규칙보다 우선/u);
  assert.match(prompt, /구체적인 분량 지시가 있으면 그것이 분량의 최우선 기준/u);
  assert.match(prompt, /목표 분량과 글자 수 계산은 이번 결과에는 적용하지 않는다/u);
  assert.doesNotMatch(prompt, /결과 본문은 약/u);
  assert.match(prompt, /사실 안전 규칙은 모든 요구보다 우선/u);
});

test("명확한 분량 지시만 슬라이더 분량을 대체한다", () => {
  assert.equal(hasExplicitLengthDirective("3줄로 정리해 줘"), true);
  assert.equal(hasExplicitLengthDirective("두 배로 늘려 줘"), true);
  assert.equal(hasExplicitLengthDirective("절반으로 줄여 줘"), true);
  assert.equal(hasExplicitLengthDirective("A4 2페이지 분량"), true);
  assert.equal(hasExplicitLengthDirective("조금 더 읽기 쉽게 바꿔 줘"), false);
});

test("원문 기준 다시 강화는 이전 결과 없이 기존 설정만 유지한다", () => {
  const prompt = buildUserPrompt({
    input: "원본 재료",
    situation: "고객 안내",
    enhancementLevel: 4,
    regenerateFromOriginal: true
  });

  assert.match(prompt, /재강화 기준/u);
  assert.match(prompt, /이전 완성본, 이전 후속 질문과 AI 추론은 참조하지 않는다/u);
  assert.match(prompt, /현재 상황, 참고 자료, 관련 기억, 강화 범위 설정은 유지한다/u);
  assert.match(prompt, /처음 입력을 유일한 원본으로 삼아/u);
  assert.doesNotMatch(prompt, /현재 완성본:\n/u);
});

test("기억 출처를 프롬프트에 유지하고 추론 기억은 사실 근거에서 제외한다", () => {
  const prompt = buildUserPrompt({
    input: "문장을 정리해 줘",
    memories: [
      {
        sourceKind: "inferred",
        type: "style_rule",
        scope: "general",
        value: "짧은 문장을 선호할 수 있음"
      }
    ]
  });

  assert.match(prompt, /inferred \| style_rule \| general/u);
  assert.match(prompt, /inferred 기억은 문체·선호·질문 힌트일 뿐 사실 근거로 절대 사용하지 마라/u);
});

test("첫 완성 질문은 글 유형과 목적을 예상해 추가 다듬기 허용을 묻고 이후 질문은 기존 방식을 쓴다", () => {
  const first = buildUserPrompt({
    input: "일정 하루 늦음 팀장에게",
    followUpMode: "first"
  });
  const subsequent = buildUserPrompt({
    input: "일정 하루 늦음 팀장에게",
    followUpMode: "subsequent",
    refinement: {
      currentText: "검수 일정을 하루 연장하고자 합니다.",
      followUp: "업무 보고로 보여요. 더 다듬어도 될까요?",
      answer: "조금 부드럽게"
    }
  });
  assert.match(first, /글 유형, 주제, 목적/u);
  assert.match(first, /더 다듬어도 되는지/u);
  assert.match(first, /사용자가 글 유형을 직접 고르게 하거나 선택지를 나열하지 않는다/u);
  assert.match(subsequent, /두 번째 이후 follow_up 규칙/u);
  assert.match(subsequent, /기존 방식대로 이번 수정에서 적용한 추천 판단/u);
  assert.doesNotMatch(subsequent, /첫 완성 직후의 follow_up 규칙/u);
});

test("사이드 채팅은 최근 20개·2만4천 자 안에서만 문맥을 재사용한다", () => {
  const messages = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `메시지-${index}-${"가".repeat(2_000)}`
  }));
  const prompt = buildSideChatPrompt({ input: "새 질문", messages });
  assert.doesNotMatch(prompt, /메시지-0-/u);
  assert.match(prompt, /메시지-24-/u);
  assert.match(prompt, /‘둘’, ‘셋’, ‘그것’, ‘이들’, ‘각각’, ‘전자\/후자’, ‘어느 쪽’/u);
  assert.match(prompt, /선행 대상이 이전 대화에 명확하면 비교 대상을 다시 묻지 말고/u);
  const context = prompt.split("새 사용자 메시지:")[0];
  assert.ok(context.length < 25_000);
});

test("OpenAI 실패 시 Gemini로 자동 대체하고 폐기된 생성 파라미터를 보내지 않는다", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (String(url).includes("openai.com")) {
      return {
        ok: false,
        status: 503,
        statusText: "Unavailable",
        json: async () => ({ error: { message: "temporary outage" } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    completed_text: "완성된 문장",
                    assumption: "짧은 업무 메시지",
                    follow_up: "업무용으로 정리했어요. 다른 상황이면 말해 주세요.",
                    memory_candidates: []
                  })
                }
              ]
            }
          }
        ]
      })
    };
  };
  const client = new AIClient({
    getApiKey: () => "test-key",
    fetchImpl
  });

  const result = await client.enhance({ input: "회의 늦음 알려줘" });

  assert.equal(result.provider, "gemini");
  assert.equal(result.fallbackUsed, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.reasoning.effort, "low");
  assert.equal(requests[0].body.text.verbosity, "low");
  assert.equal("temperature" in requests[1].body.generationConfig, false);
  assert.equal("topP" in requests[1].body.generationConfig, false);
  assert.equal("topK" in requests[1].body.generationConfig, false);
  assert.equal("store" in requests[1].body, false);
});
