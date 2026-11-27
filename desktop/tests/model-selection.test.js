"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigStore } = require("../src/lib/config-store");
const { AIClient, extractGeminiText } = require("../src/lib/ai-client");
const catalog = require("../src/lib/model-catalog.json");

test("Gemini의 추론 부분은 건너뛰고 나뉜 최종 답변만 합친다", () => {
  const parts = [{ thought: true, text: "중간 내용" }, { text: '{"x":' }, { thoughtSignature: "s" }, { text: "1}" }];
  assert.equal(extractGeminiText({ candidates: [{ content: { parts } }] }), '{"x":1}');
});

test("설정 폼 첫 영역에서 공급자 라디오 2개와 모델 선택 상자를 모두 제공한다", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  const popup = html.match(/<aside id="settingsPopup"[^>]*>([\s\S]*?)<\/aside>/u)?.[1];
  const form = popup?.match(/<form id="settingsForm">([\s\S]*?)<\/form>/u)?.[1];
  assert.ok(form);
  for (const id of ["providerOpenAI", "providerGemini", "aiModelSelect"]) {
    assert.equal(html.split('id="' + id + '"').length, 2);
    assert.ok(form.includes('id="' + id + '"'));
    assert.ok(form.indexOf('id="' + id + '"') < form.indexOf('id="windowMode"'));
  }
  assert.match(form, /type="radio" name="aiProvider" id="providerOpenAI"/u);
  assert.match(form, /type="radio" name="aiProvider" id="providerGemini"/u);
  assert.match(form, /<select id="aiModelSelect"[^>]+required/u);
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString()
};

test("기존 Gemini 단독 설정을 한 번 이관하고 키 추가·재실행 뒤에도 수동 모델만 유지한다", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-model-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY"]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous !== undefined) process.env[name] = previous; });
  }
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ secrets: { gemini: Buffer.from("fixture").toString("base64") } }));
  let settings = new ConfigStore(file, safeStorage);
  const base = { provider: "gemini", model: catalog.gemini[0].id };
  assert.deepEqual(settings.getAISelection(), base);
  const envOnlyFile = path.join(dir, "first-launch.json");
  process.env.GEMINI_API_KEY = "fixture";
  assert.deepEqual(new ConfigStore(envOnlyFile, safeStorage).getAISelection(), base);
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture";
  assert.deepEqual(new ConfigStore(envOnlyFile, safeStorage).getAISelection(), base);
  delete process.env.OPENAI_API_KEY;
  assert.equal(JSON.parse(fs.readFileSync(file)).aiProvider, "gemini");
  settings.save({ openaiKey: "fixture" });
  settings = new ConfigStore(file, safeStorage);
  assert.deepEqual(settings.getAISelection(), base);
  settings.save({ aiProvider: "gemini", aiModel: catalog.gemini[1].id });
  settings.save({ aiProvider: "openai", aiModel: catalog.openai[1].id });
  settings.save({ fontScale: 1.15, clearOpenAI: true });
  settings = new ConfigStore(file, safeStorage);
  assert.deepEqual(settings.getAISelection(), { provider: "openai", model: catalog.openai[1].id });
  assert.deepEqual(settings.getPublicSettings().aiModels, { openai: catalog.openai[1].id, gemini: catalog.gemini[1].id });
  assert.throws(() => settings.save({ aiProvider: "openai", aiModel: catalog.gemini[0].id }), /다시 선택/u);
  assert.equal(settings.getAISelection().model, catalog.openai[1].id);
});

test("키가 없거나 저장한 모델이 사라졌으면 다른 키를 조회하지 않고 요청을 멈춘다", async () => {
  const keys = [];
  let selection = { provider: "gemini", model: catalog.gemini[1].id };
  const client = new AIClient({
    getSelection: () => selection,
    getApiKey: (provider) => { keys.push(provider); return provider === "openai" ? "fixture" : ""; },
    fetchImpl: () => assert.fail("선택한 모델을 쓸 수 없으면 전송하면 안 된다")
  });
  await assert.rejects(client.guess({ input: "인사" }), { code: "NO_API_KEY" });
  selection = { provider: "gemini", model: "removed-model" };
  await assert.rejects(client.guess({ input: "인사" }), { code: "INVALID_AI_SELECTION" });
  assert.deepEqual(keys, ["gemini"]);
});

test("모든 모델에서 일반 호출과 스트리밍은 선택한 모델에만 1회 전송된다", async () => {
  for (const [provider, models] of Object.entries(catalog)) {
    for (const { id: model } of models) {
      const requests = [];
      const keys = [];
      const client = new AIClient({
        getSelection: () => ({ provider, model }),
        getApiKey: (p) => { keys.push(p); return "fixture"; },
        fetchImpl: async (url, options) => {
          requests.push([String(url), JSON.parse(options.body)]);
          return { ok: false, status: 403, json: async () => ({}) };
        }
      });
      await assert.rejects(client.enhance({ input: "테스트" }), { code: "AI_UNAVAILABLE" });
      await assert.rejects(client.chat({ input: "검색하지 말고 인사해 줘" }), { code: "AI_UNAVAILABLE" });
      assert.deepEqual(keys, [provider, provider]);
      assert.equal(requests.length, 2);
      if (provider === "openai") {
        assert.ok(requests.every(([url, body]) => url === "https://api.openai.com/v1/responses" && body.model === model));
      } else {
        assert.ok(requests[0][0].endsWith("/" + model + ":generateContent"));
        assert.ok(requests[1][0].endsWith("/" + model + ":streamGenerateContent?alt=sse"));
      }
    }
  }
});
