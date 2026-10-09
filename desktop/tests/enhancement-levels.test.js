"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const levels = require("../src/renderer/enhancement-levels");

test("강화 범위 중앙은 원문 충실이고 범위를 벗어난 값은 1~5로 제한한다", () => {
  assert.equal(levels.definition(3).label, "원문 충실");
  assert.equal(levels.normalize(-10), 1);
  assert.equal(levels.normalize(99), 5);
  assert.equal(levels.normalize(undefined), 3);
});

test("같은 100자 원문에서 왼쪽과 오른쪽 목표 분량 차이가 명확하다", () => {
  assert.deepEqual(levels.targetCharacterRange(100, 1), {
    minimum: 45,
    maximum: 60
  });
  assert.deepEqual(levels.targetCharacterRange(100, 3), {
    minimum: 90,
    maximum: 110
  });
  assert.deepEqual(levels.targetCharacterRange(100, 5), {
    minimum: 150,
    maximum: 200
  });
});
