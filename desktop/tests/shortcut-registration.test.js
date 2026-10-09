"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SHORTCUT,
  registerWithFallback
} = require("../src/lib/shortcut-registration");

test("설정한 단축키를 등록할 수 있으면 그대로 사용한다", () => {
  const calls = [];
  const status = registerWithFallback({
    preferred: "CommandOrControl+Alt+G",
    register: (shortcut) => calls.push(shortcut)
  });
  assert.equal(status.registered, true);
  assert.equal(status.activeShortcut, "CommandOrControl+Alt+G");
  assert.equal(status.warning, "");
  assert.deepEqual(calls, ["CommandOrControl+Alt+G"]);
});

test("설정 단축키가 점유되면 기본 단축키로 대체하고 안내한다", () => {
  const calls = [];
  const status = registerWithFallback({
    preferred: "CommandOrControl+Alt+G",
    register: (shortcut) => {
      calls.push(shortcut);
      if (shortcut !== DEFAULT_SHORTCUT) throw new Error("occupied");
    }
  });
  assert.equal(status.registered, true);
  assert.equal(status.activeShortcut, DEFAULT_SHORTCUT);
  assert.match(status.warning, new RegExp(DEFAULT_SHORTCUT.replaceAll("+", "\\+"), "u"));
  assert.deepEqual(calls, ["CommandOrControl+Alt+G", DEFAULT_SHORTCUT]);
});

test("설정값과 기본값이 모두 실패해도 예외 없이 손잡이·트레이 안내 상태를 반환한다", () => {
  const status = registerWithFallback({
    preferred: "CommandOrControl+Alt+G",
    register: () => {
      throw new Error("occupied");
    }
  });
  assert.equal(status.registered, false);
  assert.equal(status.activeShortcut, "");
  assert.equal(status.errors.length, 2);
  assert.match(status.warning, /화면 손잡이나 트레이 아이콘/u);
});
