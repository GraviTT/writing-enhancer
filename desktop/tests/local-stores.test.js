"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ConfigStore } = require("../src/lib/config-store");
const { DraftStore } = require("../src/lib/draft-store");
const { HistoryStore } = require("../src/lib/history-store");
const { MemoryStore } = require("../src/lib/memory-store");
const { SideChatStore } = require("../src/lib/side-chat-store");
const { finalizeDraggedBounds, resolvePanelBounds } = require("../src/lib/window-layout");

const PNG_DATA = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2
]).toString("base64");

async function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".test-local-store-"));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^encrypted:/u, "")
};

test("임시 저장은 상황·입력·답변과 현재 결과 버전을 복원한다", () =>
  withDirectory((directory) => {
    const store = new DraftStore(path.join(directory, "draft.json"));
    store.save({
      situation: "팀장에게 보고",
      input: "일정 하루 늦음",
      reply: "조금 더 부드럽게",
      guessAnswer: "승인 전",
      guessAssumption: "팀장에게 승인 요청",
      guessQuestion: "확정 일정인가요?",
      versions: [
        { completedText: "일정이 늦습니다.", followUp: "괜찮나요?" },
        {
          completedText: "검수 일정을 하루 연장하고자 합니다.",
          followUp: "이대로 보낼까요?"
        }
      ],
      versionIndex: 1,
      attachments: [
        {
          id: "screen",
          name: "현재 화면.png",
          mimeType: "image/png",
          kind: "image",
          source: "screen",
          size: Buffer.from(PNG_DATA, "base64").length,
          data: PNG_DATA
        }
      ]
    });
    const restored = store.load();
    assert.equal(restored.situation, "팀장에게 보고");
    assert.equal(restored.reply, "조금 더 부드럽게");
    assert.equal(restored.guessQuestion, "확정 일정인가요?");
    assert.equal(restored.attachments[0].source, "screen");
    assert.equal(restored.attachments[0].data, PNG_DATA);
    assert.equal(restored.versions[0].completedText, "일정이 늦습니다.");
    assert.equal(restored.versionIndex, 1);
    assert.equal(store.clear(), true);
    assert.equal(store.load().input, "");
  }));

test("연속 텍스트 자동 저장은 첨부 캐시를 다시 쓰지 않는다", async () =>
  withDirectory(async (directory) => {
    const filePath = path.join(directory, "draft.json");
    const store = new DraftStore(filePath);
    store.save({
      input: "처음 입력",
      attachments: [
        {
          id: "screen",
          name: "현재 화면.png",
          mimeType: "image/png",
          kind: "image",
          source: "screen",
          size: Buffer.from(PNG_DATA, "base64").length,
          data: PNG_DATA
        }
      ]
    });
    const metadata = JSON.parse(fs.readFileSync(filePath, "utf8")).attachments[0];
    const cachePath = path.join(`${filePath}.attachments`, metadata.cacheName);
    const before = fs.statSync(cachePath, { bigint: true }).mtimeNs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.save({ input: "타이핑 후 입력", situation: "보고" });
    const after = fs.statSync(cachePath, { bigint: true }).mtimeNs;
    assert.equal(after, before);
    assert.equal(store.load().attachments[0].name, "현재 화면.png");
  }));

test("히스토리는 버전을 보존하고 항목별 불러오기와 삭제를 지원한다", () =>
  withDirectory((directory) => {
    const store = new HistoryStore(path.join(directory, "history.json"));
    const first = store.upsert({
      situation: "회사 보고",
      input: "일정 늦음",
      versions: [
        { completedText: "일정이 늦습니다.", followUp: "더 정중할까요?" },
        { completedText: "검수 일정을 하루 연장하고자 합니다.", followUp: "이대로 보낼까요?" }
      ],
      versionIndex: 1
    });
    assert.equal(store.list()[0].versionCount, 2);
    assert.equal(store.list()[0].inputPreview, "일정 늦음");
    assert.equal(store.get(first.id).versions[0].completedText, "일정이 늦습니다.");
    assert.equal(store.get(first.id).versions[0].enhancementLevel, 3);
    assert.equal(store.remove(first.id), 1);
    assert.equal(store.list().length, 0);
  }));

