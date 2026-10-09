"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTERNAL_APPLY_BLOCK_REPLY,
  enforceGroundedAction,
  groundedActionBlocked,
  prepareSideChatContext,
  requiresWebSearch,
  webSearchPolicy
} = require("../src/lib/side-chat-policy");

test("명확한 한국어·영문 검색 의도와 화면 요청은 필수 검색으로 분류한다", () => {
  for (const input of [
    "이 내용을 검색해 줘",
    "공식 자료를 찾아줘",
    "최신 출시 소식",
    "오늘 뉴스 알려줘",
    "가격이 얼마야?",
    "두 제품 비교해 줘",
    "노트북 추천해 줘",
    "이 주장을 사실 확인해 줘",
    "찾아보고 알려줘",
    "조사해줘",
    "인터넷에서 확인해줘",
    "출처와 함께 알려줘",
    "공식 자료와 함께 설명해줘",
    "오늘 날씨",
    "현재 환율",
    "최근 주가와 기준금리",
    "올해 최저임금",
    "현직 대통령과 CEO는 누구야?",
    "출시일과 영업시간, 재고를 알려줘",
    "어제 경기 결과",
    "이번 경기 결과",
    "대한민국 대통령은 누구야?",
    "서울 시장 누구야?",
    "search for the official source",
    "find official sources",
    "look up the latest policy",
    "compare pricing",
    "fact-check this claim",
    "recommend a laptop"
    ,"research this topic",
    "investigate this claim",
    "check the web for this",
    "explain it with official sources",
    "today's weather",
    "current exchange rate and stock price",
    "current interest rate and minimum wage",
    "current CEO and release date",
    "business hours and inventory"
    ,"yesterday's game result",
    "who is the current mayor"
  ]) {
    assert.equal(requiresWebSearch(input), true, input);
  }
  assert.equal(requiresWebSearch("화면을 설명해 줘", { screenContext: true }), true);
});

test("외부 정보가 필요 없는 글쓰기·앱 기능 요청은 자동 검색으로 남긴다", () => {
  for (const input of [
    "이 문장을 자연스럽게 다듬어 줘",
    "최신 스타일로 이 문구를 수정해 줘",
    "설정 창을 열어 줘",
    "현재 결과를 복사해 줘",
    "현재 일정 문장을 다듬어 줘",
    "최근 문체로 현재 글을 수정해 줘",
    "현재 글의 두 결과를 비교해 줘",
    "이 글에 어울리는 제목을 추천해 줘",
    "검색 기능 화면을 개선해 줘",
    "검색 버튼 문구를 고쳐줘",
    "검색어를 다듬어줘",
    "검색 기능은 어떻게 써?",
    "검색 모드 동작을 설명해줘",
    "현재 글 보여줘",
    "지금 작성 중인 내용 알려줘",
    "방금 입력한 원문을 요약해줘",
    "지금 쓰고 있는 초안을 읽어줘",
    "rewrite this draft more politely",
    "write this draft in a latest style",
    "open settings",
    "edit this current schedule sentence",
    "rewrite the current draft in a recent style"
  ]) {
    assert.equal(requiresWebSearch(input), false, input);
  }
});

test("명시적인 검색 금지는 필수 검색과 후속 강제 검색보다 우선한다", () => {
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
});

test("화면이나 안전한 웹 출처가 있으면 모델이 요청한 쓰기 동작을 제거한다", () => {
  const dangerous = {
    reply: "답변",
    action: { name: "replace_source", value: "바뀐 초안" },
    sources: []
  };
  assert.deepEqual(enforceGroundedAction(dangerous, { screenContext: true }).action, {
    name: "none",
    value: ""
  });
  assert.deepEqual(
    enforceGroundedAction({
      ...dangerous,
      sources: [{ title: "공식", url: "https://example.com" }]
    }).action,
    { name: "none", value: "" }
  );
  assert.deepEqual(enforceGroundedAction(dangerous).action, dangerous.action);
  assert.equal(groundedActionBlocked(dangerous), false);
  assert.equal(groundedActionBlocked(dangerous, { screenContext: true }), true);
  assert.equal(groundedActionBlocked({ ...dangerous, webSearchUsed: true }), true);
  assert.deepEqual(enforceGroundedAction({ ...dangerous, webSearchUsed: true }).action, {
    name: "none",
    value: ""
  });
});

