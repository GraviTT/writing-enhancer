"use strict";

const COLLAPSED_WIDTH = 44;
const COLLAPSED_HEIGHT = 164;
const RECOVERABLE_EDGE = 56;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function constrainBounds(bounds, workArea) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), workArea.height);
  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function constrainPartiallyVisibleBounds(bounds, workArea, visibleEdge = RECOVERABLE_EDGE) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), workArea.height);
  const visibleX = Math.min(width, visibleEdge);
  const visibleY = Math.min(height, visibleEdge);
  return {
    x: clamp(
      Math.round(bounds.x),
      workArea.x - width + visibleX,
      workArea.x + workArea.width - visibleX
    ),
    y: clamp(
      Math.round(bounds.y),
      workArea.y - height + visibleY,
      workArea.y + workArea.height - visibleY
    ),
    width,
    height
  };
}

function resolvePanelBounds({ expanded, settings, placement, workArea }) {
  const width = expanded
    ? Math.min(settings.windowWidth, Math.max(380, workArea.width - 16))
    : COLLAPSED_WIDTH;
  const height = expanded
    ? Math.min(settings.windowHeight, Math.max(560, workArea.height - 16))
    : COLLAPSED_HEIGHT;
  const side = placement?.side === "left" ? "left" : settings.dockSide === "left" ? "left" : "right";
  const centeredY = Math.round(workArea.y + (workArea.height - height) / 2);
  const requested = {
    x:
      settings.windowMode === "docked"
        ? side === "left"
          ? workArea.x
          : workArea.x + workArea.width - width
        : Number.isFinite(placement?.x)
          ? placement.x
          : workArea.x + workArea.width - width,
    y: Number.isFinite(placement?.y) ? placement.y : centeredY,
    width,
    height
  };
  const constrained =
    settings.windowMode === "free"
      ? constrainPartiallyVisibleBounds(requested, workArea)
      : constrainBounds(requested, workArea);
  return { ...constrained, side };
}

function finalizeDraggedBounds({ bounds, workArea, mode }) {
  const constrained =
    mode === "free"
      ? constrainPartiallyVisibleBounds(bounds, workArea)
      : constrainBounds(bounds, workArea);
  const center = constrained.x + constrained.width / 2;
  const displayCenter = workArea.x + workArea.width / 2;
  const side = center < displayCenter ? "left" : "right";
  if (mode === "docked") {
    constrained.x =
      side === "left" ? workArea.x : workArea.x + workArea.width - constrained.width;
  }
  return { ...constrained, side };
}

module.exports = {
  COLLAPSED_HEIGHT,
  COLLAPSED_WIDTH,
  RECOVERABLE_EDGE,
  constrainBounds,
  constrainPartiallyVisibleBounds,
  finalizeDraggedBounds,
  resolvePanelBounds
};
