"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { APP_USER_MODEL_ID, ensureInstallShortcuts } = require("../src/lib/install-shortcuts");

// shell.readShortcutLink/writeShortcutLink 대신 바로 가기 내용을 JSON 파일로 남긴다.
function fakeShell() {
  return {
    writes: [],
    readShortcutLink(file) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    },
    writeShortcutLink(file, operation, options) {
      this.writes.push({ file: path.basename(file), operation });
      const current = operation === "update" ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      fs.writeFileSync(file, JSON.stringify({ ...current, ...options }), "utf8");
      return true;
    }
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "we-shortcuts-"));
  const install = path.join(root, "Programs", "WritingEnhancer");
  fs.mkdirSync(install, { recursive: true });
  const execPath = path.join(install, "글 강화기.exe");
  fs.writeFileSync(execPath, "");
  const options = {
    execPath,
    version: "0.7.0",
    desktopDirectory: path.join(root, "Desktop"),
    startMenuDirectory: path.join(root, "Start Menu", "Programs"),
    statePath: path.join(root, "userData", "install-shortcuts.json"),
    temporaryDirectory: path.join(root, "Temp")
  };
  fs.mkdirSync(options.desktopDirectory, { recursive: true });
  return { root, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("처음 켜면 바탕화면과 시작 메뉴에 앱 ID가 붙은 바로 가기를 만든다", () => {
  const { options, cleanup } = setup();
  try {
    const shell = fakeShell();
    const result = ensureInstallShortcuts({ ...options, shell });
    assert.equal(result.firstRunOfVersion, true);
    assert.equal(result.desktop.created, true);
    assert.equal(result.startMenu.created, true);
    const desktopLink = JSON.parse(fs.readFileSync(path.join(options.desktopDirectory, "글 강화기.lnk"), "utf8"));
    assert.equal(desktopLink.target, options.execPath);
    assert.equal(desktopLink.appUserModelId, APP_USER_MODEL_ID);
    assert.equal(desktopLink.cwd, path.dirname(options.execPath));
    assert.ok(fs.existsSync(path.join(options.startMenuDirectory, "글 강화기.lnk")));
    assert.equal(JSON.parse(fs.readFileSync(options.statePath, "utf8")).version, "0.7.0");
  } finally {
    cleanup();
  }
});

test("같은 버전에서는 지운 바탕화면 바로 가기를 다시 만들지 않고, 업데이트 뒤에는 다시 만든다", () => {
  const { options, cleanup } = setup();
  try {
    const shell = fakeShell();
    ensureInstallShortcuts({ ...options, shell });
    fs.rmSync(path.join(options.desktopDirectory, "글 강화기.lnk"));
    fs.rmSync(path.join(options.startMenuDirectory, "글 강화기.lnk"));

    const again = ensureInstallShortcuts({ ...options, shell });
    assert.equal(again.firstRunOfVersion, false);
    assert.equal(again.desktop, null);
    assert.equal(fs.existsSync(path.join(options.desktopDirectory, "글 강화기.lnk")), false);
    // 업데이트 알림에 필요한 시작 메뉴 바로 가기는 늘 둔다.
    assert.equal(again.startMenu.created, true);

    const updated = ensureInstallShortcuts({ ...options, version: "0.7.1", shell });
    assert.equal(updated.firstRunOfVersion, true);
    assert.equal(updated.desktop.created, true);
  } finally {
    cleanup();
  }
});

test("같은 실행 파일을 가리키는 바로 가기가 있으면 이름을 바꾸지 않고 고친다", () => {
  const { options, cleanup } = setup();
  try {
    const shell = fakeShell();
    const existing = path.join(options.desktopDirectory, "글 강화기 - 바로 가기.lnk");
    fs.writeFileSync(existing, JSON.stringify({ target: options.execPath.toUpperCase() }), "utf8");
    // 이름은 같지만 다른 프로그램을 가리키는 바로 가기는 건드리지 않는다.
    const other = path.join(options.desktopDirectory, "글 강화기.lnk");
    fs.writeFileSync(other, JSON.stringify({ target: "C:\\Old\\글 강화기.exe" }), "utf8");

    const result = ensureInstallShortcuts({ ...options, shell });
    assert.equal(result.desktop.created, false);
    assert.equal(path.basename(result.desktop.file), "글 강화기 - 바로 가기.lnk");
    assert.equal(JSON.parse(fs.readFileSync(existing, "utf8")).appUserModelId, APP_USER_MODEL_ID);
    assert.equal(JSON.parse(fs.readFileSync(other, "utf8")).target, "C:\\Old\\글 강화기.exe");
    assert.deepEqual(
      fs.readdirSync(options.desktopDirectory).sort(),
      ["글 강화기 - 바로 가기.lnk", "글 강화기.lnk"].sort()
    );
  } finally {
    cleanup();
  }
});

test("이름이 겹치면 번호를 붙이고, 임시 폴더에서 실행하면 만들지 않는다", () => {
  const { options, cleanup } = setup();
  try {
    const shell = fakeShell();
    fs.writeFileSync(path.join(options.desktopDirectory, "글 강화기.lnk"), JSON.stringify({ target: "C:\\other.exe" }));
    const result = ensureInstallShortcuts({ ...options, shell });
    assert.equal(path.basename(result.desktop.file), "글 강화기 (2).lnk");

    const temporaryExec = path.join(options.temporaryDirectory, "zip", "글 강화기.exe");
    const skipped = ensureInstallShortcuts({ ...options, execPath: temporaryExec, version: "0.8.0", shell });
    assert.equal(skipped.skipped, "temporary");
  } finally {
    cleanup();
  }
});
