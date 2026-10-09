(function exposeSideChatText(root, factory) {
  "use strict";

  const rules =
    typeof module === "object" && module.exports ? require("./side-chat-rules") : root.sideChatRules;
  const api = factory(rules);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.sideChatText = api;
})(typeof globalThis === "object" ? globalThis : this, (rules) => {
  "use strict";

  const { labels, limits } = rules;
  const textValueActions = new Set(rules.actions.textValue);

  // {이름} 자리를 한 번에 바꾼다. 넣은 값 안의 중괄호는 다시 해석하지 않는다.
  function fillTemplate(template, values) {
    return String(template).replace(/\{(\w+)\}/gu, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }

  function progressLabel(progress, elapsedMs) {
    const label =
      progress?.stage === "fallback"
        ? labels.progressFallback
        : progress?.stage === "searching" || progress?.searchRequired === true
          ? labels.progressSearching
          : labels.progressRequesting;
    const seconds = Math.floor(Math.max(0, Number(elapsedMs) || 0) / 1_000);
    return seconds >= limits.progressElapsedAfterSeconds
      ? fillTemplate(labels.progressElapsed, { label, seconds })
      : label;
  }

  function pendingActionLabel(action) {
    if (action?.name === "set_enhancement_level") {
      return fillTemplate(labels.pendingEnhancementLevel, { value: action.value || "?" });
    }
    return labels.pendingActions[action?.name] || labels.pendingFallback;
  }

  function pendingActionPreview(action) {
    const value = String(action?.value || "").trim();
    if (!textValueActions.has(action?.name) || !value) return null;
    return value.length > limits.pendingPreviewCharacters
      ? `${value.slice(0, limits.pendingPreviewCharacters)}…`
      : value;
  }

  return {
    fillTemplate,
    labels,
    pendingActionLabel,
    pendingActionPreview,
    progressLabel
  };
});
