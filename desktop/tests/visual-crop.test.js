"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { dataUrlBytes, fitWithin, normalizeRect } = require("../src/renderer/visual-crop");

test("crop rectangle is normalized and clamped to the preview", () => {
  assert.deepEqual(normalizeRect({ x: 90, y: 70 }, { x: -5, y: 10 }, 80, 60), {
    x: 0,
    y: 10,
    width: 80,
    height: 50
  });
  assert.equal(normalizeRect({ x: 2, y: 2 }, { x: 8, y: 8 }, 100, 100), null);
});

test("cropped output dimensions preserve aspect ratio inside the budget", () => {
  assert.deepEqual(fitWithin(4000, 2000), { width: 1600, height: 800 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
});

test("data URL size is calculated without decoding untrusted input", () => {
  assert.equal(dataUrlBytes("data:image/png;base64,YWJjZA=="), 4);
});