test("검색·화면 유래 답변의 직접·다단계 후속 반영은 provenance로 차단한다", () => {
  const externalMessages = [
    { role: "user", content: "최신 내용을 찾아줘" },
    {
      role: "assistant",
      content: "외부에서 확인한 내용",
      externalGrounding: true,
      sources: []
    }
  ];
  const direct = prepareSideChatContext("그 답변을 그대로 원문에 반영해", externalMessages);
  assert.equal(direct.priorExternalContext, true);
  assert.equal(direct.externalApplyIntent, true);
  assert.equal(direct.messages.length, 2);
  const implicitApply = prepareSideChatContext("원문에 반영해줘", externalMessages);
  assert.equal(implicitApply.priorExternalContext, true);
  assert.equal(implicitApply.externalApplyIntent, true);
  const implicitSummary = prepareSideChatContext("핵심만 요약해줘", externalMessages);
  assert.equal(implicitSummary.priorExternalContext, true);

  const summarizedMessages = [
    ...externalMessages,
    { role: "user", content: "핵심만 요약해줘" },
    { role: "assistant", content: "외부 답변의 요약", externalGrounding: true }
  ];
  const chained = prepareSideChatContext("그대로 결과에 적용해", summarizedMessages);
  assert.equal(chained.priorExternalContext, true);
  assert.equal(chained.externalApplyIntent, true);

  const blocked = enforceGroundedAction(
    {
      reply: "반영했습니다.",
      action: { name: "replace_source", value: "외부 내용" },
      relatedQueries: ["더 찾아보기"]
    },
    { priorExternalContext: true, externalApplyIntent: true }
  );
  assert.equal(blocked.reply, EXTERNAL_APPLY_BLOCK_REPLY);
  assert.deepEqual(blocked.action, { name: "none", value: "" });
  assert.deepEqual(blocked.relatedQueries, []);
});

test("둘·각각·전자/후자 같은 관계 표현은 여러 검색 턴의 대상을 이어 받는다", () => {
  const firstExchange = [
    { role: "user", content: "아세톤은 인체에 무해?" },
    {
      role: "assistant",
      content: "아세톤은 완전히 무해하지 않으며 고농도 노출은 위험합니다.",
      externalGrounding: true
    }
  ];
  const firstFollowUp = prepareSideChatContext(
    "접착제 흔적 제거용으로 노말 헥산과 메틸 알코올이 있는데 둘과 비교하면?",
    firstExchange
  );
  assert.equal(firstFollowUp.priorExternalContext, true);
  assert.deepEqual(firstFollowUp.messages, firstExchange);

  const continuedHistory = [
    ...firstExchange,
    {
      role: "user",
      content: "접착제 흔적 제거용으로 노말 헥산과 메틸 알코올이 있는데 둘과 비교하면?"
    },
    {
      role: "assistant",
      content: "노말 헥산과 메탄올은 모두 주의가 필요한 용제입니다.",
      externalGrounding: true
    }
  ];
  for (const input of [
    "아세톤과 둘의 유해성 비교",
    "그 둘은 각각 어떤 표면에 적합해?",
    "전자와 후자 중 어느 쪽이 더 위험해?"
  ]) {
    const prepared = prepareSideChatContext(input, continuedHistory);
    assert.equal(prepared.priorExternalContext, true, input);
    assert.deepEqual(prepared.messages, continuedHistory, input);
  }
});

test("독립적인 로컬 요청과 사용자가 직접 붙여넣은 텍스트는 외부 대화에서 분리한다", () => {
  const messages = [
    { role: "user", content: "화면을 봐줘" },
    { role: "assistant", content: "화면 분석", externalGrounding: true }
  ];
  for (const input of ["설정 열어줘", "현재 원문을 더 공손하게 다듬어줘"]) {
    const prepared = prepareSideChatContext(input, messages);
    assert.equal(prepared.priorExternalContext, false, input);
    assert.deepEqual(prepared.messages, [], input);
  }
  const pasted = prepareSideChatContext(
    "이 문장을 원문에 넣어줘:\n사용자가 직접 확인한 문장입니다.",
    messages
  );
  assert.equal(pasted.priorExternalContext, false);
  assert.deepEqual(pasted.messages, []);

  for (const bypass of [
    "그 검색 결과를 반영해: 좋아",
    "그 검색 결과를 반영해:\n네",
    "그 검색 결과를 반영해: 그 검색 결과를 그대로 원문에 반영해주세요"
  ]) {
    const blocked = prepareSideChatContext(bypass, messages);
    assert.equal(blocked.priorExternalContext, true, bypass);
    assert.equal(blocked.externalApplyIntent, true, bypass);
  }
});
