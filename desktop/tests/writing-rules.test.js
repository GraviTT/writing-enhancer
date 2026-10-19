"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { GUESS_SYSTEM_PROMPT, SYSTEM_PROMPT } = require("../src/lib/ai-client");
const sideChatRules = require("../src/renderer/side-chat-rules");
const writingRules = require("../src/renderer/writing-rules");

const repository = path.resolve(__dirname, "..", "..");

test("글 강화는 원문의 반말·존댓말을 따르고, 받는 사람을 정하면 그에 맞춘다", () => {
  assert.ok(SYSTEM_PROMPT.includes(writingRules.speechLevel.enhance));
  assert.match(writingRules.speechLevel.enhance, /원문이 반말이면 반말로, 존댓말이면 존댓말로/u);
  assert.match(writingRules.speechLevel.enhance, /받는 사람/u);
  assert.ok(GUESS_SYSTEM_PROMPT.includes(writingRules.speechLevel.guess));
});

test("사이드 채팅은 사용자의 말투로 답한다", () => {
  assert.match(sideChatRules.prompt.systemPrompt, /사용자가 반말로 말하면 반말로, 존댓말로 말하면 존댓말로 답하고/u);
});

test("Android도 같은 말투 규칙과 선택한 글 강화 목록을 쓴다", () => {
  const kotlin = fs.readFileSync(
    path.join(repository, "android/app/src/main/java/com/example/writingenhancer/ai/SharedWritingRules.kt"),
    "utf8"
  );
  const client = fs.readFileSync(
    path.join(repository, "android/app/src/main/java/com/example/writingenhancer/ai/AiClient.kt"),
    "utf8"
  );
  assert.ok(kotlin.includes(JSON.stringify(writingRules.speechLevel.enhance)));
  assert.match(client, /\+ SharedWritingRules\.ENHANCE_SPEECH_LEVEL/u);
  for (const situation of writingRules.selection.situations) {
    assert.ok(kotlin.includes(`Situation(${JSON.stringify(situation.label)}, ${JSON.stringify(situation.text)})`));
  }
});

test("선택한 글 강화 화면은 5단계 이름과 짧은 상황 버튼을 쓴다", () => {
  assert.equal(writingRules.selection.levelShortLabels.length, 5);
  assert.ok(writingRules.selection.situations.length >= 4);
  for (const situation of writingRules.selection.situations) {
    assert.ok([...situation.label].length <= 6, situation.label);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /<script src="\.\/writing-rules\.js"><\/script>/u);
  assert.ok(html.indexOf("writing-rules.js") < html.indexOf("selection.js"));
});
