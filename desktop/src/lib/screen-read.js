"use strict";

// 화면에서 고른 영역(화면 좌표, CSS 픽셀)을 찍은 이미지의 픽셀 영역으로 바꾼다.
// 화면 배율이나 캡처 크기 제한 때문에 이미지 크기가 화면 크기와 다를 수 있다.

const MIN_SELECTION = 8;

/** 고른 영역을 화면 안으로 잘라 정리한다. 너무 작으면 null. */
function normalizeSelection(rect, bounds) {
  const values = [rect?.x, rect?.y, rect?.width, rect?.height].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const width = Math.max(1, Number(bounds?.width) || 0);
  const height = Math.max(1, Number(bounds?.height) || 0);
  const left = Math.min(Math.max(values[0], 0), width);
  const top = Math.min(Math.max(values[1], 0), height);
  const right = Math.min(Math.max(values[0] + values[2], 0), width);
  const bottom = Math.min(Math.max(values[1] + values[3], 0), height);
  if (right - left < MIN_SELECTION || bottom - top < MIN_SELECTION) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 화면 좌표 영역을 이미지 픽셀 영역(정수)으로 바꾼다. */
function imageCropRect(selection, bounds, imageSize) {
  const scaleX = imageSize.width / Math.max(1, bounds.width);
  const scaleY = imageSize.height / Math.max(1, bounds.height);
  const x = Math.min(Math.max(Math.floor(selection.x * scaleX), 0), imageSize.width - 1);
  const y = Math.min(Math.max(Math.floor(selection.y * scaleY), 0), imageSize.height - 1);
  const right = Math.min(Math.ceil((selection.x + selection.width) * scaleX), imageSize.width);
  const bottom = Math.min(Math.ceil((selection.y + selection.height) * scaleY), imageSize.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

module.exports = { MIN_SELECTION, imageCropRect, normalizeSelection };
