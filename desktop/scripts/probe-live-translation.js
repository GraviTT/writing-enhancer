"use strict";

// Optional, opt-in paid check. The app's normal key reader authenticates; no keys or personal text are logged.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app, safeStorage } = require("electron");
const { ConfigStore } = require("../src/lib/config-store");
const { AIClient } = require("../src/lib/ai-client");
const catalog = require("../src/lib/model-catalog.json");
if (!process.argv.includes("--two-synthetic-translations")) throw new Error("유료 API 확인 옵션이 필요합니다.");
const { appId, productName } = require("../package.json").build;
app.setName(productName);
app.setAppUserModelId(appId);
const original = path.join(app.getPath("appData"), productName, "settings.json");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "we-translation-qa-"));
const nativeKeyContext = process.argv.includes("--normal-storage-context");
app.setPath("userData", nativeKeyContext ? path.dirname(original) : temporary);
app.setPath("sessionData", nativeKeyContext ? path.dirname(original) : temporary);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let passes = 0;
  try {
    if (nativeKeyContext && !app.requestSingleInstanceLock()) {
      console.log("SKIP: 실행 중인 글 강화기를 닫은 뒤 다시 확인해 주세요.");
      return;
    }
    if (!fs.existsSync(original)) { console.log("SKIP: 설치본 설정이 없습니다."); return; }
    // ConfigStore의 구버전 이관은 메모리에서만 적용한다. 실제 settings 파일의 변경을 금지한다.
    const write = fs.writeFileSync;
    let store;
    try {
      fs.writeFileSync = function (name, ...args) {
        if (typeof name === "string" && path.resolve(name) === original) return;
        return write.call(this, name, ...args);
      };
      store = new ConfigStore(original, safeStorage);
    } finally {
      fs.writeFileSync = write;
    }
    const publicState = store.getPublicSettings();
    for (const provider of ["openai", "gemini"]) {
      const model = catalog[provider][1].id;
      if (!publicState[provider === "openai" ? "hasOpenAIKey" : "hasGeminiKey"]) {
        console.log("SKIP", provider, model, "등록된 키 없음");
        continue;
      }
      let status = 0;
      const client = new AIClient({
        getApiKey: store.getApiKey.bind(store), getSelection: () => ({ provider, model }),
        fetchImpl: async (url, options) => {
          const intended = provider === "openai" ? "https://api.openai.com/v1/responses"
            : "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
          if (String(url) !== intended) throw new Error("Unexpected route");
          const response = await fetch(url, options);
          status = response.status;
          return response;
        }
      });
      try {
        // 번역 경로에는 기록, 장기 기억, 실제 원문·현재 화면이 포함되지 않는다.
        const r = await client.translate({ input: "종이컵을 책상 위에 놓아 주세요.", targetLanguage: "en" });
        const passed = /cup/iu.test(r.translatedText) && /desk|table/iu.test(r.translatedText);
        if (passed) passes++;
        console.log(passed ? "PASS" : "REVIEW", provider, model, "HTTP", status, "합성문 영문 번역 핵심어 확인:", passed);
      } catch (e) {
        console.log("NOT VERIFIED", provider, model, "HTTP", status || "없음", e.code || "UNKNOWN");
      }
    }
  } finally { app.exit(passes === 2 ? 0 : 1); }
}).catch(() => app.exit(1));
app.on("quit", () => {
  try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); } catch {}
});
