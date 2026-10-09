(function exposeEnhancementLevels(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.enhancementLevels = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const MIN = 1;
  const MAX = 5;
  const DEFAULT = 3;
  const LEVELS = Object.freeze([
    Object.freeze({
      value: 1,
      label: "핵심 요약",
      instruction: "핵심 의미와 필수 사실만 남기고 반복·군더더기를 적극 제거해 짧고 선명하게 정리한다.",
      lengthTarget: "원문 글자 수의 약 45~60%",
      minimumLengthRatio: 0.45,
      maximumLengthRatio: 0.6
    }),
    Object.freeze({
      value: 2,
      label: "간결 정리",
      instruction: "중복과 우회 표현을 줄이고 문장 순서를 정리해 원문보다 분명히 간결하게 만든다.",
      lengthTarget: "원문 글자 수의 약 70~85%",
      minimumLengthRatio: 0.7,
      maximumLengthRatio: 0.85
    }),
    Object.freeze({
      value: 3,
      label: "원문 충실",
      instruction: "원문의 의미·말투·정보량을 유지하고 맞춤법 교정과 구조 최적화에 집중한다.",
      lengthTarget: "원문 글자 수의 약 90~110%",
      minimumLengthRatio: 0.9,
      maximumLengthRatio: 1.1
    }),
    Object.freeze({
      value: 4,
      label: "내용 보완",
      instruction: "주어진 사실과 문맥 안에서 설명·연결 문장·근거의 표현을 보완해 원문보다 충분히 자세하게 만든다.",
      lengthTarget: "원문 글자 수의 약 120~150%",
      minimumLengthRatio: 1.2,
      maximumLengthRatio: 1.5
    }),
    Object.freeze({
      value: 5,
      label: "풍부하게 확장",
      instruction: "새 사실을 만들지 않는 범위에서 의도·논리·설명을 충분히 풀어 쓰고 구성과 표현을 폭넓게 확장한다.",
      lengthTarget: "원문 글자 수의 약 150~200%",
      minimumLengthRatio: 1.5,
      maximumLengthRatio: 2
    })
  ]);

  function normalize(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(MAX, Math.max(MIN, number)) : DEFAULT;
  }

  function definition(value) {
    return LEVELS[normalize(value) - MIN];
  }

  function targetCharacterRange(materialLength, value) {
    const level = definition(value);
    const base = Math.max(1, Math.round(Number(materialLength) || 0));
    const minimum = Math.max(1, Math.round(base * level.minimumLengthRatio));
    const maximum = Math.max(minimum, Math.round(base * level.maximumLengthRatio));
    return { minimum, maximum };
  }

  return {
    DEFAULT,
    LEVELS,
    MAX,
    MIN,
    definition,
    normalize,
    targetCharacterRange
  };
});
