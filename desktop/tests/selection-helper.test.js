"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  HELPER_SCRIPT,
  MAX_SELECTION_CHARACTERS,
  SelectionHelper,
  appLabel,
  cleanSelection,
  copyMode,
  parseHelperLine,
  pasteMode,
  restoreClipboard,
  snapshotClipboard
} = require("../src/lib/selection-helper");

test("터미널과 편집기에서는 실행 중인 명령을 끊는 Ctrl+C를 보내지 않는다", () => {
  assert.equal(copyMode("WindowsTerminal"), "insert-only");
  assert.equal(copyMode("powershell.exe"), "insert-only");
  assert.equal(copyMode("Code"), "insert-only");
  assert.equal(copyMode("chrome"), "insert-then-c");
  assert.equal(copyMode("KakaoTalk"), "insert-then-c");
  assert.equal(pasteMode("cmd"), "shift-insert");
  assert.equal(pasteMode("Code"), "ctrl-v");
  assert.equal(pasteMode("notepad"), "ctrl-v");
});

test("바꿔 넣을 프로그램 이름은 파일 설명, 창 제목 끝, 프로세스 이름 순으로 고른다", () => {
  assert.equal(appLabel({ description: "메모장", title: "제목 없음 - 메모장", process: "Notepad" }), "메모장");
  assert.equal(
    appLabel({ description: "Application Frame Host", title: "계산기 - 설정", process: "ApplicationFrameHost" }),
    "설정"
  );
  assert.equal(appLabel({ description: "", title: "", process: "KakaoTalk.exe" }), "kakaotalk");
  assert.equal(appLabel(null), "");
});

test("가져온 글은 줄바꿈을 맞추고 앞뒤 공백을 지우고 길이를 제한한다", () => {
  assert.equal(cleanSelection("  첫 줄\r\n둘째 줄\u0000\r셋째  "), "첫 줄\n둘째 줄\n셋째");
  assert.equal(cleanSelection("가".repeat(MAX_SELECTION_CHARACTERS + 50)).length, MAX_SELECTION_CHARACTERS);
  assert.equal(cleanSelection(undefined), "");
});

function fakeClipboard(initial = {}) {
  const store = { ...initial };
  return {
    store,
    readText: () => store.text || "",
    readHTML: () => store.html || "",
    readRTF: () => store.rtf || "",
    readImage: () => ({ isEmpty: () => !store.image }),
    availableFormats: () => store.formats || Object.keys(store).filter((key) => key !== "formats"),
    write(data) {
      for (const key of Object.keys(store)) delete store[key];
      Object.assign(store, data);
    },
    writeText(text) {
      for (const key of Object.keys(store)) delete store[key];
      store.text = text;
    },
    clear() {
      for (const key of Object.keys(store)) delete store[key];
    }
  };
}

test("선택한 글을 가져온 뒤 원래 클립보드의 글과 서식을 되돌린다", () => {
  const clipboard = fakeClipboard({ text: "원래 글", html: "<b>원래 글</b>" });
  const snapshot = snapshotClipboard(clipboard);
  clipboard.writeText("선택한 글");
  assert.equal(restoreClipboard(clipboard, snapshot), true);
  assert.deepEqual(clipboard.store, { text: "원래 글", html: "<b>원래 글</b>" });

  const empty = fakeClipboard({ formats: [] });
  const emptySnapshot = snapshotClipboard(empty);
  empty.writeText("선택한 글");
  restoreClipboard(empty, emptySnapshot);
  assert.equal(empty.readText(), "");

  // 파일 목록처럼 읽을 수 없는 내용만 있었다면 되돌리지 않는다.
  const files = fakeClipboard({ formats: ["FileNameW"] });
  const fileSnapshot = snapshotClipboard(files);
  assert.equal(fileSnapshot.restorable, false);
  files.writeText("선택한 글");
  assert.equal(restoreClipboard(files, fileSnapshot), false);
  assert.equal(files.readText(), "선택한 글");
});

