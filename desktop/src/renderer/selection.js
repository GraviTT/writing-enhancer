"use strict";

// 다른 프로그램에서 선택하거나 복사한 글을 강화하는 화면.
// 강화 단계와 상황을 고른 뒤 강화하고, 결과를 원래 자리에 바꿔 넣거나 복사한다.
// 쓰던 글 강화기 작업은 건드리지 않고, 결과는 기록에 따로 남긴다.
(function setupSelectionPanel() {
  const api = window.writingEnhancer;
  const levels = window.enhancementLevels;
  const rules = window.writingRules;
  const panel = () => window.writingPanel;
  const STORAGE_KEY = "writing-enhancer.selection-level";
  const ORIGINAL_PREVIEW_CHARACTERS = 220;

  const $ = (id) => document.querySelector(`#${id}`);
  const el = {
    view: $("selectionView"),
    back: $("selectionBackButton"),
    source: $("selectionSource"),
    original: $("selectionOriginal"),
    originalToggle: $("selectionOriginalToggle"),
    options: $("selectionOptions"),
    levels: $("selectionLevels"),
    levelHint: $("selectionLevelHint"),
    situations: $("selectionSituations"),
    situationInput: $("selectionSituationInput"),
    enhance: $("selectionEnhanceButton"),
    loading: $("selectionLoading"),
    result: $("selectionResult"),
    summary: $("selectionSummary"),
    resultText: $("selectionResultText"),
    replace: $("selectionReplaceButton"),
    copy: $("selectionCopyButton"),
    again: $("selectionAgainButton"),
    edit: $("selectionEditButton"),
    open: $("selectionOpenButton"),
    offer: $("copyOffer"),
    offerPreview: $("copyOfferPreview"),
    offerUse: $("copyOfferUse"),
    offerDismiss: $("copyOfferDismiss")
  };

  const state = {
    text: "",
    token: "",
    targetLabel: "",
    canReplace: false,
    source: "",
    level: levels.DEFAULT,
    busy: false,
    requestId: 0,
    versions: [],
    historyId: "",
    previousView: "input",
    showingOriginal: false
  };

  function loadLevel() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      state.level = saved === null ? levels.DEFAULT : levels.normalize(saved);
    } catch {
      state.level = levels.DEFAULT;
    }
  }

  function saveLevel() {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(state.level));
    } catch {
      // 저장소를 쓸 수 없으면 다음에 기본 단계로 연다.
    }
  }

  function isOpen() {
    return !el.view.classList.contains("is-hidden");
  }

  function show(part) {
    el.options.classList.toggle("is-hidden", part !== "options");
    el.loading.classList.toggle("is-hidden", part !== "loading");
    el.result.classList.toggle("is-hidden", part !== "result");
  }

  // ── 강화 단계·상황 ──────────────────────────────────────

  function renderLevels() {
    el.levels.replaceChildren();
    for (const definition of levels.LEVELS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "level-segment";
      button.dataset.level = String(definition.value);
      button.setAttribute("role", "radio");
      button.title = `${definition.value}단계 · ${definition.label}`;
      const number = document.createElement("strong");
      number.textContent = String(definition.value);
      const label = document.createElement("span");
      label.textContent = rules.selection.levelShortLabels[definition.value - 1];
      button.append(number, label);
      button.addEventListener("click", () => setLevel(definition.value));
      el.levels.append(button);
    }
  }

  function setLevel(value, { focus = false } = {}) {
    state.level = levels.normalize(value);
    for (const button of el.levels.children) {
      const selected = Number(button.dataset.level) === state.level;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    const definition = levels.definition(state.level);
    el.levelHint.textContent = `${definition.value}단계 · ${definition.label} — ${definition.lengthTarget}`;
    saveLevel();
  }

  function renderSituations() {
    el.situations.replaceChildren();
    for (const situation of rules.selection.situations) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "situation-chip";
      chip.textContent = situation.label;
      chip.title = situation.text;
      chip.dataset.text = situation.text;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const chosen = el.situationInput.value.trim() === situation.text;
        el.situationInput.value = chosen ? "" : situation.text;
        syncSituationChips();
      });
      el.situations.append(chip);
    }
  }

  function syncSituationChips() {
    const value = el.situationInput.value.trim();
    for (const chip of el.situations.children) {
      const chosen = chip.dataset.text === value;
      chip.classList.toggle("is-selected", chosen);
      chip.setAttribute("aria-pressed", String(chosen));
    }
  }

  // ── 열기·닫기 ───────────────────────────────────────────

  function sourceText() {
    const count = `${state.text.length.toLocaleString("ko-KR")}자`;
    if (state.targetLabel) return `${state.targetLabel}에서 가져온 글 · ${count}`;
    if (state.source === "clipboard") return `복사한 글 · ${count}`;
    if (state.source === "context-menu") return `글 강화기에서 선택한 글 · ${count}`;
    return `선택한 글 · ${count}`;
  }

  function renderOriginal() {
    const long = state.text.length > ORIGINAL_PREVIEW_CHARACTERS;
    el.original.textContent =
      long && !state.showingOriginal
        ? `${state.text.slice(0, ORIGINAL_PREVIEW_CHARACTERS).trimEnd()}…`
        : state.text;
    el.originalToggle.classList.toggle("is-hidden", !long);
    el.originalToggle.textContent = state.showingOriginal ? "접기" : "전체 보기";
    el.originalToggle.setAttribute("aria-expanded", String(state.showingOriginal));
  }

  function renderReplaceButton() {
    el.replace.classList.toggle("is-hidden", !state.canReplace);
    el.replace.querySelector("span").textContent = state.targetLabel
      ? `${state.targetLabel}에 바꿔 넣기`
      : "원래 자리에 바꿔 넣기";
    el.replace.title = "선택해 둔 글을 강화한 글로 바꿔요. 원래 프로그램에서 선택이 풀렸다면 커서 자리에 들어가요.";
    el.copy.classList.toggle("primary-button", !state.canReplace);
    el.copy.classList.toggle("secondary-button", state.canReplace);
  }

  function open(payload) {
    const text = String(payload?.text || "").trim();
    if (!text) return;
    if (!isOpen()) state.previousView = panel().currentView();
    state.requestId += 1;
    Object.assign(state, {
      text,
      token: String(payload.token || ""),
      targetLabel: String(payload.targetLabel || "").trim(),
      canReplace: payload.canReplace === true,
      source: String(payload.source || ""),
      busy: false,
      versions: [],
      historyId: "",
      showingOriginal: false
    });
    hideOffer();
    el.source.textContent = sourceText();
    renderOriginal();
    el.situationInput.value = "";
    syncSituationChips();
    setLevel(state.level);
    renderReplaceButton();
    show("options");
    panel().showSurface("writing");
    panel().setView("selection");
    window.setTimeout(focus, 60);
  }

  function close() {
    state.requestId += 1;
    state.busy = false;
    if (!isOpen()) return;
    panel().setView(state.previousView === "loading" ? "input" : state.previousView);
  }

  function focus() {
    if (!el.result.classList.contains("is-hidden")) el.resultText.focus();
    else if (!el.options.classList.contains("is-hidden")) el.enhance.focus();
  }

  // ── 강화 ────────────────────────────────────────────────

  function summaryText(version) {
    const definition = levels.definition(version.enhancementLevel);
    return version.situation
      ? `${definition.value}단계 ${definition.label} · ${version.situation}`
      : `${definition.value}단계 ${definition.label}`;
  }

  async function enhance() {
    if (state.busy) return;
    const requestId = ++state.requestId;
    const situation = el.situationInput.value.trim();
    const enhancementLevel = state.level;
    state.busy = true;
    show("loading");
    const response = await api.enhance({
      input: state.text,
      situation,
      enhancementLevel,
      followUpMode: "first",
      attachments: []
    });
    if (requestId !== state.requestId) return;
    state.busy = false;
    if (!response?.ok) {
      show(state.versions.length > 0 ? "result" : "options");
      const error = response?.error || { message: "잠시 연결하지 못했어요." };
      const needsKey = error.code === "NO_API_KEY";
      panel().showToast(error.message, {
        actionLabel: needsKey ? "설정" : undefined,
        onAction: needsKey ? () => panel().openSettings() : undefined,
        duration: 7_000
      });
      return;
    }
    // 이 화면은 기억 추가를 묻지 않는다.
    if (response.result.memoryApprovalToken) api.rejectMemoryCandidates(response.result.memoryApprovalToken);
    const version = {
      completedText: response.result.completedText,
      followUp: response.result.followUp,
      enhancementLevel,
      situation,
      createdAt: new Date().toISOString()
    };
    state.versions.push(version);
    el.summary.textContent = summaryText(version);
    el.resultText.value = version.completedText;
    show("result");
    el.resultText.focus();
    await saveHistory();
  }

  function currentResult() {
    return el.resultText.value.trim();
  }

  // 결과를 기록에 남겨, 나중에 기록에서 다시 찾거나 글 강화기에서 이어서 다듬을 수 있게 한다.
  async function saveHistory() {
    const latest = state.versions.at(-1);
    if (!latest) return;
    const edited = currentResult();
    if (edited) latest.completedText = edited;
    const response = await api.saveHistory({
      id: state.historyId,
      situation: latest.situation,
      input: state.text,
      attachmentNames: [],
      versions: state.versions.map(({ situation: _situation, ...version }) => version),
      versionIndex: state.versions.length - 1
    });
    if (response?.ok) state.historyId = response.record.id;
  }

  async function replace() {
    const text = currentResult();
    if (!text) return;
    el.replace.disabled = true;
    await saveHistory();
    const response = await api.replaceSelection({ token: state.token, text });
    el.replace.disabled = false;
    if (response?.ok) {
      close();
      return;
    }
    // 바꿔 넣지 못하면 복사해 두었으므로, 버튼을 숨기고 직접 붙여 넣게 안내한다.
    state.canReplace = false;
    renderReplaceButton();
    panel().showToast(response?.error?.message || "바꿔 넣지 못해 복사해 두었어요.", { duration: 8_000 });
  }

  async function copy() {
    const text = currentResult();
    if (!text) return;
    await saveHistory();
    close();
    // 복사한 뒤에는 창을 접어 원래 프로그램에 바로 붙여 넣을 수 있게 한다.
    await api.apply(text);
  }

  async function openInWriting() {
    await saveHistory();
    if (!state.historyId) {
      panel().showToast("결과를 기록에 남기지 못했어요. 복사해서 써 주세요.");
      return;
    }
    const historyId = state.historyId;
    state.requestId += 1;
    if (await panel().openHistoryRecord(historyId)) {
      panel().showToast("선택한 글의 결과를 글 강화기에서 열었어요.");
    }
  }

  // ── 복사한 글 제안 ──────────────────────────────────────

  function showOffer({ preview, length }) {
    if (isOpen()) return;
    el.offerPreview.textContent = `${preview}${length > preview.length ? "…" : ""} · ${Number(length).toLocaleString("ko-KR")}자`;
    el.offer.classList.remove("is-hidden");
  }

  function hideOffer() {
    el.offer.classList.add("is-hidden");
  }

  async function useCopied() {
    hideOffer();
    const response = await api.useCopiedText();
    if (!response?.ok) {
      panel().showToast(response?.error?.message || "복사한 글을 가져오지 못했어요.");
      return;
    }
    open(response);
  }

  function shortcutLabel(shortcut) {
    return String(shortcut || "Ctrl+Shift+G").replace(/CommandOrControl|CmdOrCtrl|Control/gu, "Ctrl");
  }

  function emptyMessage({ reason, shortcut }) {
    const key = shortcutLabel(shortcut);
    if (reason === "modifiers") {
      return "단축키를 누른 채로 있어서 글을 가져오지 못했어요. 손을 뗀 뒤 다시 눌러 주세요.";
    }
    if (reason === "empty") {
      return `선택한 글이 없어요. 다른 프로그램에서 글을 드래그해 선택한 뒤 ${key} 키를 눌러 주세요.`;
    }
    return "선택한 글을 가져오지 못했어요. 글을 복사한 뒤 이 창을 열면 강화할 수 있어요.";
  }

  // ── 이벤트 ──────────────────────────────────────────────

  loadLevel();
  renderLevels();
  renderSituations();
  setLevel(state.level);

  el.levels.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    setLevel(state.level + step, { focus: true });
  });
  el.situationInput.addEventListener("input", syncSituationChips);
  el.situationInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      enhance();
    }
  });
  el.originalToggle.addEventListener("click", () => {
    state.showingOriginal = !state.showingOriginal;
    renderOriginal();
  });
  el.back.addEventListener("click", close);
  el.enhance.addEventListener("click", enhance);
  el.again.addEventListener("click", enhance);
  el.edit.addEventListener("click", () => {
    const latest = state.versions.at(-1);
    if (latest) {
      el.situationInput.value = latest.situation;
      syncSituationChips();
      setLevel(latest.enhancementLevel);
    }
    show("options");
    el.enhance.focus();
  });
  el.replace.addEventListener("click", replace);
  el.copy.addEventListener("click", copy);
  el.open.addEventListener("click", openInWriting);
  el.offerUse.addEventListener("click", useCopied);
  el.offerDismiss.addEventListener("click", hideOffer);

  api.onSelectionOpen(open);
  api.onSelectionOffer(showOffer);
  api.onSelectionEmpty((payload) => panel().showToast(emptyMessage(payload || {}), { duration: 8_000 }));
  api.onPanelState(({ expanded }) => {
    if (!expanded) hideOffer();
  });

  window.selectionPanel = {
    open,
    close,
    focus,
    isOpen,
    previousView: () => state.previousView,
    // Esc는 결과·옵션 화면을 닫고 원래 화면으로 돌아간다.
    handleEscape() {
      if (!isOpen()) return false;
      close();
      return true;
    },
    showDemo(stage) {
      open({
        text: "내일 회의 자료 아직 못 만들었어. 오늘 밤까지 정리해서 보내 줄게. 미안",
        token: "",
        targetLabel: "카카오톡",
        canReplace: true,
        source: "shortcut"
      });
      el.situationInput.value = "메신저로 보내는 답장";
      syncSituationChips();
      if (stage === "result") {
        const version = {
          completedText: "내일 회의 자료를 아직 못 만들었어. 오늘 밤까지 정리해서 꼭 보내 줄게. 늦어져서 미안해.",
          followUp: "",
          enhancementLevel: 3,
          situation: "메신저로 보내는 답장",
          createdAt: new Date().toISOString()
        };
        state.versions = [version];
        el.summary.textContent = summaryText(version);
        el.resultText.value = version.completedText;
        show("result");
      }
    }
  };
})();
