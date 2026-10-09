"use strict";

(function exposeVisualCrop(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.visualCrop = api;
})(typeof window === "object" ? window : globalThis, () => {
  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
  }

  function normalizeRect(start, end, width, height, minimum = 12) {
    const limitWidth = Math.max(1, Number(width) || 1);
    const limitHeight = Math.max(1, Number(height) || 1);
    const left = clamp(Math.min(start.x, end.x), 0, limitWidth);
    const top = clamp(Math.min(start.y, end.y), 0, limitHeight);
    const right = clamp(Math.max(start.x, end.x), 0, limitWidth);
    const bottom = clamp(Math.max(start.y, end.y), 0, limitHeight);
    if (right - left < minimum || bottom - top < minimum) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function fitWithin(width, height, maximumWidth = 1600, maximumHeight = 1200) {
    const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
    const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
    const scale = Math.min(1, maximumWidth / sourceWidth, maximumHeight / sourceHeight);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale))
    };
  }

  function dataUrlBytes(dataUrl) {
    const encoded = String(dataUrl || "").split(",", 2)[1] || "";
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
  }

  return { clamp, normalizeRect, fitWithin, dataUrlBytes };
});
