"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONTEXT_MESSAGE_LIMIT,
  actionNeedsConfirmation,
  applyGroundingPolicy,
  isExternallyGrounded,
  prepareSideChatContext,
  requiresWebSearch,
  webSearchPolicy
} = require("../src/lib/side-chat-policy");

test("사용자가 웹 검색을 직접 요청한 경우에만 검색을 강제한다", () => {
  for (const input of [
    "이 내용을 검색해 줘",
    "최신 정책을 검색해서 정리해줘",
    "공식 자료를 찾아줘",
    "이 주장을 사실 확인해 줘",
    "찾아보고 알려줘",
    "조사해줘",
    "인터넷에서 확인해줘",
    "출처와 함께 알려줘",
    "공식 자료와 함께 설명해줘",
    "팩트체크 해줘",
    "search for the official source",
    "find official sources",
    "look up the latest policy",
    "fact-check this claim",
    "research this topic",
    "investigate this claim",
    "check the web for this",
    "explain it with official sources"
  ]) {
    assert.equal(requiresWebSearch(input), true, input);
  }
});

test("최신·가격·비교 같은 주제어나 화면만으로는 검색을 강제하지 않고 모델이 판단한다", () => {
  for (const input of [
    "최신 출시 소식",
    "오늘 뉴스 알려줘",
    "가격이 얼마야?",
    "두 제품 비교해 줘",
    "노트북 추천해 줘",
    "오늘 날씨",
    "현재 환율",
    "현직 대통령과 CEO는 누구야?",
    "compare pricing",
    "recommend a laptop",
    "today's weather"
  ]) {
    assert.equal(webSearchPolicy(input), "auto", input);
  }
  assert.equal(webSearchPolicy("화면을 설명해 줘", { screenContext: true }), "auto");
});

test("검색이라는 단어나 찾기 표현이 있어도 글쓰기·현재 글 요청은 검색을 강제하지 않는다", () => {
  for (const input of [
    "검색 엔진 최적화에 대한 블로그 글 초안 써줘",
    "지금 이 메일 말투 괜찮아?",
    "원문에서 오타 찾아줘",
    "이 글에서 어색한 문장 찾아봐",
    "이 문장을 자연스럽게 다듬어 줘",
    "최신 스타일로 이 문구를 수정해 줘",
    "설정 창을 열어 줘",
    "현재 결과를 복사해 줘",
    "이 글에 어울리는 제목을 추천해 줘",
    "검색 기능 화면을 개선해 줘",
    "검색 버튼 문구를 고쳐줘",
    "검색어를 다듬어줘",
    "검색 기능은 어떻게 써?",
    "조사 '은/는' 차이 알려줘",
    "현재 글 보여줘",
    "rewrite this draft more politely",
    "find typos in this draft",
    "open settings"
  ]) {
    assert.equal(requiresWebSearch(input), false, input);
  }
});

test("명시적인 검색 금지는 검색 버튼과 후속 탐색 강제보다 우선한다", () => {
  for (const input of [
    "검색하지 말고 아는 범위에서 답해줘",
    "검색은 하지 말고 아는 내용만 알려줘",
    "웹 검색을 하지 말아 주세요",
    "인터넷은 보지 말고 화면만 설명해줘",
    "검색 없이 설명해줘",
    "웹 검색 금지",
    "do not search; answer from context",
    "don't browse the web",
    "no web search",
    "answer without browsing"
  ]) {
    assert.equal(webSearchPolicy(input, { forceSearch: true }), "disabled", input);
    assert.equal(requiresWebSearch(input), false, input);
  }
  assert.equal(webSearchPolicy("세부 기준은?", { forceSearch: true }), "required");
  assert.equal(webSearchPolicy("세부 기준은?", { forceSearch: "true" }), "auto");
});

test("검색 답변 뒤의 후속 질문도 이전 대화를 그대로 유지한다", () => {
  const history = [
    { role: "user", content: "아이폰 17 가격 알려줘" },
    {
      role: "assistant",
      content: "아이폰 17은 기본 모델 기준으로 안내드릴게요.",
      externalGrounding: true,
      sources: [{ title: "Apple", url: "https://apple.com" }]
    }
  ];
  for (const input of [
    "그럼 갤럭시는?",
    "갤럭시 S26이랑 비교하면?",
    "설정 열어줘",
    "현재 원문을 더 공손하게 다듬어줘",
    "이 문장을 원문에 넣어줘:\n사용자가 직접 확인한 문장입니다."
  ]) {
    const prepared = prepareSideChatContext(input, history);
    assert.deepEqual(prepared.messages, history, input);
    assert.equal(prepared.priorExternalContext, true, input);
  }
});

test("외부 자료 여부는 프롬프트에 다시 넣는 최근 대화 범위 안에서만 판단한다", () => {
  const old = [
    { role: "user", content: "화면을 봐줘" },
    { role: "assistant", content: "화면 분석", externalGrounding: true }
  ];
  const recent = Array.from({ length: CONTEXT_MESSAGE_LIMIT }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `일반 대화 ${index}`,
    externalGrounding: false
  }));
  assert.equal(prepareSideChatContext("다음", [...old, ...recent]).priorExternalContext, false);
  assert.equal(prepareSideChatContext("다음", [...recent, ...old]).priorExternalContext, true);
  assert.equal(prepareSideChatContext("다음", []).priorExternalContext, false);
});

test("검색·화면 자료가 섞인 응답의 내용 변경 동작은 지우지 않고 사용자 확인을 요구한다", () => {
  const dangerous = {
    reply: "답변",
    action: { name: "replace_source", value: "바뀐 초안" },
    sources: []
  };
  const local = applyGroundingPolicy(dangerous);
  assert.deepEqual(local.action, dangerous.action);
  assert.equal(local.externalGrounding, false);
  assert.equal(local.actionRequiresConfirmation, false);

  for (const [result, context] of [
    [dangerous, { screenContext: true }],
    [dangerous, { priorExternalContext: true }],
    [{ ...dangerous, webSearchUsed: true }, {}],
    [{ ...dangerous, sources: [{ title: "공식", url: "https://example.com" }] }, {}]
  ]) {
    const grounded = applyGroundingPolicy(result, context);
    assert.deepEqual(grounded.action, dangerous.action);
    assert.equal(grounded.externalGrounding, true);
    assert.equal(grounded.actionRequiresConfirmation, true);
  }
  assert.equal(isExternallyGrounded(dangerous), false);
  assert.equal(isExternallyGrounded(dangerous, { screenContext: true }), true);
});

test("화면 이동 동작과 동작 없음은 외부 자료가 있어도 확인 없이 처리한다", () => {
  for (const name of [
    "show_writing",
    "focus_source",
    "open_history",
    "open_settings",
    "open_memories",
    "open_tools",
    "previous_result",
    "next_result",
    "none"
  ]) {
    assert.equal(actionNeedsConfirmation({ name, value: "" }, true), false, name);
  }
  for (const name of [
    "replace_source",
    "set_situation",
    "replace_result",
    "set_follow_up_reply",
    "enhance",
    "reenhance",
    "copy_result",
    "new_writing",
    "set_enhancement_level",
    "guess_intent"
  ]) {
    assert.equal(actionNeedsConfirmation({ name, value: "" }, true), true, name);
    assert.equal(actionNeedsConfirmation({ name, value: "" }, false), false, name);
  }
});
