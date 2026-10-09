"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendVersion,
  availability,
  clampIndex,
  moveIndex
} = require("../src/renderer/version-navigation");

test("이전·다음 이동은 결과 범위를 벗어나지 않는다", () => {
  assert.equal(moveIndex(3, 0, "previous"), 0);
  assert.equal(moveIndex(3, 0, "next"), 1);
  assert.equal(moveIndex(3, 1, "previous"), 0);
  assert.equal(moveIndex(3, 1, "next"), 2);
  assert.equal(moveIndex(3, 2, "next"), 2);
  assert.equal(moveIndex(0, 0, "next"), -1);
});

test("현재 인덱스에 따라 전후 버튼 경계를 정확히 비활성화한다", () => {
  assert.deepEqual(availability(3, 0), { previous: false, next: true });
  assert.deepEqual(availability(3, 1), { previous: true, next: true });
  assert.deepEqual(availability(3, 2), { previous: true, next: false });
  assert.deepEqual(availability(0, 0), { previous: false, next: false });
  assert.equal(clampIndex(3, 99), 2);
});

test("과거 버전에서 재강화해도 기존 중간·후속 결과를 모두 보존하고 끝에 추가한다", () => {
  const original = [
    { completedText: "첫 결과" },
    { completedText: "둘째 결과" },
    { completedText: "셋째 결과" }
  ];
  const appended = appendVersion(original, { completedText: "새 강화 결과" });
  assert.deepEqual(
    appended.versions.map((version) => version.completedText),
    ["첫 결과", "둘째 결과", "셋째 결과", "새 강화 결과"]
  );
  assert.equal(appended.index, 3);
  assert.equal(original.length, 3);
});
