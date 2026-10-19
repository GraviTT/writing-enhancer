"use strict";

// 글에 한글이 거의 없으면 번역이 필요한 외국어 글로 본다. Android는 SelectionTextPolicy.suggestsTranslation.
(function exposeTextLanguage(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.textLanguage = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const LETTER = /\p{L}/u;

  function isHangul(code) {
    return (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    );
  }

  function letterCounts(text) {
    let hangul = 0;
    let other = 0;
    for (const character of String(text ?? "")) {
      if (isHangul(character.codePointAt(0))) hangul += 1;
      else if (LETTER.test(character)) other += 1;
    }
    return { hangul, other };
  }

  /** AI가 알려 준 언어 코드가 있으면 그것을, 없으면 한글 비율(20% 미만)을 본다. */
  function suggestsTranslation(text, languageCode = "") {
    const code = String(languageCode ?? "").trim().toLowerCase();
    if (code) return code !== "ko";
    const { hangul, other } = letterCounts(text);
    const letters = hangul + other;
    return letters >= 4 && hangul / letters < 0.2;
  }

  return { letterCounts, suggestsTranslation };
});
