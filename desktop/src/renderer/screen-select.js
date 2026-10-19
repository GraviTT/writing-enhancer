"use strict";

// 찍어 둔 화면 위에서 읽을 부분을 드래그로 고른다. 좌표는 이 화면(디스플레이) 기준 CSS 픽셀이다.
(function setupScreenSelect() {
  const api = window.screenSelect;
  const shot = document.querySelector("#shot");
  const shade = document.querySelector("#shade");
  const box = document.querySelector("#box");
  const hint = document.querySelector("#hint");
  const MIN_SIZE = 8;
  let start = null;
  let current = null;

  function rectFrom(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y)
    };
  }

  function draw(rect) {
    box.classList.remove("is-hidden");
    shade.classList.add("is-hidden");
    Object.assign(box.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  }

  function reset() {
    start = null;
    current = null;
    box.classList.add("is-hidden");
    shade.classList.remove("is-hidden");
  }

  api.onImage(({ dataUrl }) => {
    shot.src = dataUrl;
  });

  window.addEventListener("pointerdown", (event) => {
    if (event.button === 2) {
      api.cancel();
      return;
    }
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    current = rectFrom(start, start);
    document.body.setPointerCapture?.(event.pointerId);
  });

  window.addEventListener("pointermove", (event) => {
    if (!start) return;
    current = rectFrom(start, { x: event.clientX, y: event.clientY });
    draw(current);
    hint.textContent = `${Math.round(current.width)} × ${Math.round(current.height)} · 놓으면 이 부분을 읽어요`;
  });

  window.addEventListener("pointerup", () => {
    if (!start) return;
    const rect = current;
    if (rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
      api.done(rect);
      return;
    }
    reset();
    hint.textContent = "조금 더 크게 드래그하세요 · Enter 화면 전체 · Esc 취소";
  });

  window.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      api.cancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      api.done({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    }
  });
})();
