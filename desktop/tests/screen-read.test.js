"use strict";

// 화면에서 글 읽기와 번역: 고른 영역 계산, AI 요청 형식, 외국어 판단.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { AIClient, buildTranslationPrompt } = require("../src/lib/ai-client");
const { imageCropRect, normalizeSelection } = require("../src/lib/screen-read");
const { suggestsTranslation } = require("../src/renderer/text-language");
const writingRules = require("../src/renderer/writing-rules");

function pngData() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString("base64");
}

function screenAttachment() {
  const data = pngData();
  return {
    id: "screen-read",
    name: "화면에서 읽을 부분.png",
    mimeType: "image/png",
    kind: "image",
    source: "screen",
    size: Buffer.from(data, "base64").length,
    data
  };
}

function openAIResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }]
    })
  };
}

function geminiResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] })
  };
}

test("고른 영역은 화면 안으로 자르고, 너무 작으면 버린다", () => {
  const bounds = { width: 1920, height: 1080 };
  assert.deepEqual(normalizeSelection({ x: -20, y: 10, width: 120, height: 50 }, bounds), {
    x: 0,
    y: 10,
    width: 100,
    height: 50
  });
  assert.deepEqual(normalizeSelection({ x: 1900, y: 1070, width: 100, height: 100 }, bounds), {
    x: 1900,
    y: 1070,
    width: 20,
    height: 10
  });
  assert.equal(normalizeSelection({ x: 10, y: 10, width: 5, height: 300 }, bounds), null);
  assert.equal(normalizeSelection({ x: "a", y: 0, width: 10, height: 10 }, bounds), null);
  assert.equal(normalizeSelection(null, bounds), null);
});

test("화면 배율과 캡처 크기 제한에 맞춰 이미지 픽셀 영역으로 바꾼다", () => {
  // 150% 배율 화면: 화면 좌표 1920x1080, 찍은 이미지 2880x1620
  assert.deepEqual(
    imageCropRect({ x: 100, y: 50, width: 200, height: 100 }, { width: 1920, height: 1080 }, { width: 2880, height: 1620 }),
    { x: 150, y: 75, width: 300, height: 150 }
  );
  // 끝에 걸친 영역도 이미지 밖으로 나가지 않는다.
  const edge = imageCropRect(
    { x: 1900, y: 1070, width: 20, height: 10 },
    { width: 1920, height: 1080 },
    { width: 1000, height: 562 }
  );
  assert.ok(edge.x + edge.width <= 1000 && edge.y + edge.height <= 562);
  assert.ok(edge.width >= 1 && edge.height >= 1);
});

test("한글이 거의 없는 글이나 AI가 외국어라고 한 글은 번역으로 연다", () => {
  assert.equal(suggestsTranslation("Your order has shipped!"), true);
  assert.equal(suggestsTranslation("今日はいい天気ですね"), true);
  assert.equal(suggestsTranslation("내일 회의 자료 보내 줄게"), false);
  assert.equal(suggestsTranslation("API 키 확인"), false);
  assert.equal(suggestsTranslation("ok"), false);
  assert.equal(suggestsTranslation("안녕하세요", "en"), true);
  assert.equal(suggestsTranslation("Hello", "ko"), false);
});

test("화면 글 읽기는 이미지를 고해상도로 보내고, 실패해도 다른 AI에 다시 보내지 않는다", async () => {
  const requests = [];
  const client = new AIClient({
    getApiKey: () => "test-key",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return openAIResponse({ text: "  Hello\r\nworld  ", language: "EN", language_name: "영어" });
    }
  });
  const result = await client.readImageText({ attachment: screenAttachment() });
  assert.equal(result.text, "Hello\nworld");
  assert.equal(result.language, "en");
  assert.equal(result.languageName, "영어");
  assert.equal(requests.length, 1);
  const body = requests[0].body;
  assert.equal(body.input[0].content[0].text, writingRules.imageText.systemPrompt);
  assert.equal(body.text.format.name, "writing_enhancer_image_text");
  assert.deepEqual(body.text.format.schema.required, ["text", "language", "language_name"]);
  const image = body.input[1].content.find((part) => part.type === "input_image");
  assert.equal(image.detail, "high");
  assert.match(image.image_url, /^data:image\/png;base64,/u);

  const calls = [];
  const failing = new AIClient({
    getApiKey: () => "test-key",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: false, status: 500, json: async () => ({ error: { message: "down" } }) };
    }
  });
  await assert.rejects(failing.readImageText({ attachment: screenAttachment() }), (error) => {
    assert.equal(error.code, "IMAGE_TEXT_UNAVAILABLE");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.ok(calls.every((url) => url.includes("openai")));
  await assert.rejects(client.readImageText({}), /읽을 화면 이미지가 없어요/u);
});

test("글자가 없는 이미지는 빈 글과 빈 언어로 돌려준다", async () => {
  const client = new AIClient({
    getApiKey: (provider) => (provider === "gemini" ? "test-key" : ""),
    fetchImpl: async () => geminiResponse({ text: "", language: "ko", language_name: "한국어" })
  });
  const result = await client.readImageText({ attachment: screenAttachment() });
  assert.deepEqual(
    { text: result.text, language: result.language, languageName: result.languageName },
    { text: "", language: "", languageName: "" }
  );
});

test("번역은 고른 언어와 상황을 지시문 틀에 넣고, 실패하면 다른 AI로 넘어간다", async () => {
  assert.equal(
    buildTranslationPrompt({ input: " Thanks! ", targetLanguage: "ja", situation: "" }),
    "옮길 언어: 일본어\n상황: 없음\n\n번역할 글:\nThanks!"
  );
  // 모르는 언어 코드는 한국어로 옮긴다.
  assert.match(buildTranslationPrompt({ input: "x", targetLanguage: "xx" }), /^옮길 언어: 한국어/u);

  const urls = [];
  const client = new AIClient({
    getApiKey: () => "test-key",
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      if (String(url).includes("openai")) return { ok: false, status: 503, json: async () => ({}) };
      const body = JSON.parse(options.body);
      assert.equal(body.systemInstruction.parts[0].text, writingRules.translation.systemPrompt);
      assert.match(body.contents[0].parts[0].text, /옮길 언어: 영어\n상황: 업무 메일/u);
      return geminiResponse({ translated_text: "Please review the attached file." });
    }
  });
  const result = await client.translate({ input: "첨부 파일 확인 부탁드려요", targetLanguage: "en", situation: "업무 메일" });
  assert.equal(result.translatedText, "Please review the attached file.");
  assert.equal(result.provider, "gemini");
  assert.equal(urls.length, 2);
  await assert.rejects(client.translate({ input: "  " }), /번역할 글을 먼저/u);
});

test("화면 글 읽기는 단축키(선택한 글이 없을 때)·트레이·도구 버튼에서 시작한다", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
  const main = read("main.js");
  const html = read("renderer/index.html");
  assert.match(main, /reason === "empty" && configStore\.getPublicSettings\(\)\.screenReadFallback/u);
  assert.match(main, /label: "화면에서 글 읽기", click: \(\) => startScreenRead\(\)/u);
  assert.match(main, /picker\.setAlwaysOnTop\(true, "screen-saver"\)/u);
  assert.match(html, /id="readScreenButton"/u);
  assert.match(html, /id="screenReadFallbackInput"/u);
  assert.match(html, /id="selectionModeTranslate"/u);
  const picker = read("renderer/screen-select.html");
  assert.match(picker, /Content-Security-Policy/u);
  assert.match(picker, /Esc 취소/u);
});
