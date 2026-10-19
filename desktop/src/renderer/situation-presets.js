"use strict";

// 선택한 글 강화 화면의 상황 버튼 목록. 사용자가 버튼을 저장·삭제할 수 있고,
// 고친 적이 없으면 shared/rules/writing-rules.json의 기본 목록을 쓴다.
// Android는 process/SituationPresetPolicy.kt에 같은 규칙이 있다.
(function exposeSituationPresets(root, factory) {
  const rules = root?.writingRules || (typeof require === "function" ? require("./writing-rules") : null);
  const api = factory(rules);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.situationPresets = api;
})(typeof globalThis === "object" ? globalThis : this, (rules) => {
  const limits = rules.selection.limits;

  function clean(value, maximum) {
    const characters = Array.from(String(value ?? "").replace(/\s+/gu, " ").trim());
    return characters.slice(0, maximum).join("").trim();
  }

  function defaults() {
    return rules.selection.situations.map(({ label, text }) => ({ label, text }));
  }

  /** 버튼 이름. 설명이 길면 앞부분만 쓰고 말줄임표를 붙인다. */
  function labelFor(text) {
    const characters = Array.from(clean(text, limits.maxSituationText));
    if (characters.length <= limits.maxSituationLabel) return characters.join("");
    return `${characters.slice(0, limits.maxSituationLabel - 1).join("").trim()}…`;
  }

  /** 저장된 목록을 정리한다. 목록이 아니면(고친 적 없음) 기본 목록을 돌려준다. */
  function normalize(list) {
    if (!Array.isArray(list)) return defaults();
    const seen = new Set();
    const result = [];
    for (const item of list) {
      const text = clean(item?.text, limits.maxSituationText);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push({ label: clean(item?.label, limits.maxSituationLabel) || labelFor(text), text });
      if (result.length >= limits.maxSituations) break;
    }
    return result;
  }

  /** 입력한 상황을 새 버튼으로 붙인다. reason: "" | "empty" | "duplicate" | "full" */
  function add(list, text) {
    const current = normalize(list);
    const value = clean(text, limits.maxSituationText);
    if (!value) return { list: current, added: false, reason: "empty" };
    if (current.some((item) => item.text === value)) return { list: current, added: false, reason: "duplicate" };
    if (current.length >= limits.maxSituations) return { list: current, added: false, reason: "full" };
    return { list: [...current, { label: labelFor(value), text: value }], added: true, reason: "" };
  }

  function remove(list, text) {
    return normalize(list).filter((item) => item.text !== text);
  }

  function sameAsDefaults(list) {
    return JSON.stringify(normalize(list)) === JSON.stringify(defaults());
  }

  return { add, clean, defaults, labelFor, limits, normalize, remove, sameAsDefaults };
});
