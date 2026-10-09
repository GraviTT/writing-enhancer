"use strict";

const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

function registerWithFallback({
  preferred,
  fallback = DEFAULT_SHORTCUT,
  register
}) {
  const requested = String(preferred || fallback).trim() || fallback;
  const attempts = [...new Set([requested, fallback].filter(Boolean))];
  const errors = [];

  for (const shortcut of attempts) {
    try {
      register(shortcut);
      return {
        registered: true,
        activeShortcut: shortcut,
        warning:
          shortcut === requested
            ? ""
            : `설정한 단축키를 사용할 수 없어 ${shortcut}로 열 수 있어요.`,
        errors
      };
    } catch (error) {
      errors.push({
        shortcut,
        message: error?.message || "단축키 등록 실패"
      });
    }
  }

  return {
    registered: false,
    activeShortcut: "",
    warning:
      "전역 단축키를 등록하지 못했어요. 화면 손잡이나 트레이 아이콘으로 열 수 있어요.",
    errors
  };
}

module.exports = { DEFAULT_SHORTCUT, registerWithFallback };