test("도우미 스크립트는 영문만 쓰고, 복사·붙여넣기·창 찾기 명령을 처리한다", () => {
  assert.match(HELPER_SCRIPT, /^[\x09\x0a\x0d\x20-\x7e]*$/u);
  assert.doesNotMatch(HELPER_SCRIPT, /\$\{/u);
  for (const command of ["'foreground'", "'copy'", "'paste'", "'previous'"]) {
    assert.ok(HELPER_SCRIPT.includes(command), command);
  }
  assert.match(HELPER_SCRIPT, /SendWait\('\^\{INSERT\}'\)/u);
  assert.match(HELPER_SCRIPT, /\$mode -eq 'insert-then-c'/u);
  assert.match(HELPER_SCRIPT, /GetClipboardSequenceNumber/u);
  assert.match(HELPER_SCRIPT, /\$ProgressPreference = 'SilentlyContinue'/u);
});

test("도우미 응답 줄은 BOM이 있어도 읽고, JSON이 아니면 버린다", () => {
  assert.deepEqual(parseHelperLine('\uFEFF{"id":0,"ok":true,"ready":true}'), { id: 0, ok: true, ready: true });
  assert.equal(parseHelperLine("Add-Type warning"), null);
  assert.equal(parseHelperLine('{"ok":true}'), null);
});

function fakeSpawn(responder) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      lines: [],
      write(line) {
        this.lines.push(line);
        const [id, ...rest] = line.trim().split(" ");
        const reply = responder(rest);
        if (reply) setImmediate(() => child.stdout.emit("data", `${JSON.stringify({ id: Number(id), ...reply })}\n`));
      },
      end() {}
    };
    child.kill = () => child.emit("exit", 0);
    calls.push({ command, args, options, child });
    setImmediate(() => child.stdout.emit("data", '{"id":0,"ok":true,"ready":true}\r\n'));
    return child;
  };
  return { calls, spawnImpl };
}

test("도우미는 PowerShell 하나를 숨겨 띄우고 요청마다 번호로 응답을 맞춘다", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "we-helper-"));
  try {
    const { calls, spawnImpl } = fakeSpawn((parts) =>
      parts[0] === "foreground"
        ? { ok: true, hwnd: "1234", pid: 77, process: "notepad", description: "메모장", title: "" }
        : { ok: true, changed: parts[1] === "insert-then-c" }
    );
    const helper = new SelectionHelper({ directory, spawnImpl, platform: "win32" });
    const target = await helper.request("foreground");
    assert.equal(target.hwnd, "1234");
    const copied = await helper.request("copy", ["insert-then-c"]);
    assert.equal(copied.changed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "powershell.exe");
    assert.ok(calls[0].args.includes("-File"));
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(fs.readFileSync(path.join(directory, "selection-helper.ps1"), "utf8"), HELPER_SCRIPT);
    assert.deepEqual(calls[0].child.stdin.lines, ["1 foreground\n", "2 copy insert-then-c\n"]);
    await assert.rejects(helper.request("paste", ["12 34", "ctrl-v"]), /잘못된 도우미 요청/u);
    helper.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("도우미가 멈추면 기다리던 요청을 끝내고 다음 요청 때 다시 띄운다", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "we-helper-"));
  try {
    const { calls, spawnImpl } = fakeSpawn(() => null);
    const helper = new SelectionHelper({ directory, spawnImpl, platform: "win32" });
    const waiting = helper.request("foreground");
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls[0].child.emit("exit", 1);
    await assert.rejects(waiting, /멈췄어요/u);
    const second = helper.request("foreground", [], 50);
    await assert.rejects(second, /늦어요/u);
    assert.equal(calls.length, 2);
    helper.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows가 아니면 도우미를 띄우지 않는다", async () => {
  const helper = new SelectionHelper({ directory: os.tmpdir(), platform: "linux" });
  await assert.rejects(helper.request("foreground"), /Windows/u);
});
