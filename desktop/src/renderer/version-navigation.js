"use strict";

(function exposeVersionNavigation(root, factory) {
  const navigation = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = navigation;
  if (root) root.versionNavigation = navigation;
})(typeof window !== "undefined" ? window : globalThis, () => {
  function clampIndex(length, index) {
    const count = Math.max(0, Number(length) || 0);
    if (count === 0) return -1;
    return Math.max(0, Math.min(Math.trunc(Number(index) || 0), count - 1));
  }

  function moveIndex(length, index, direction) {
    const current = clampIndex(length, index);
    if (current < 0) return -1;
    const step = direction === "next" ? 1 : direction === "previous" ? -1 : 0;
    return clampIndex(length, current + step);
  }

  function availability(length, index) {
    const current = clampIndex(length, index);
    return {
      previous: current > 0,
      next: current >= 0 && current < Math.max(0, Number(length) || 0) - 1
    };
  }

  function appendVersion(versions, version) {
    const nextVersions = [...(Array.isArray(versions) ? versions : []), version];
    return { versions: nextVersions, index: nextVersions.length - 1 };
  }

  return { appendVersion, availability, clampIndex, moveIndex };
});
