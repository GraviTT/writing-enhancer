"use strict";

// node scripts/smoke-model-settings.js : 실제 Electron 창과 IPC, 전용 임시 프로필만 사용한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const desktop = path.join(__dirname, "..");
const catalog = require("../src/lib/model-catalog.json");

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "we-settings-qa-"));
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  // 기존 앱과 단축키가 충돌하지 않고 클립보드 제안이 나타나지 않게 한다.
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
    shortcut: "Control+Alt+Shift+F9", selectionShortcut: "Control+Alt+Shift+F10", copyOfferEnabled: false
  }));
  try {
    for (const stage of ["save", "reopen"]) {
      const child = spawnSync(require("electron").trim(), [__filename, stage, profile, "--user-data-dir=" + profile], {
        cwd: desktop, env, stdio: "inherit", timeout: 180000, windowsHide: true
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error("실제 설정 창 검증 실패: " + stage);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
} else {
  const { app } = require("electron");
  const stage = process.argv[2];
  const profile = process.argv[3];
  assert.ok(["save", "reopen"].includes(stage));
  assert.equal(path.dirname(profile), os.tmpdir());
  assert.match(path.basename(profile), /^we-settings-qa-[a-zA-Z0-9]+$/u);
  app.setPath("userData", profile);
  const requests = [];
  // 실제 API로 보내지 않고, 선택한 요청 주소와 모델만 확인한다. 키·본문은 기록하지 않는다.
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), model: JSON.parse(options.body).model });
    return { ok: false, status: 403, json: async () => ({}) };
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.once("browser-window-created", (_event, win) => {
    win.once("ready-to-show", async () => {
      try {
        const run = (script) => win.webContents.executeJavaScript(script);
        const waitFor = async (condition) => {
          for (let attempt = 0; attempt < 80; attempt++) {
            if (await run(condition)) return;
            await pause(100);
          }
          throw new Error("UI 상태 대기 실패: " + condition);
        };
        const open = async () => {
          await run('document.getElementById("settingsButton").click()');
          await waitFor('!document.getElementById("settingsPopup").classList.contains("is-hidden")');
          assert.ok(await run('document.getElementById("settingsForm").contains(document.getElementById("aiModelSelect"))'));
        };
        const save = async () => {
          await run('document.querySelector("#settingsForm button[type=submit]").click()');
          await waitFor('document.getElementById("settingsPopup").classList.contains("is-hidden")');
        };
        const select = async (provider) => {
          const id = provider === "openai" ? "providerOpenAI" : "providerGemini";
          await run('document.getElementById(' + JSON.stringify(id) + ').click()');
          const options = await run('Array.from(document.querySelector("#aiModelSelect").options, o => o.value)');
          assert.deepEqual(options, catalog[provider].map(entry => entry.id));
          const model = catalog[provider][1].id;
          await run('(() => {const s=document.querySelector("#aiModelSelect");s.value=' + JSON.stringify(model) + ';s.dispatchEvent(new Event("change",{bubbles:true}));})()');
        };
        const submitWriting = async () => {
          await run('(() => {const t=document.querySelector("#sourceInput");t.value="회의 공지를 짧게 정리해 주세요.";t.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("#enhanceButton").click();})()');
        };
        await pause(250);
        await run('window.writingEnhancer.togglePanel()');
        await waitFor('document.getElementById("app").dataset.expanded === "true"');
        await pause(500);
        await open();
        if (stage === "save") {
          await select("openai");
          await run('document.querySelector("#openaiKey").value="local-test-fixture"');
          await save();
          await open();
          assert.equal(await run('document.querySelector("#aiModelSelect").value'), catalog.openai[1].id);
          await select("gemini");
          await save();
          await submitWriting();
          await waitFor('document.querySelector("#toastText").textContent.includes("Gemini API 키")');
          assert.deepEqual(requests, []);
          console.log("PASS: GPT/Gemini 모델 직접 선택·저장, 선택한 Gemini 키가 없으면 네트워크 요청 0회");
        } else {
          assert.equal(await run('document.querySelector("#providerGemini").checked'), true);
          assert.equal(await run('document.querySelector("#aiModelSelect").value'), catalog.gemini[1].id);
          await waitFor('(() => {const s=document.querySelector("#aiModelSelect"),r=s.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2, r.top+r.height/2)===s})()');
          await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          await pause(500);
          const aiBox = await run('(() => {const r=document.querySelector("#settingsPopup").getBoundingClientRect();const m=document.querySelector("#aiModelSelect").getBoundingClientRect();return {x:Math.ceil(r.x), y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.ceil(m.bottom-r.top+30)};})()');
          const png = (await win.webContents.capturePage(aiBox)).toPNG();
          const screenshot = path.join(desktop, "qa", "v090-model-settings.png");
          fs.mkdirSync(path.dirname(screenshot), { recursive: true });
          fs.writeFileSync(screenshot, png);
          await select("openai");
          assert.equal(await run('document.querySelector("#aiModelSelect").value'), catalog.openai[1].id);
          await select("gemini");
          await run('document.querySelector("#geminiKey").value="local-test-fixture"');
          await save();
          await submitWriting();
          await waitFor('document.querySelector("#toastText").textContent.includes("모델 사용 권한")');
          assert.equal(requests.length, 1);
          assert.ok(requests[0].url.endsWith("/" + catalog.gemini[1].id + ":generateContent"));
          const persisted = await run('window.writingEnhancer.getSettings().then(s => ({provider:s.aiProvider, models:s.aiModels}))');
          assert.deepEqual(persisted, { provider:"gemini", models:{ openai:catalog.openai[1].id, gemini:catalog.gemini[1].id } });
          console.log("PASS: 재실행 후 저장 선택 복원, 두 키 보유·403 시 Gemini 단 한 번 요청, 선택 유지; " + screenshot);
        }
        win.destroy();
        app.quit();
      } catch (error) {
        console.error(error.message);
        if (!win.isDestroyed()) win.destroy();
        app.exit(1);
      }
    });
  });
  require("../src/main");
}