test("사이드 채팅은 글 기록과 별도 파일에 대화와 창 위치만 제한 저장한다", () =>
  withDirectory((directory) => {
    const filePath = path.join(directory, "side-chat.json");
    const store = new SideChatStore(filePath);
    for (let index = 0; index < 31; index += 1) {
      store.appendExchange(`질문 ${index}`, `답변 ${index}`);
    }
    store.saveWindowBounds({ x: -200, y: 30, width: 900, height: 200 });
    const restored = new SideChatStore(filePath);
    assert.equal(restored.list().length, 60);
    assert.equal(restored.list()[0].content, "질문 1");
    assert.deepEqual(restored.getWindowBounds(), {
      x: -200,
      y: 30,
      width: 680,
      height: 480
    });
    assert.equal(restored.clear(), 60);
    assert.equal(restored.list().length, 0);
    assert.equal(restored.getWindowBounds().width, 680);
  }));

test("사이드 채팅 사용자 메시지를 수정하면 해당 지점 이후를 제거하고 새 답변을 붙인다", () =>
  withDirectory((directory) => {
    const store = new SideChatStore(path.join(directory, "side-chat.json"));
    store.appendExchange("첫 질문", "첫 답변");
    store.appendExchange("수정 전 질문", "제거될 답변");
    store.appendExchange("제거될 질문", "제거될 마지막 답변");
    const target = store.list().find((message) => message.content === "수정 전 질문");

    const truncated = store.rewriteFromUser(target.id, "수정된 질문");
    assert.deepEqual(
      truncated.map((message) => message.content),
      ["첫 질문", "첫 답변", "수정된 질문"]
    );
    const completed = store.appendAssistant("수정된 질문의 새 답변");
    assert.deepEqual(
      completed.map((message) => message.content),
      ["첫 질문", "첫 답변", "수정된 질문", "수정된 질문의 새 답변"]
    );
    assert.equal(new SideChatStore(path.join(directory, "side-chat.json")).list().length, 4);
  }));

test("사이드 채팅은 AI 검색 답변의 안전한 출처만 함께 보존한다", () =>
  withDirectory((directory) => {
    const filePath = path.join(directory, "side-chat.json");
    const store = new SideChatStore(filePath);
    store.appendExchange(
      "최신 내용을 찾아줘",
      "확인한 답변",
      [
        { title: "공식 출처", url: "https://example.com/source" },
        { title: "차단할 링크", url: "javascript:alert(1)" }
      ],
      ["공식 발표 원문은?", "공식 발표 원문은?", "시점별 변화를 비교해 줘"]
    );
    const restored = new SideChatStore(filePath).list();
    assert.deepEqual(restored[1].sources, [
      { title: "공식 출처", url: "https://example.com/source", cited: false, query: "" }
    ]);
    assert.deepEqual(restored[0].sources, []);
    assert.deepEqual(restored[1].relatedQueries, [
      "공식 발표 원문은?",
      "시점별 변화를 비교해 줘"
    ]);
    assert.deepEqual(restored[0].relatedQueries, []);
    assert.equal(restored[1].externalGrounding, true);
    assert.equal(restored[0].externalGrounding, false);
  }));

test("사이드 채팅은 화면 원본 대신 외부 provenance boolean만 저장한다", () =>
  withDirectory((directory) => {
    const filePath = path.join(directory, "side-chat.json");
    const store = new SideChatStore(filePath);
    store.appendExchange(
      "이 화면을 설명해줘",
      "화면을 확인한 답변",
      [],
      [],
      { externalGrounding: true }
    );
    const raw = fs.readFileSync(filePath, "utf8");
    const restored = new SideChatStore(filePath).list();
    assert.equal(restored[1].externalGrounding, true);
    assert.doesNotMatch(raw, /(?:image\/png|base64|screenAttachment|화면 원본)/u);
  }));

test("검색 출처를 확인하지 못한 답변 표시는 AI 메시지에만 저장하고 복원한다", () =>
  withDirectory((directory) => {
    const filePath = path.join(directory, "side-chat.json");
    const store = new SideChatStore(filePath);
    store.appendExchange("최신 규정 검색해줘", "확인하지 못했어요", [], [], {
      externalGrounding: true,
      sourcesMissing: true
    });
    store.appendExchange("고마워", "천만에요", [], [], { externalGrounding: false });
    const restored = new SideChatStore(filePath).list();
    assert.equal(restored[0].sourcesMissing, false);
    assert.equal(restored[1].sourcesMissing, true);
    assert.equal(restored[3].sourcesMissing, false);
    const edited = store.rewriteFromUser(restored[2].id, "정말 고마워");
    const reply = store.appendAssistant("다시 확인하지 못했어요", [], [], {
      externalGrounding: true,
      sourcesMissing: true
    });
    assert.equal(edited.length, 3);
    assert.equal(reply.at(-1).sourcesMissing, true);
  }));

