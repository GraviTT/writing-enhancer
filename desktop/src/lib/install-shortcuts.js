"use strict";

// 처음 설치했거나 새 버전으로 업데이트한 뒤 처음 켤 때 바탕화면 바로 가기를 만든다.
// 같은 실행 파일을 가리키는 바로 가기가 이미 있으면 새로 만들지 않고 그 바로 가기를 고친다.
// 시작 메뉴 바로 가기도 함께 둔다. Windows는 시작 메뉴에 앱 ID가 붙은 바로 가기가 있어야
// 업데이트 알림을 확실히 보여 주고, Windows 검색에서도 앱을 찾을 수 있다.

const fs = require("node:fs");
const path = require("node:path");

const APP_USER_MODEL_ID = "com.writingenhancer.desktop";
const SHORTCUT_BASE_NAME = "글 강화기";
const SHORTCUT_DESCRIPTION = "생각나는 대로 쓰면 전달할 수 있는 글로 완성해 주는 글 강화기";

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();
}

function isInside(directory, file) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shortcutOptions(execPath) {
  return {
    target: execPath,
    cwd: path.dirname(execPath),
    description: SHORTCUT_DESCRIPTION,
    icon: execPath,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  };
}

function findShortcutTo(directory, execPath, shell) {
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".lnk")) continue;
    const file = path.join(directory, name);
    try {
      if (samePath(shell.readShortcutLink(file).target, execPath)) return file;
    } catch {
      // 읽을 수 없는 바로 가기는 건너뛴다.
    }
  }
  return null;
}

function freeShortcutPath(directory) {
  let file = path.join(directory, `${SHORTCUT_BASE_NAME}.lnk`);
  for (let number = 2; fs.existsSync(file); number += 1) {
    file = path.join(directory, `${SHORTCUT_BASE_NAME} (${number}).lnk`);
  }
  return file;
}

/**
 * directory 안에 execPath 바로 가기를 둔다.
 * create가 false면 없을 때 만들지 않는다. refresh가 true면 있던 바로 가기의 대상·아이콘·앱 ID를 고친다.
 */
function ensureShortcut({ directory, execPath, shell, create, refresh }) {
  const existing = findShortcutTo(directory, execPath, shell);
  if (existing) {
    if (refresh) shell.writeShortcutLink(existing, "update", shortcutOptions(execPath));
    return { file: existing, created: false };
  }
  if (!create) return null;
  fs.mkdirSync(directory, { recursive: true });
  const file = freeShortcutPath(directory);
  if (!shell.writeShortcutLink(file, "create", shortcutOptions(execPath))) return null;
  return { file, created: true };
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) || {};
  } catch {
    return {};
  }
}

/**
 * 이 버전을 처음 켰을 때만 바탕화면 바로 가기를 만든다. 사용자가 지운 바로 가기는
 * 다음 업데이트 전까지 다시 만들지 않는다. 시작 메뉴 바로 가기는 없으면 늘 만든다.
 */
function ensureInstallShortcuts({ execPath, version, desktopDirectory, startMenuDirectory, statePath, shell, temporaryDirectory }) {
  if (temporaryDirectory && isInside(temporaryDirectory, execPath)) {
    // 압축 파일을 연 채로 실행하면 임시 폴더에서 돌아가므로 바로 가기를 만들지 않는다.
    return { skipped: "temporary" };
  }
  const state = readState(statePath);
  const firstRunOfVersion = state.version !== version;
  const result = { firstRunOfVersion, desktop: null, startMenu: null };
  try {
    result.desktop = ensureShortcut({
      directory: desktopDirectory,
      execPath,
      shell,
      create: firstRunOfVersion,
      refresh: firstRunOfVersion
    });
  } catch {
    result.desktop = null;
  }
  try {
    result.startMenu = ensureShortcut({
      directory: startMenuDirectory,
      execPath,
      shell,
      create: true,
      refresh: firstRunOfVersion
    });
  } catch {
    result.startMenu = null;
  }
  if (firstRunOfVersion) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  }
  return result;
}

module.exports = {
  APP_USER_MODEL_ID,
  SHORTCUT_BASE_NAME,
  ensureInstallShortcuts,
  ensureShortcut,
  findShortcutTo,
  isInside,
  samePath,
  shortcutOptions
};
