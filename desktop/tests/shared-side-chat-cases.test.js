"use strict";

// shared/rules/side-chat-cases.json의 공통 사례를 Windows 구현으로 확인한다.
// Android도 같은 사례를 SharedSideChatCasesTest에서 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildSideChatPrompt, prepareChatPayload } = require("../src/lib/ai-client");
const { actionNeedsConfirmation, webSearchPolicy } = require("../src/lib/side-chat-policy");
const sideChatRules = require("../src/renderer/side-chat-rules");
const chatText = require("../src/renderer/side-chat-text");

const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "shared", "rules", "side-chat-cases.json"), "utf8")
);

test("공통 사례: 검색 강제·자동·금지 판단", () => {
  for (const entry of cases.searchMode) {
    assert.equal(
      webSearchPolicy(entry.input, { forceSearch: entry.forceSearch === true }),
      entry.expected,
      entry.input
    );
  }
});

test("공통 사례: 외부 자료가 섞인 대화의 동작 확인 여부", () => {
  for (const entry of cases.confirmation) {
    assert.equal(
      actionNeedsConfirmation({ name: entry.action, value: "" }, entry.grounded),
      entry.expected,
      `${entry.action} / grounded=${entry.grounded}`
    );
  }
});

test("공통 사례: 진행 표시와 적용 카드 문구", () => {
  for (const entry of cases.progressLabel) {
    assert.equal(
      chatText.progressLabel(
        { stage: entry.stage, searchRequired: entry.searchRequired },
        entry.elapsedMs
      ),
      entry.expected
    );
  }
  for (const entry of cases.pendingAction) {
    const action = { name: entry.action, value: entry.value };
    assert.equal(chatText.pendingActionLabel(action), entry.label, entry.action);
    assert.equal(chatText.pendingActionPreview(action), entry.preview, entry.action);
  }
  const long = chatText.pendingActionPreview({ name: "replace_source", value: "가".repeat(700) });
  assert.equal(long.length, sideChatRules.limits.pendingPreviewCharacters + 1);
  assert.ok(long.endsWith("…"));
});

test("공통 사례: 사이드 채팅 요청은 공통 틀의 모든 자리를 채운다", () => {
  for (const entry of cases.prompt) {
    const prompt = buildSideChatPrompt(
      prepareChatPayload({
        input: entry.input,
        forceSearch: entry.forceSearch === true,
        screenContext: Boolean(entry.screen),
        messages: entry.messages.map((message) => ({
          role: message.role,
          content: message.content,
          externalGrounding: message.external === true
        })),
        writingContext: entry.writingContext
      })
    );
    assert.doesNotMatch(prompt, /\{(?:view|situation|input|screen|searchMode|message)\}/u, entry.name);
    assert.match(prompt, new RegExp(`새 사용자 메시지:\\n${entry.input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.ok(prompt.startsWith("현재 글 강화기 작업:"), entry.name);
  }
});