test("provenance 필드가 없던 기존 AI 메시지는 업그레이드 시 보수적으로 외부 유래로 취급한다", () =>
  withDirectory((directory) => {
    const filePath = path.join(directory, "side-chat.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        messages: [
          { role: "user", content: "기존 질문" },
          { role: "assistant", content: "출처 여부를 알 수 없는 기존 답변" }
        ]
      }),
      "utf8"
    );
    const restored = new SideChatStore(filePath).list();
    assert.equal(restored[0].externalGrounding, false);
    assert.equal(restored[1].externalGrounding, true);
  }));

test("기억은 사용자가 직접 수정하면 명시적 장기 기억으로 갱신된다", () =>
  withDirectory((directory) => {
    const store = new MemoryStore(path.join(directory, "memories.json"));
    const [id] = store.addCandidates([
      {
        type: "style_rule",
        value: "고객 메시지는 결론부터 짧게 작성한다.",
        scope: "고객 메시지",
        confidence: 0.9,
        source: "explicit",
        conflict_key: "customer_message_style",
        keywords: ["고객", "메시지"]
      }
    ]);
    const updated = store.update(id, {
      value: "고객 메시지는 결론부터 짧고 정중하게 작성한다.",
      scope: "외부 고객 메시지"
    });
    assert.equal(updated.source, "explicit");
    assert.equal(updated.retention, "long_term");
    assert.equal(updated.scope, "외부 고객 메시지");
    assert.throws(
      () => store.update(id, { value: "API key abc123을 기억한다." }),
      /민감하지 않은/
    );
  }));

test("설정은 가독성 하한과 크기 범위를 지키고 API 키를 암호화한다", () =>
  withDirectory((directory) => {
    const filePath = path.join(directory, "settings.json");
    const store = new ConfigStore(filePath, safeStorage);
    const saved = store.save({
      windowMode: "free",
      windowOpacity: 0.1,
      fontScale: 5,
      windowWidth: 2_000,
      windowHeight: 100,
      memoryAdditionsEnabled: false,
      openaiKey: "test-secret"
    });
    assert.equal(saved.windowMode, "free");
    assert.equal(saved.windowOpacity, 0.55);
    assert.equal(saved.memoryAdditionsEnabled, false);
    assert.equal(saved.fontScale, 1.3);
    assert.equal(saved.windowWidth, 680);
    assert.equal(saved.windowHeight, 560);
    assert.equal(store.getApiKey("openai"), "test-secret");
    assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /test-secret/);
    store.savePlacement(true, { x: 20, y: 40, side: "left" });
    store.savePlacement(false, { x: 1_100, y: 120, side: "right" });
    assert.deepEqual(store.getPlacement(true), { x: 20, y: 40, side: "left" });
    assert.deepEqual(store.getPlacement(false), { x: 1_100, y: 120, side: "right" });
  }));

test("고정 모드는 좌우 가장자리에 스냅하고 자유 모드는 선택 위치를 유지한다", () => {
  const workArea = { x: 0, y: 0, width: 1200, height: 800 };
  const settings = {
    windowMode: "docked",
    windowWidth: 440,
    windowHeight: 700,
    dockSide: "left"
  };
  const left = resolvePanelBounds({
    expanded: true,
    settings,
    placement: { x: 300, y: 70, side: "left" },
    workArea
  });
  assert.equal(left.x, 0);
  assert.equal(left.y, 70);
  const collapsedLeft = resolvePanelBounds({
    expanded: false,
    settings,
    placement: { x: 200, y: 210, side: "left" },
    workArea
  });
  assert.equal(collapsedLeft.x, 0);
  assert.equal(collapsedLeft.y, 210);
  assert.equal(collapsedLeft.width, 44);
  const right = finalizeDraggedBounds({
    bounds: { x: 800, y: 90, width: 440, height: 700 },
    workArea,
    mode: "docked"
  });
  assert.equal(right.x, 760);
  assert.equal(right.side, "right");
  const free = finalizeDraggedBounds({
    bounds: { x: 333, y: 55, width: 440, height: 700 },
    workArea,
    mode: "free"
  });
  assert.equal(free.x, 333);
  assert.equal(free.y, 55);
  const recoveredAfterMonitorRemoval = finalizeDraggedBounds({
    bounds: { x: 2_900, y: -600, width: 440, height: 700 },
    workArea,
    mode: "free"
  });
  assert.equal(recoveredAfterMonitorRemoval.x, 1144);
  assert.equal(recoveredAfterMonitorRemoval.y, -600);
});
