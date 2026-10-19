"use strict";

// 다른 프로그램에서 선택하거나 복사한 글을 강화하는 화면.
// 가져온 글을 필요하면 고친 뒤 강화 단계와 상황(접어 둔 칸)을 골라 강화하고,
// 결과를 원래 자리에 바꿔 넣거나 복사한다. 상황 버튼은 사용자가 저장·삭제할 수 있다.
// 쓰던 글 강화기 작업은 건드리지 않고, 결과는 기록에 따로 남긴다.
(function setupSelectionPanel() {
  const api = window.writingEnhancer;
  const levels = window.enhancementLevels;
  const rules = window.writingRules;
  const presets = window.situationPresets;
  const textLanguage = window.textLanguage;
  const panel = () => window.writingPanel;
  const STORAGE_KEY = "writing-enhancer.selection-level";
  const TARGET_STORAGE_KEY = "writing-enhancer.selection-target";
  const ORIGINAL_MAX_HEIGHT = 168;
  const TARGETS = rules.translation.targets;

  const $ = (id) => document.querySelector(`#${id}`);
  const el = {
    view: $("selectionView"),
    back: $("selectionBackButton"),
    source: $("selectionSource"),
    original: $("selectionOriginal"),
    options: $("selectionOptions"),
    modeEnhance: $("selectionModeEnhance"),
    modeTranslate: $("selectionModeTranslate"),
    levelBlock: $("selectionLevelBlock"),
    targetBlock: $("selectionTargetBlock"),
    targets: $("selectionTargets"),
    loadingText: $("selectionLoadingText"),
    levels: $("selectionLevels"),
    levelHint: $("selectionLevelHint"),
    situationToggle: $("selectionSituationToggle"),
    situationSection: $("selectionSituationSection"),
    situations: $("selectionSituations"),
    situationInput: $("selectionSituationInput"),
    situationSave: $("situationSaveButton"),
    situationEdit: $("situationEditButton"),
    situationReset: $("situationResetButton"),
    situationHint: $("situationEditHint"),
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
    situations: presets.defaults(),
    customized: false,
    editingSituations: false,
    // "enhance"(강화하기) 또는 "translate"(번역하기)
    mode: "enhance",
    target: "ko",
    // 화면에서 읽은 글이면 AI가 알려 준 언어
    language: "",
    languageName: "",
    reading: false
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

  function loadTarget() {
    try {
      const saved = window.localStorage.getItem(TARGET_STORAGE_KEY);
      return TARGETS.some((target) => target.code === saved) ? saved : "en";
    } catch {
      return "en";
    }
  }

  function saveTarget(code) {
    try {
      window.localStorage.setItem(TARGET_STORAGE_KEY, code);
    } catch {
      // 저장소를 쓸 수 없으면 다음에 기본 언어로 연다.
    }
  }

  function targetLabel(code = state.target) {
    return (TARGETS.find((target) => target.code === code) || TARGETS[0]).label;
  }

  function isOpen() {
    return !el.view.classList.contains("is-hidden");
  }

  // ── 강화하기 / 번역하기 ─────────────────────────────────

  function renderTargets() {
    el.targets.replaceChildren();
    for (const target of TARGETS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "situation-chip target-chip";
      chip.textContent = target.label;
      chip.dataset.code = target.code;
      chip.setAttribute("role", "radio");
      chip.addEventListener("click", () => setTarget(target.code, { remember: true }));
      el.targets.append(chip);
    }
  }

  function setTarget(code, { remember = false } = {}) {
    state.target = TARGETS.some((target) => target.code === code) ? code : "ko";
    for (const chip of el.targets.children) {
      const selected = chip.dataset.code === state.target;
      chip.classList.toggle("is-selected", selected);
      chip.setAttribute("aria-checked", String(selected));
    }
    if (remember && state.target !== "ko") saveTarget(state.target);
  }

  function setMode(mode) {
    state.mode = mode === "translate" ? "translate" : "enhance";
    const translating = state.mode === "translate";
    el.modeEnhance.classList.toggle("is-selected", !translating);
    el.modeTranslate.classList.toggle("is-selected", translating);
    el.modeEnhance.setAttribute("aria-selected", String(!translating));
    el.modeTranslate.setAttribute("aria-selected", String(translating));
    el.levelBlock.classList.toggle("is-hidden", translating);
    el.targetBlock.classList.toggle("is-hidden", !translating);
    el.enhance.querySelector("span").textContent = translating ? "번역하기" : "강화하기";
  }

  function show(part) {
    el.options.classList.toggle("is-hidden", part !== "options");
    el.loading.classList.toggle("is-hidden", part !== "loading");
    el.result.classList.toggle("is-hidden", part !== "result");
  }

  // ── 선택한 글(고쳐 쓸 수 있음) ──────────────────────────

  function currentInput() {
    return el.original.value.trim();
  }

  function sourceText() {
    const count = `${currentInput().length.toLocaleString("ko-KR")}자`;
    const origin = state.targetLabel
      ? `${state.targetLabel}에서 가져온 글`
      : state.source === "screen"
        ? "화면에서 읽은 글"
        : state.source === "clipboard"
          ? "복사한 글"
          : state.source === "context-menu"
            ? "글 강화기에서 선택한 글"
            : "선택한 글";
    const language = state.languageName ? ` · ${state.languageName}` : "";
    return `${origin}${language} · ${count} · 고쳐 써도 돼요`;
  }

  function growOriginal() {
    el.original.style.height = "auto";
    el.original.style.height = `${Math.min(el.original.scrollHeight + 2, ORIGINAL_MAX_HEIGHT)}px`;
  }

  function syncOriginal() {
    el.source.textContent = sourceText();
    el.enhance.disabled = !currentInput();
    growOriginal();
  }

  // ── 강화 단계 ───────────────────────────────────────────

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

  // ── 상황(접어 두고, 버튼은 사용자가 고친다) ─────────────

  function situationValue() {
    return presets.clean(el.situationInput.value, presets.limits.maxSituationText);
  }

  function setSituationOpen(open) {
    el.situationSection.classList.toggle("is-hidden", !open);
    el.situationToggle.setAttribute("aria-expanded", String(open));
    if (!open && state.editingSituations) setEditing(false);
    renderSituationToggle();
  }

  function renderSituationToggle() {
    const open = el.situationToggle.getAttribute("aria-expanded") === "true";
    const value = situationValue();
    el.situationToggle.textContent = open
      ? "상황 접기"
      : value
        ? `상황 ✓ ${presets.labelFor(value)}`
        : "＋ 상황 고르기 · 선택";
    el.situationToggle.title = value ? `상황: ${value}` : "받는 사람이나 글의 쓰임을 고르면 더 잘 맞춰 써요";
  }

  function renderSituations() {
    el.situations.replaceChildren();
    const value = situationValue();
    for (const situation of state.situations) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "situation-chip";
      chip.textContent = state.editingSituations ? `${situation.label} ×` : situation.label;
      chip.title = state.editingSituations ? `${situation.text} · 눌러서 지우기` : situation.text;
      chip.dataset.text = situation.text;
      const chosen = !state.editingSituations && situation.text === value;
      chip.classList.toggle("is-selected", chosen);
      chip.classList.toggle("is-removable", state.editingSituations);
      chip.setAttribute("aria-pressed", String(chosen));
      chip.addEventListener("click", () => {
        if (state.editingSituations) {
          removeSituation(situation);
          return;
        }
        el.situationInput.value = situation.text === situationValue() ? "" : situation.text;
        syncSituation();
      });
      el.situations.append(chip);
    }
    if (state.situations.length === 0) {
      const empty = document.createElement("span");
      empty.className = "situation-empty";
      empty.textContent = "저장한 상황 버튼이 없어요. 아래 칸에 상황을 쓰고 저장해 보세요.";
      el.situations.append(empty);
    }
    renderSituationTools();
  }

  function renderSituationTools() {
    const value = situationValue();
    const saved = state.situations.some((item) => item.text === value);
    const full = state.situations.length >= presets.limits.maxSituations;
    el.situationSave.disabled = !value || saved || full;
    el.situationSave.title = full
      ? `상황 버튼은 ${presets.limits.maxSituations}개까지 둘 수 있어요. 편집에서 하나를 지워 주세요.`
      : saved
        ? "이미 버튼으로 있는 상황이에요."
        : "지금 쓴 상황을 다음에도 누를 수 있게 버튼으로 남겨요";
    el.situationEdit.textContent = state.editingSituations ? "편집 끝내기" : "버튼 편집";
    el.situationEdit.setAttribute("aria-pressed", String(state.editingSituations));
    el.situationReset.classList.toggle("is-hidden", !state.editingSituations || !state.customized);
    el.situationHint.classList.toggle("is-hidden", !state.editingSituations);
  }

  function syncSituation() {
    for (const chip of el.situations.querySelectorAll(".situation-chip")) {
      const chosen = !state.editingSituations && chip.dataset.text === situationValue();
      chip.classList.toggle("is-selected", chosen);
      chip.setAttribute("aria-pressed", String(chosen));
    }
    renderSituationTools();
    renderSituationToggle();
  }

  function setEditing(editing) {
    state.editingSituations = editing;
    renderSituations();
  }

  async function applySituations(response) {
    if (!response?.situations) return;
    state.situations = response.situations;
    state.customized = response.customized === true;
    renderSituations();
  }

  async function loadSituations() {
    try {
      await applySituations(await api.getSituationPresets());
    } catch {
      // 저장한 목록을 못 읽으면 기본 목록을 그대로 쓴다.
    }
  }

  async function saveCurrentSituation() {
    const result = presets.add(state.situations, situationValue());
    if (!result.added) {
      const messages = {
        empty: "버튼으로 저장할 상황을 먼저 써 주세요.",
        duplicate: "이미 버튼으로 있는 상황이에요.",
        full: `상황 버튼은 ${presets.limits.maxSituations}개까지 둘 수 있어요. 편집에서 하나를 지워 주세요.`
      };
      panel().showToast(messages[result.reason] || "버튼으로 저장하지 못했어요.");
      return;
    }
    await applySituations(await api.saveSituationPresets(result.list));
    syncSituation();
    panel().showToast(`'${presets.labelFor(situationValue())}' 상황 버튼을 저장했어요.`);
  }

  async function removeSituation(situation) {
    const before = state.situations.map((item) => ({ ...item }));
    await applySituations(await api.saveSituationPresets(presets.remove(state.situations, situation.text)));
    panel().showToast(`'${situation.label}' 버튼을 지웠어요.`, {
      actionLabel: "되돌리기",
      onAction: async () => {
        await applySituations(await api.saveSituationPresets(before));
      }
    });
  }

  async function resetSituations() {
    await applySituations(await api.resetSituationPresets());
    panel().showToast("상황 버튼을 처음 목록으로 되돌렸어요.");
  }

  // ── 열기·닫기 ───────────────────────────────────────────

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
      language: String(payload.language || ""),
      languageName: String(payload.languageName || ""),
      reading: false,
      busy: false,
      versions: [],
      historyId: "",
      editingSituations: false
    });
    hideOffer();
    el.original.disabled = false;
    el.original.value = text;
    el.situationInput.value = "";
    setSituationOpen(false);
    renderSituations();
    setLevel(state.level);
    // 외국어 글이면 처음부터 한국어 번역으로 맞춰 둔다.
    const foreign = textLanguage.suggestsTranslation(text, state.language);
    setMode(foreign ? "translate" : "enhance");
    setTarget(foreign ? "ko" : loadTarget());
    renderReplaceButton();
    show("options");
    panel().showSurface("writing");
    panel().setView("selection");
    syncOriginal();
    loadSituations();
    window.setTimeout(focus, 60);
  }

  function close() {
    state.requestId += 1;
    state.busy = false;
    state.reading = false;
    if (!isOpen()) return;
    panel().setView(state.previousView === "loading" ? "input" : state.previousView);
  }

  // 화면에서 고른 부분을 AI가 읽는 동안 보여 준다. 다 읽으면 open()이 글을 채운다.
  function beginReading() {
    if (!isOpen()) state.previousView = panel().currentView();
    state.requestId += 1;
    state.reading = true;
    hideOffer();
    el.source.textContent = "화면에서 고른 부분";
    el.original.value = "";
    el.original.disabled = true;
    el.loadingText.textContent = "화면에서 글을 읽고 있어요";
    show("loading");
    panel().showSurface("writing");
    panel().setView("selection");
  }

  function readFailed({ message } = {}) {
    if (state.reading) close();
    el.original.disabled = false;
    panel().showToast(message || "화면의 글을 읽지 못했어요.", { duration: 8_000 });
  }

  function focus() {
    if (!el.result.classList.contains("is-hidden")) el.resultText.focus();
    else if (!el.options.classList.contains("is-hidden")) el.enhance.focus();
  }

  // ── 강화 ────────────────────────────────────────────────

  function summaryText(version) {
    if (version.mode === "translate") {
      const base = `번역 · ${targetLabel(version.target)}`;
      return version.situation ? `${base} · ${version.situation}` : base;
    }
    const definition = levels.definition(version.enhancementLevel);
    return version.situation
      ? `${definition.value}단계 ${definition.label} · ${version.situation}`
      : `${definition.value}단계 ${definition.label}`;
  }

  // 기록 목록에서 무엇을 했는지 알 수 있게, 번역이면 상황 칸에 옮긴 언어를 남긴다.
  function historySituation(version) {
    if (version.mode !== "translate") return version.situation;
    const base = `번역 → ${targetLabel(version.target)}`;
    return version.situation ? `${base} · ${version.situation}` : base;
  }

  function renderModeLabels() {
    const translating = state.versions.at(-1)?.mode === "translate";
    el.again.textContent = translating ? "다시 번역" : "다시 강화";
  }

  function showFailure(response) {
    show(state.versions.length > 0 ? "result" : "options");
    const error = response?.error || { message: "잠시 연결하지 못했어요." };
    const needsKey = error.code === "NO_API_KEY";
    panel().showToast(error.message, {
      actionLabel: needsKey ? "설정" : undefined,
      onAction: needsKey ? () => panel().openSettings() : undefined,
      duration: 7_000
    });
  }

  async function run() {
    if (state.busy) return;
    const input = currentInput();
    if (!input) {
      panel().showToast(state.mode === "translate" ? "번역할 글이 비어 있어요." : "강화할 글이 비어 있어요.");
      el.original.focus();
      return;
    }
    // 고친 글로 바꿨다면 이전 결과와 다른 작업으로 기록한다.
    if (input !== state.text) {
      state.text = input;
      state.versions = [];
      state.historyId = "";
    }
    const requestId = ++state.requestId;
    const situation = situationValue();
    const mode = state.mode;
    const target = state.target;
    const enhancementLevel = state.level;
    state.busy = true;
    el.loadingText.textContent =
      mode === "translate" ? `${targetLabel(target)}로 옮기고 있어요` : "선택한 글을 강화하고 있어요";
    show("loading");
    const response =
      mode === "translate"
        ? await api.translate({ input, targetLanguage: target, situation })
        : await api.enhance({ input, situation, enhancementLevel, followUpMode: "first", attachments: [] });
    if (requestId !== state.requestId) return;
    state.busy = false;
    if (!response?.ok) {
      showFailure(response);
      return;
    }
    // 이 화면은 기억 추가를 묻지 않는다.
    if (response.result.memoryApprovalToken) api.rejectMemoryCandidates(response.result.memoryApprovalToken);
    const version = {
      completedText: mode === "translate" ? response.result.translatedText : response.result.completedText,
      followUp: mode === "translate" ? "" : response.result.followUp,
      enhancementLevel,
      situation,
      mode,
      target,
      createdAt: new Date().toISOString()
    };
    state.versions.push(version);
    el.summary.textContent = summaryText(version);
    el.resultText.value = version.completedText;
    renderModeLabels();
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
      situation: historySituation(latest),
      input: state.text,
      attachmentNames: [],
      versions: state.versions.map(({ situation: _situation, mode: _mode, target: _target, ...version }) => version),
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
  renderTargets();
  setTarget(loadTarget());
  setMode("enhance");
  setLevel(state.level);
  renderSituations();
  renderSituationToggle();
  loadSituations();

  el.levels.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    setLevel(state.level + step, { focus: true });
  });
  el.original.addEventListener("input", syncOriginal);
  el.situationToggle.addEventListener("click", () => {
    const open = el.situationSection.classList.contains("is-hidden");
    setSituationOpen(open);
    if (open) el.situationInput.focus();
  });
  el.situationInput.addEventListener("input", syncSituation);
  for (const field of [el.original, el.situationInput]) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        run();
      }
    });
  }
  el.situationSave.addEventListener("click", saveCurrentSituation);
  el.situationEdit.addEventListener("click", () => setEditing(!state.editingSituations));
  el.situationReset.addEventListener("click", resetSituations);
  el.back.addEventListener("click", close);
  el.enhance.addEventListener("click", run);
  el.again.addEventListener("click", () => {
    const latest = state.versions.at(-1);
    if (latest) {
      setMode(latest.mode);
      setTarget(latest.target);
    }
    run();
  });
  el.modeEnhance.addEventListener("click", () => setMode("enhance"));
  el.modeTranslate.addEventListener("click", () => setMode("translate"));
  el.edit.addEventListener("click", () => {
    const latest = state.versions.at(-1);
    if (latest) {
      el.situationInput.value = latest.situation;
      setLevel(latest.enhancementLevel);
      setMode(latest.mode);
      setTarget(latest.target);
    }
    show("options");
    setSituationOpen(Boolean(latest?.situation));
    syncSituation();
    el.enhance.focus();
  });
  el.replace.addEventListener("click", replace);
  el.copy.addEventListener("click", copy);
  el.open.addEventListener("click", openInWriting);
  el.offerUse.addEventListener("click", useCopied);
  el.offerDismiss.addEventListener("click", hideOffer);

  api.onSelectionOpen(open);
  api.onSelectionReading(beginReading);
  api.onSelectionReadFailed((payload) => readFailed(payload || {}));
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
      if (stage === "screen" || stage === "translate-result") {
        open({
          text: "Your order has shipped! Track your package anytime from the Orders page. Delivery usually takes 3-5 business days.",
          source: "screen",
          language: "en",
          languageName: "영어"
        });
        if (stage === "translate-result") {
          const version = {
            completedText: "주문하신 상품이 발송됐어요! 주문 내역 페이지에서 언제든 배송을 조회할 수 있어요. 배송은 보통 영업일 기준 3~5일 걸려요.",
            followUp: "",
            enhancementLevel: 3,
            situation: "",
            mode: "translate",
            target: "ko",
            createdAt: new Date().toISOString()
          };
          state.versions = [version];
          el.summary.textContent = summaryText(version);
          el.resultText.value = version.completedText;
          renderModeLabels();
          show("result");
        }
        return;
      }
      open({
        text: "내일 회의 자료 아직 못 만들었어. 오늘 밤까지 정리해서 보내 줄게. 미안",
        token: "",
        targetLabel: "카카오톡",
        canReplace: true,
        source: "shortcut"
      });
      if (stage === "situations") {
        el.situationInput.value = "메신저로 보내는 답장";
        setSituationOpen(true);
        syncSituation();
      }
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
