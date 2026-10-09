"use strict";

const api = window.writingEnhancer;
const versionNavigation = window.versionNavigation;
const levelPolicy = window.enhancementLevels;

const elements = Object.fromEntries(
  [
    "app",
    "edgeHandle",
    "panelDragHandle",
    "collapseButton",
    "chatButton",
    "updateButton",
    "settingsButton",
    "historyButton",
    "newButton",
    "inputView",
    "guessView",
    "resultView",
    "loadingView",
    "loadingText",
    "situationInput",
    "situationToggle",
    "situationSection",
    "toolsToggle",
    "toolsSection",
    "sourceInput",
    "attachButton",
    "captureButton",
    "attachmentList",
    "enhanceButton",
    "guessButton",
    "enhancementLevelInput",
    "enhancementLabelInput",
    "enhancementTargetInput",
    "guessBackButton",
    "guessAssumption",
    "guessQuestion",
    "guessAnswer",
    "guessCompleteButton",
    "guessAutoButton",
    "completedText",
    "rawOriginalToggle",
    "rawOriginalPanel",
    "rawOriginalText",
    "enhancementLevelResult",
    "enhancementLabelResult",
    "enhancementTargetResult",
    "applyButton",
    "followUpText",
    "versionLabel",
    "undoButton",
    "nextButton",
    "reenhanceButton",
    "replyInput",
    "replyButton",
    "autoButton",
    "historyPopup",
    "historyPopupDragHandle",
    "historyCloseButton",
    "historyList",
    "historyEmpty",
    "settingsPopup",
    "settingsPopupDragHandle",
    "settingsCloseButton",
    "settingsForm",
    "windowMode",
    "opacityInput",
    "opacityValue",
    "fontScaleInput",
    "fontScaleValue",
    "windowWidthInput",
    "windowHeightInput",
    "openaiKey",
    "geminiKey",
    "openaiStatus",
    "geminiStatus",
    "shortcutInput",
    "memoryCount",
    "memoryAdditionsDisabled",
    "manageMemoryButton",
    "settingsError",
    "memoryPopup",
    "memoryPopupDragHandle",
    "memoryCloseButton",
    "memoryList",
    "memoryEmpty",
    "clearMemoryButton",
    "toast",
    "toastText",
    "toastAction",
    "memoryApproval",
    "memoryCandidateList",
    "memoryRejectButton",
    "memoryApproveButton",
    "resizeHandle"
  ].map((id) => [id, document.querySelector(`#${id}`)])
);

const state = {
  // 한 창 안에서 보이는 화면: "writing"(글 강화기) 또는 "chat"(사이드 채팅)
  surface: "writing",
  attachments: [],
  versions: [],
  versionIndex: -1,
  historyId: "",
  currentFollowUp: "",
  guess: null,
  memoryIds: [],
  memoryApprovalToken: "",
  memoryCandidates: [],
  enhancementLevel: levelPolicy.DEFAULT,
  isBusy: false,
  toastTimer: undefined,
  draftTimer: undefined,
  contextSyncTimer: undefined,
  historyTimer: undefined,
  recognition: null,
  voiceButton: null,
  settings: null,
  settingsPreviewTimer: undefined,
  shortcutWarningShown: false
};

function setCollapsible(section, button, expanded, noun) {
  section.classList.toggle("is-hidden", !expanded);
  button.setAttribute("aria-expanded", String(expanded));
  const hasValue =
    noun === "상황"
      ? Boolean(elements.situationInput.value.trim())
      : state.attachments.length > 0;
  button.textContent = expanded ? `${noun} 접기` : hasValue ? `${noun} ✓` : `＋ ${noun}`;
}

function updateEnhancementControls(value, { schedule = false } = {}) {
  state.enhancementLevel = levelPolicy.normalize(value);
  const definition = levelPolicy.definition(state.enhancementLevel);
  for (const [input, label, target] of [
    [elements.enhancementLevelInput, elements.enhancementLabelInput, elements.enhancementTargetInput],
    [elements.enhancementLevelResult, elements.enhancementLabelResult, elements.enhancementTargetResult]
  ]) {
    input.value = String(definition.value);
    label.textContent = `강화 범위 · ${definition.value} ${definition.label}`;
    target.textContent = `목표 · ${definition.lengthTarget}`;
  }
  if (schedule) scheduleDraft();
}

function setExpanded(expanded, side) {
  elements.app.dataset.expanded = String(expanded);
  if (side === "left" || side === "right") elements.app.dataset.side = side;
  if (expanded) {
    window.setTimeout(() => {
      if (document.querySelector(".overlay-popup:not(.is-hidden)")) return;
      const target = !elements.inputView.classList.contains("is-hidden")
        ? elements.sourceInput
        : !elements.guessView.classList.contains("is-hidden")
          ? elements.guessAnswer
          : elements.replyInput;
      target?.focus();
    }, 80);
  }
}

function setView(name) {
  elements.inputView.classList.toggle("is-hidden", name !== "input");
  elements.guessView.classList.toggle("is-hidden", name !== "guess");
  elements.resultView.classList.toggle("is-hidden", name !== "result");
  elements.loadingView.classList.toggle("is-hidden", name !== "loading");
  elements.newButton.classList.toggle("is-hidden", name === "input" || state.surface === "chat");
  window.scrollTo(0, 0);
}

// 글 강화기와 사이드 채팅은 같은 창 안의 두 화면이다. 창 이동·크기·접기는 함께 쓴다.
function showSurface(name) {
  const surface = name === "chat" ? "chat" : "writing";
  const changed = state.surface !== surface;
  state.surface = surface;
  const chat = surface === "chat";
  document.querySelector(".panel-content").classList.toggle("is-hidden", chat);
  document.querySelector("#chatSurface").classList.toggle("is-hidden", !chat);
  elements.app.dataset.surface = surface;
  elements.chatButton.classList.toggle("is-active", chat);
  elements.chatButton.setAttribute("aria-pressed", chat ? "true" : "false");
  elements.chatButton.setAttribute("aria-label", chat ? "글 강화기로 돌아가기" : "사이드 채팅 베타 열기");
  elements.historyButton.classList.toggle("is-hidden", chat);
  elements.newButton.classList.toggle(
    "is-hidden",
    chat || !elements.inputView.classList.contains("is-hidden")
  );
  if (chat) {
    window.sideChatSurface?.focus();
  } else if (changed) {
    focusWritingInput();
  }
  return surface;
}

function focusWritingInput() {
  if (document.querySelector(".overlay-popup:not(.is-hidden)")) return;
  const target = !elements.inputView.classList.contains("is-hidden")
    ? elements.sourceInput
    : !elements.guessView.classList.contains("is-hidden")
      ? elements.guessAnswer
      : elements.replyInput;
  target?.focus();
}

window.writingPanel = {
  showSurface,
  currentSurface: () => state.surface,
  // 업데이트로 앱을 닫기 직전 작성 중인 글을 저장한다.
  flushDraft: async () => {
    window.clearTimeout(state.draftTimer);
    await api.saveDraft(draftPayload());
    return true;
  }
};

// 새 버전 알림 버튼. 누르면 받아서 설치하고 앱을 다시 시작한다.
function renderUpdateState(update) {
  const button = elements.updateButton;
  const status = update?.status || "idle";
  const visible = ["available", "downloading", "installing", "error"].includes(status) && update?.version;
  button.classList.toggle("is-hidden", !visible);
  if (!visible) return;
  button.disabled = status === "downloading" || status === "installing";
  button.classList.toggle("is-error", status === "error");
  button.textContent =
    status === "downloading"
      ? `받는 중 ${update.progress || 0}%`
      : status === "installing"
        ? "다시 시작 중…"
        : status === "error"
          ? "업데이트 다시 시도"
          : "업데이트";
  button.title =
    status === "error"
      ? update.message || "업데이트하지 못했어요."
      : `${update.version} 버전으로 업데이트하고 다시 시작해요. 작성 중인 글은 그대로 남아요.`;
  button.setAttribute("aria-label", button.title);
}

function showToast(message, options = {}) {
  window.clearTimeout(state.toastTimer);
  elements.toastText.textContent = message;
  elements.toastAction.textContent = options.actionLabel || "취소";
  elements.toastAction.classList.toggle("is-hidden", typeof options.onAction !== "function");
  elements.toastAction.onclick = async () => {
    if (typeof options.onAction === "function") await options.onAction();
    elements.toast.classList.add("is-hidden");
  };
  elements.toast.classList.remove("is-hidden");
  state.toastTimer = window.setTimeout(
    () => elements.toast.classList.add("is-hidden"),
    options.duration ?? 4_500
  );
}

async function clearMemoryApproval({ reject = false } = {}) {
  const token = state.memoryApprovalToken;
  state.memoryApprovalToken = "";
  state.memoryCandidates = [];
  elements.memoryApproval.classList.add("is-hidden");
  elements.memoryCandidateList.replaceChildren();
  if (reject && token) await api.rejectMemoryCandidates(token);
}

function showMemoryApproval(token, candidates) {
  clearMemoryApproval({ reject: true });
  if (!token || candidates.length === 0) return;
  state.memoryApprovalToken = token;
  state.memoryCandidates = candidates;
  elements.memoryCandidateList.replaceChildren();
  for (const candidate of candidates) {
    const item = document.createElement("li");
    item.textContent = candidate.value;
    elements.memoryCandidateList.append(item);
  }
  elements.memoryApproval.classList.remove("is-hidden");
}

function formatBytes(value) {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const attachment of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.title = `${attachment.name} · ${formatBytes(attachment.size)}`;
    const icon = document.createElement("span");
    icon.textContent =
      attachment.source === "screen"
        ? "▣"
        : attachment.kind === "image"
          ? "▧"
          : attachment.kind === "document"
            ? "PDF"
            : "TXT";
    const name = document.createElement("span");
    name.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `${attachment.name} 첨부 삭제`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
      saveDraftAttachments();
    });
    chip.append(icon, name, remove);
    elements.attachmentList.append(chip);
  }
  setCollapsible(
    elements.toolsSection,
    elements.toolsToggle,
    !elements.toolsSection.classList.contains("is-hidden"),
    "도구"
  );
}

function currentVersion() {
  return state.versions[state.versionIndex] || null;
}

function renderCurrentVersion() {
  const version = currentVersion();
  if (!version) return;
  elements.completedText.value = version.completedText;
  elements.followUpText.textContent = version.followUp;
  elements.versionLabel.textContent = `${state.versionIndex + 1}번째 결과`;
  elements.rawOriginalText.textContent = elements.sourceInput.value;
  updateEnhancementControls(version.enhancementLevel);
  const available = versionNavigation.availability(state.versions.length, state.versionIndex);
  elements.undoButton.disabled = !available.previous;
  elements.nextButton.disabled = !available.next;
  state.currentFollowUp = version.followUp;
  autoGrow(elements.replyInput);
  setView("result");
  scheduleDraft();
}

function renderResult(result, enhancementLevel) {
  const appended = versionNavigation.appendVersion(state.versions, {
    completedText: result.completedText,
    followUp: result.followUp,
    enhancementLevel: levelPolicy.normalize(enhancementLevel),
    createdAt: new Date().toISOString()
  });
  state.versions = appended.versions;
  state.versionIndex = appended.index;
  state.memoryIds = [];
  elements.replyInput.value = "";
  renderCurrentVersion();
  saveHistoryNow();
  showMemoryApproval(
    result.memoryApprovalToken,
    Array.isArray(result.memoryCandidates) ? result.memoryCandidates : []
  );
}

function draftPayload({ includeAttachments = false } = {}) {
  const payload = {
    situation: elements.situationInput.value,
    input: elements.sourceInput.value,
    reply: elements.replyInput.value,
    guessAnswer: elements.guessAnswer.value,
    guessAssumption: state.guess?.assumption || "",
    guessQuestion: state.guess?.question || "",
    historyId: state.historyId,
    enhancementLevel: state.enhancementLevel,
    versionIndex: state.versionIndex,
    versions: state.versions
  };
  if (includeAttachments) payload.attachments = state.attachments;
  return payload;
}

function currentViewName() {
  if (!elements.loadingView.classList.contains("is-hidden")) return "loading";
  if (!elements.resultView.classList.contains("is-hidden")) return "result";
  if (!elements.guessView.classList.contains("is-hidden")) return "guess";
  return "input";
}

function writingContextPayload() {
  const version = currentVersion();
  return {
    view: currentViewName(),
    situation: elements.situationInput.value,
    input: elements.sourceInput.value,
    completedText: version?.completedText || elements.completedText.value,
    followUp: version?.followUp || state.guess?.question || "",
    reply: elements.replyInput.value || elements.guessAnswer.value,
    enhancementLevel: state.enhancementLevel,
    versionCount: state.versions.length,
    versionIndex: state.versionIndex,
    attachmentNames: state.attachments.map((attachment) => attachment.name)
  };
}

function syncWritingContext() {
  window.clearTimeout(state.contextSyncTimer);
  return api.syncSideChatWritingContext(writingContextPayload());
}

function scheduleWritingContextSync() {
  window.clearTimeout(state.contextSyncTimer);
  state.contextSyncTimer = window.setTimeout(syncWritingContext, 120);
}

function scheduleDraft() {
  window.clearTimeout(state.draftTimer);
  state.draftTimer = window.setTimeout(() => api.saveDraft(draftPayload()), 350);
  scheduleWritingContextSync();
}

function saveDraftAttachments() {
  window.clearTimeout(state.draftTimer);
  api.saveDraft(draftPayload({ includeAttachments: true }));
  syncWritingContext();
}

function historyPayload() {
  return {
    id: state.historyId,
    situation: elements.situationInput.value,
    input: elements.sourceInput.value,
    attachmentNames: state.attachments.map((attachment) => attachment.name),
    versions: state.versions,
    versionIndex: state.versionIndex
  };
}

async function saveHistoryNow() {
  if (state.versions.length === 0 || !elements.sourceInput.value.trim()) return;
  const response = await api.saveHistory(historyPayload());
  if (response?.ok) {
    state.historyId = response.record.id;
    scheduleDraft();
  }
}

function scheduleHistorySave() {
  window.clearTimeout(state.historyTimer);
  state.historyTimer = window.setTimeout(saveHistoryNow, 500);
}

function resetToInput({ keepText = false } = {}) {
  window.clearTimeout(state.draftTimer);
  window.clearTimeout(state.historyTimer);
  if (!keepText) {
    elements.situationInput.value = "";
    elements.sourceInput.value = "";
  }
  elements.completedText.value = "";
  elements.replyInput.value = "";
  elements.guessAnswer.value = "";
  state.attachments = [];
  state.versions = [];
  state.versionIndex = -1;
  state.historyId = "";
  state.currentFollowUp = "";
  state.guess = null;
  state.memoryIds = [];
  clearMemoryApproval({ reject: true });
  elements.rawOriginalPanel.classList.add("is-hidden");
  elements.rawOriginalToggle.setAttribute("aria-expanded", "false");
  elements.rawOriginalToggle.textContent = "원문 보기";
  setCollapsible(elements.situationSection, elements.situationToggle, false, "상황");
  setCollapsible(elements.toolsSection, elements.toolsToggle, false, "도구");
  updateEnhancementControls(levelPolicy.DEFAULT);
  renderAttachments();
  setView("input");
  api.clearDraft();
  syncWritingContext();
  elements.sourceInput.focus();
}

async function handleApiError(response, previousView) {
  setView(previousView);
  const error = response?.error || { message: "처리 중 문제가 생겼습니다.", code: "UNKNOWN" };
  const needsKey = error.code === "NO_API_KEY";
  showToast(error.message, {
    actionLabel: needsKey ? "설정" : undefined,
    onAction: needsKey ? openSettings : undefined,
    duration: 7_000
  });
  if (needsKey) await openSettings();
}

async function requestGuess() {
  if (state.isBusy) return;
  const input = elements.sourceInput.value.trim();
  const situation = elements.situationInput.value.trim();
  if (!input && !situation) {
    showToast("떠오르는 내용이나 상황을 먼저 적어 주세요.");
    elements.sourceInput.focus();
    return;
  }
  state.isBusy = true;
  elements.loadingText.textContent = "꼭 필요한 것 하나만 알아보고 있어요";
  setView("loading");
  const response = await api.guess({
    input,
    situation,
    attachments: state.attachments
  });
  state.isBusy = false;
  if (!response.ok) {
    await handleApiError(response, "input");
    return;
  }
  state.guess = response.result;
  elements.guessAssumption.textContent =
    response.result.assumption || "제가 이해한 방향을 먼저 확인할게요.";
  elements.guessQuestion.textContent = response.result.question;
  setView("guess");
  elements.guessAnswer.focus();
  scheduleDraft();
}

async function requestEnhancement(options = {}) {
  if (state.isBusy) return;
  const input = elements.sourceInput.value.trim();
  if (!input) {
    showToast("떠오르는 내용을 먼저 적어 주세요.");
    setView("input");
    elements.sourceInput.focus();
    return;
  }

  const previousView = state.versions.length > 0 ? "result" : state.guess ? "guess" : "input";
  const regenerateFromOriginal =
    state.versions.length > 0 && !options.preflight && options.regenerateFromOriginal === true;
  const isRefinement =
    state.versions.length > 0 && !options.preflight && !regenerateFromOriginal;
  const isFirstCompletion = state.versions.length === 0;
  const requestedLevel = levelPolicy.normalize(state.enhancementLevel);
  state.isBusy = true;
  elements.loadingText.textContent = "가장 자연스러운 글로 만들고 있어요";
  setView("loading");
  const response = await api.enhance({
    input,
    enhancementLevel: requestedLevel,
    followUpMode: isFirstCompletion ? "first" : "subsequent",
    situation: elements.situationInput.value.trim(),
    attachments: state.attachments,
    regenerateFromOriginal,
    preflight: options.preflight
      ? {
          question: state.guess?.question || "",
          answer: options.answer || "알아서"
        }
      : undefined,
    refinement: isRefinement
      ? {
          currentText: elements.completedText.value,
          followUp: state.currentFollowUp,
          answer: options.answer || "알아서 더 자연스럽고 완성도 높게 다듬어 줘"
        }
      : undefined
  });
  state.isBusy = false;
  if (!response.ok) {
    await handleApiError(response, previousView);
    return;
  }
  state.guess = null;
  renderResult(response.result, requestedLevel);
}

async function addFiles() {
  elements.attachButton.disabled = true;
  const response = await api.pickAttachments(state.attachments);
  elements.attachButton.disabled = false;
  if (!response.ok) {
    showToast(response.error.message, { duration: 6_000 });
    return;
  }
  if (response.attachments.length > 0) {
    state.attachments.push(...response.attachments);
    renderAttachments();
    saveDraftAttachments();
    showToast(`${response.attachments.length}개 참고 자료를 붙였어요.`);
  }
}

async function captureScreen() {
  elements.captureButton.disabled = true;
  showToast("강화기를 잠시 숨기고 현재 화면을 촬영해요.");
  const response = await api.captureScreen(state.attachments);
  elements.captureButton.disabled = false;
  if (!response.ok) {
    showToast(response.error.message, { duration: 6_000 });
    return;
  }
  state.attachments.push(response.attachment);
  renderAttachments();
  saveDraftAttachments();
  showToast("강화기 없이 현재 화면을 첨부했어요.");
}

function autoGrow(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 116)}px`;
}

function finishRecognition() {
  state.voiceButton?.classList.remove("is-listening");
  state.voiceButton = null;
  state.recognition = null;
}

function startVoiceInput(button) {
  if (state.recognition) {
    state.recognition.stop();
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("이 환경에서는 앱 음성 인식이 없어요. 입력칸을 누르고 Win+H를 사용해 주세요.", {
      duration: 7_000
    });
    return;
  }
  const target = document.querySelector(`#${button.dataset.voiceTarget}`);
  if (!target) return;

  const recognition = new SpeechRecognition();
  const original = target.value;
  let finalText = "";
  recognition.lang = "ko-KR";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    state.recognition = recognition;
    state.voiceButton = button;
    button.classList.add("is-listening");
    showToast("듣고 있어요. 다시 누르면 멈춰요.");
  };
  recognition.onresult = (event) => {
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    const spacing = original && !/\s$/u.test(original) ? " " : "";
    target.value = `${original}${spacing}${finalText}${interimText}`.slice(0, Number(target.maxLength) || 12_000);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  };
  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "마이크 권한이 필요해요. Windows 설정에서 마이크 접근을 허용해 주세요.",
      "audio-capture": "사용할 수 있는 마이크를 찾지 못했어요.",
      network: "음성 인식 연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.",
      "no-speech": "목소리가 들리지 않았어요. 다시 눌러 말해 주세요."
    };
    showToast(messages[event.error] || "음성 입력을 시작하지 못했어요. Win+H도 사용할 수 있어요.", {
      duration: 7_000
    });
  };
  recognition.onend = finishRecognition;
  try {
    recognition.start();
  } catch {
    finishRecognition();
    showToast("음성 입력을 시작하지 못했어요. 입력칸에서 Win+H를 사용해 주세요.");
  }
}

function installDrag(surface, { toggleOnClick = false } = {}) {
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    const startX = event.screenX;
    const startY = event.screenY;
    const startPromise = api.beginPanelDrag();
    let startBounds = null;
    let active = true;
    let moved = false;
    let latestScreenX = startX;
    let latestScreenY = startY;

    const sendMove = (final) => {
      if (!startBounds) return;
      const x = Math.round(startBounds.x + latestScreenX - startX);
      const y = Math.round(startBounds.y + latestScreenY - startY);
      api.movePanel({ x, y, final });
    };
    startPromise.then((response) => {
      startBounds = response.bounds;
      if (moved) sendMove(!active);
    });

    const move = (moveEvent) => {
      latestScreenX = moveEvent.screenX;
      latestScreenY = moveEvent.screenY;
      const deltaX = latestScreenX - startX;
      const deltaY = latestScreenY - startY;
      if (!moved && Math.hypot(deltaX, deltaY) < 4) return;
      moved = true;
      surface.classList.add("is-dragging");
      sendMove(false);
    };
    const end = () => {
      active = false;
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", end);
      surface.removeEventListener("pointercancel", end);
      surface.classList.remove("is-dragging");
      if (moved) sendMove(true);
      else if (toggleOnClick) api.togglePanel();
    };
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
  });
}

function installResize(surface) {
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || elements.app.dataset.expanded !== "true") return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    const startX = event.screenX;
    const startY = event.screenY;
    const startPromise = api.beginPanelResize();
    let startBounds = null;
    let latestX = startX;
    let latestY = startY;
    let active = true;

    const sendResize = (final) => {
      if (!startBounds) return;
      api.resizePanel({
        width: startBounds.width + latestX - startX,
        height: startBounds.height + latestY - startY,
        final
      });
    };
    startPromise.then((response) => {
      startBounds = response.bounds;
      if (!active) sendResize(true);
    });
    const move = (moveEvent) => {
      latestX = moveEvent.screenX;
      latestY = moveEvent.screenY;
      surface.classList.add("is-resizing");
      sendResize(false);
    };
    const end = () => {
      active = false;
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", end);
      surface.removeEventListener("pointercancel", end);
      surface.classList.remove("is-resizing");
      sendResize(true);
    };
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
  });
}

function settingsRangeLabels() {
  elements.opacityValue.value = `${elements.opacityInput.value}%`;
  elements.fontScaleValue.value = `${elements.fontScaleInput.value}%`;
}

async function openSettings() {
  const settings = await api.getSettings();
  state.settings = settings;
  elements.openaiKey.value = "";
  elements.geminiKey.value = "";
  elements.openaiKey.placeholder = settings.hasOpenAIKey ? "저장된 키를 사용 중" : "sk-...";
  elements.geminiKey.placeholder = settings.hasGeminiKey ? "저장된 키를 사용 중" : "AIza...";
  elements.openaiStatus.textContent = settings.hasOpenAIKey
    ? settings.openAIFromEnvironment
      ? "환경 변수"
      : "연결됨"
    : "";
  elements.geminiStatus.textContent = settings.hasGeminiKey
    ? settings.geminiFromEnvironment
      ? "환경 변수"
      : "연결됨"
    : "";
  elements.shortcutInput.value = settings.shortcut;
  elements.memoryCount.textContent = `${settings.memoryCount}개 저장됨 · 기존 기억은 유지`;
  elements.memoryAdditionsDisabled.checked = settings.memoryAdditionsEnabled === false;
  elements.windowMode.value = settings.windowMode;
  elements.opacityInput.value = String(Math.round(settings.windowOpacity * 100));
  elements.fontScaleInput.value = String(Math.round(settings.fontScale * 100));
  elements.windowWidthInput.value = String(settings.windowWidth);
  elements.windowHeightInput.value = String(settings.windowHeight);
  settingsRangeLabels();
  elements.settingsError.textContent = settings.shortcutWarning || "";
  elements.settingsPopup.classList.remove("is-hidden");
  window.setTimeout(() => elements.settingsCloseButton.focus(), 30);
}

function closeSettings() {
  elements.settingsPopup.classList.add("is-hidden");
  elements.settingsButton.focus();
}

function displaySettingsPayload() {
  const width = Number(elements.windowWidthInput.value);
  const height = Number(elements.windowHeightInput.value);
  return {
    shortcut: state.settings?.shortcut || elements.shortcutInput.value.trim(),
    memoryAdditionsEnabled: !elements.memoryAdditionsDisabled.checked,
    windowMode: elements.windowMode.value,
    windowOpacity: Number(elements.opacityInput.value) / 100,
    fontScale: Number(elements.fontScaleInput.value) / 100,
    windowWidth:
      Number.isFinite(width) && width >= 380 && width <= 680
        ? width
        : state.settings?.windowWidth,
    windowHeight:
      Number.isFinite(height) && height >= 560 && height <= 920
        ? height
        : state.settings?.windowHeight
  };
}

function previewDisplaySettings() {
  if (!state.settings) return;
  window.clearTimeout(state.settingsPreviewTimer);
  state.settingsPreviewTimer = window.setTimeout(async () => {
    const response = await api.saveSettings(displaySettingsPayload());
    if (!response.ok) {
      elements.settingsError.textContent = response.error.message;
      return;
    }
    state.settings = { ...state.settings, ...response.settings };
  }, 140);
}

function historyDate(value) {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function renderHistoryItems(items) {
  elements.historyList.replaceChildren();
  elements.historyEmpty.classList.toggle("is-hidden", items.length > 0);
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "history-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const inputPreview = document.createElement("span");
    inputPreview.className = "history-preview";
    inputPreview.textContent = `원문 · ${item.inputPreview || item.title}`;
    const preview = document.createElement("span");
    preview.className = "history-preview result";
    preview.textContent = `결과 · ${item.preview}`;
    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${historyDate(item.updatedAt)} · 결과 ${item.versionCount}개`;
    open.append(title, inputPreview, preview, meta);
    open.addEventListener("click", async () => {
      const record = await api.getHistory(item.id);
      if (!record) {
        showToast("이 작업을 찾지 못했어요.");
        return;
      }
      elements.situationInput.value = record.situation;
      elements.sourceInput.value = record.input;
      state.attachments = [];
      state.versions = record.versions;
      state.versionIndex = record.versionIndex;
      state.historyId = record.id;
      state.guess = null;
      updateEnhancementControls(
        record.versions[record.versionIndex]?.enhancementLevel || levelPolicy.DEFAULT
      );
      renderAttachments();
      saveDraftAttachments();
      renderCurrentVersion();
      elements.historyPopup.classList.add("is-hidden");
      showToast("이전 작업을 불러왔어요.");
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-item";
    remove.setAttribute("aria-label", `${item.title} 삭제`);
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      await api.removeHistory(item.id);
      if (state.historyId === item.id) state.historyId = "";
      await openHistory();
      showToast("히스토리에서 지웠어요.");
    });
    card.append(open, remove);
    elements.historyList.append(card);
  }
}

async function openHistory() {
  renderHistoryItems(await api.listHistory());
  elements.historyPopup.classList.remove("is-hidden");
}

async function renderMemories() {
  const memories = await api.listMemories();
  elements.memoryList.replaceChildren();
  elements.memoryEmpty.classList.toggle("is-hidden", memories.length > 0);
  elements.clearMemoryButton.disabled = memories.length === 0;
  for (const memory of memories) {
    const card = document.createElement("article");
    card.className = "memory-card";
    const value = document.createElement("textarea");
    value.maxLength = 240;
    value.value = memory.value;
    value.setAttribute("aria-label", "기억 내용");
    const row = document.createElement("div");
    row.className = "memory-card-row";
    const scope = document.createElement("input");
    scope.className = "memory-scope";
    scope.maxLength = 80;
    scope.value = memory.scope;
    scope.setAttribute("aria-label", "기억 적용 상황");
    const save = document.createElement("button");
    save.type = "button";
    save.className = "memory-save";
    save.textContent = "저장";
    save.addEventListener("click", async () => {
      const response = await api.updateMemory(memory.id, {
        value: value.value,
        scope: scope.value
      });
      if (!response.ok) {
        showToast(response.error.message);
        return;
      }
      showToast("기억을 고쳤어요.");
      await renderMemories();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "memory-delete";
    remove.textContent = "삭제";
    remove.addEventListener("click", async () => {
      await api.removeMemories([memory.id]);
      showToast("기억을 지웠어요.");
      await renderMemories();
    });
    row.append(scope, save, remove);
    card.append(value, row);
    elements.memoryList.append(card);
  }
}

async function openMemoryManager() {
  await renderMemories();
  elements.memoryPopup.classList.remove("is-hidden");
}

function closeTopOverlay() {
  if (!elements.memoryApproval.classList.contains("is-hidden")) {
    clearMemoryApproval({ reject: true });
    return true;
  }
  if (!elements.memoryPopup.classList.contains("is-hidden")) {
    elements.memoryPopup.classList.add("is-hidden");
    return true;
  }
  if (!elements.settingsPopup.classList.contains("is-hidden")) {
    closeSettings();
    return true;
  }
  if (!elements.historyPopup.classList.contains("is-hidden")) {
    elements.historyPopup.classList.add("is-hidden");
    return true;
  }
  return false;
}

installDrag(elements.edgeHandle, { toggleOnClick: true });
installDrag(elements.panelDragHandle);
installDrag(elements.historyPopupDragHandle);
installDrag(elements.settingsPopupDragHandle);
installDrag(elements.memoryPopupDragHandle);
installResize(elements.resizeHandle);
elements.collapseButton.addEventListener("click", () => api.collapsePanel());
elements.chatButton.addEventListener("click", () => {
  showSurface(state.surface === "chat" ? "writing" : "chat");
});
elements.updateButton.addEventListener("click", () => api.installUpdate());
api.onUpdateState(renderUpdateState);
api.getUpdateState().then(renderUpdateState).catch(() => {});
elements.situationToggle.addEventListener("click", () => {
  const expanded = elements.situationSection.classList.contains("is-hidden");
  setCollapsible(elements.situationSection, elements.situationToggle, expanded, "상황");
  if (expanded) elements.situationInput.focus();
});
elements.toolsToggle.addEventListener("click", () => {
  const expanded = elements.toolsSection.classList.contains("is-hidden");
  setCollapsible(elements.toolsSection, elements.toolsToggle, expanded, "도구");
});
elements.settingsButton.addEventListener("click", openSettings);
elements.historyButton.addEventListener("click", openHistory);
elements.settingsCloseButton.addEventListener("click", closeSettings);
elements.historyCloseButton.addEventListener("click", () => elements.historyPopup.classList.add("is-hidden"));
elements.memoryCloseButton.addEventListener("click", () => elements.memoryPopup.classList.add("is-hidden"));
elements.manageMemoryButton.addEventListener("click", openMemoryManager);
elements.newButton.addEventListener("click", () => resetToInput());
elements.attachButton.addEventListener("click", addFiles);
elements.captureButton.addEventListener("click", captureScreen);
elements.enhanceButton.addEventListener("click", () => requestEnhancement());
elements.guessButton.addEventListener("click", requestGuess);
elements.guessBackButton.addEventListener("click", () => setView("input"));
elements.guessCompleteButton.addEventListener("click", () =>
  requestEnhancement({ preflight: true, answer: elements.guessAnswer.value.trim() || "알아서" })
);
elements.guessAutoButton.addEventListener("click", () =>
  requestEnhancement({ preflight: true, answer: "알아서" })
);
elements.reenhanceButton.addEventListener("click", () =>
  requestEnhancement({ regenerateFromOriginal: true })
);
elements.undoButton.addEventListener("click", () => {
  const nextIndex = versionNavigation.moveIndex(
    state.versions.length,
    state.versionIndex,
    "previous"
  );
  if (nextIndex === state.versionIndex) return;
  state.versionIndex = nextIndex;
  renderCurrentVersion();
  saveHistoryNow();
  showToast("이전 결과로 돌아왔어요.");
});
elements.nextButton.addEventListener("click", () => {
  const nextIndex = versionNavigation.moveIndex(
    state.versions.length,
    state.versionIndex,
    "next"
  );
  if (nextIndex === state.versionIndex) return;
  state.versionIndex = nextIndex;
  renderCurrentVersion();
  saveHistoryNow();
  showToast("다음 결과로 이동했어요.");
});
elements.replyButton.addEventListener("click", () => {
  const answer = elements.replyInput.value.trim();
  if (!answer) {
    elements.replyInput.focus();
    return;
  }
  requestEnhancement({ answer });
});
elements.autoButton.addEventListener("click", () => requestEnhancement({ answer: "알아서" }));
elements.rawOriginalToggle.addEventListener("click", () => {
  const expanded = elements.rawOriginalPanel.classList.contains("is-hidden");
  elements.rawOriginalPanel.classList.toggle("is-hidden", !expanded);
  elements.rawOriginalToggle.setAttribute("aria-expanded", String(expanded));
  elements.rawOriginalToggle.textContent = expanded ? "원문 접기" : "원문 보기";
});
elements.memoryRejectButton.addEventListener("click", async () => {
  await clearMemoryApproval({ reject: true });
  showToast("기억에 추가하지 않았어요.");
});
elements.memoryApproveButton.addEventListener("click", async () => {
  const token = state.memoryApprovalToken;
  if (!token) return;
  elements.memoryApproveButton.disabled = true;
  const response = await api.approveMemoryCandidates(token);
  elements.memoryApproveButton.disabled = false;
  state.memoryApprovalToken = "";
  state.memoryCandidates = [];
  elements.memoryApproval.classList.add("is-hidden");
  elements.memoryCandidateList.replaceChildren();
  const ids = response?.memoryIds || [];
  state.memoryIds = ids;
  if (ids.length === 0) {
    showToast("추가할 기억이 없거나 기억 추가가 꺼져 있어요.");
    return;
  }
  showToast("승인한 방식만 기억에 추가했어요.", {
    actionLabel: "취소",
    onAction: async () => {
      await api.removeMemories(ids);
      state.memoryIds = state.memoryIds.filter((id) => !ids.includes(id));
      showToast("방금 추가한 기억을 지웠어요.");
    }
  });
});
elements.applyButton.addEventListener("click", async () => {
  const value = elements.completedText.value.trim();
  if (!value) return;
  const label = elements.applyButton.querySelector("span");
  label.textContent = "복사했어요";
  await api.apply(value);
  window.setTimeout(() => {
    label.textContent = "강화한 글 복사";
  }, 900);
});

for (const voiceButton of document.querySelectorAll(".voice-button")) {
  voiceButton.addEventListener("click", () => startVoiceInput(voiceButton));
}

for (const input of [
  elements.situationInput,
  elements.sourceInput,
  elements.replyInput,
  elements.guessAnswer
]) {
  input.addEventListener("input", () => {
    if (input === elements.replyInput) autoGrow(input);
    if (input === elements.situationInput) {
      setCollapsible(elements.situationSection, elements.situationToggle, true, "상황");
    }
    scheduleDraft();
  });
}

for (const slider of [elements.enhancementLevelInput, elements.enhancementLevelResult]) {
  slider.addEventListener("input", () =>
    updateEnhancementControls(slider.value, { schedule: true })
  );
}

elements.completedText.addEventListener("input", () => {
  const version = currentVersion();
  if (version) {
    version.completedText = elements.completedText.value;
    scheduleDraft();
    scheduleHistorySave();
  }
});

elements.sourceInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    requestEnhancement();
  }
});
elements.replyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    const answer = elements.replyInput.value.trim();
    if (answer) requestEnhancement({ answer });
  }
});

elements.opacityInput.addEventListener("input", () => {
  settingsRangeLabels();
  previewDisplaySettings();
});
elements.fontScaleInput.addEventListener("input", () => {
  settingsRangeLabels();
  previewDisplaySettings();
});
elements.windowWidthInput.addEventListener("input", previewDisplaySettings);
elements.windowHeightInput.addEventListener("input", previewDisplaySettings);
elements.windowMode.addEventListener("change", previewDisplaySettings);
elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.settingsError.textContent = "";
  const response = await api.saveSettings({
    ...displaySettingsPayload(),
    updateShortcut: true,
    shortcut: elements.shortcutInput.value.trim(),
    openaiKey: elements.openaiKey.value.trim(),
    geminiKey: elements.geminiKey.value.trim()
  });
  if (!response.ok) {
    elements.settingsError.textContent = response.error.message;
    return;
  }
  closeSettings();
  showToast("설정을 저장했어요.");
});

elements.clearMemoryButton.addEventListener("click", async () => {
  if (!window.confirm("저장된 기억을 모두 지울까요?")) return;
  await api.clearMemories();
  await renderMemories();
  elements.memoryCount.textContent = "0개 저장됨";
  showToast("저장된 기억을 모두 지웠어요.");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (window.sideChatSurface?.handleEscape()) {
    event.preventDefault();
    return;
  }
  if (!closeTopOverlay()) api.collapsePanel();
});
window.addEventListener("beforeunload", () => {
  api.saveDraft(draftPayload());
});

function handlePanelState({ expanded, side, shortcutWarning }) {
  setExpanded(expanded, side);
  if (expanded && shortcutWarning && !state.shortcutWarningShown) {
    state.shortcutWarningShown = true;
    showToast(shortcutWarning, { duration: 8_000 });
  }
}

api.onPanelState(handlePanelState);
api.onFocusInput(() => {
  if (state.surface === "chat") window.sideChatSurface?.focus();
  else focusWritingInput();
});
api.onSurfaceShow(showSurface);
api.onOpenSettings(openSettings);
api.onOpenHistory(openHistory);
api.onSideChatWritingAction(async (action) => {
  const name = action?.name || "none";
  const value = String(action?.value || "");
  if (name === "none") return;
  // 채팅에서 실행한 동작의 결과를 바로 볼 수 있게 글 강화기 화면으로 전환한다.
  showSurface("writing");

  if (name === "show_writing") {
    if (state.versions.length > 0) renderCurrentVersion();
    else setView("input");
  } else if (name === "focus_source") {
    setView("input");
    elements.sourceInput.focus();
  } else if (name === "replace_source") {
    resetToInput();
    elements.sourceInput.value = value;
    autoGrow(elements.sourceInput);
    scheduleDraft();
    elements.sourceInput.focus();
    showToast("사이드 채팅의 내용을 원문에 반영했어요.");
  } else if (name === "set_situation") {
    elements.situationInput.value = value;
    setView("input");
    setCollapsible(elements.situationSection, elements.situationToggle, true, "상황");
    scheduleDraft();
    elements.situationInput.focus();
    showToast("상황 안내를 반영했어요.");
  } else if (name === "replace_result") {
    const version = currentVersion();
    if (!version || !value.trim()) {
      showToast("먼저 완성된 결과가 필요해요.");
    } else {
      const appended = versionNavigation.appendVersion(state.versions, {
        completedText: value,
        followUp: version.followUp,
        enhancementLevel: version.enhancementLevel
      });
      state.versions = appended.versions;
      state.versionIndex = appended.index;
      renderCurrentVersion();
      scheduleHistorySave();
      showToast("채팅의 내용을 새 결과 버전으로 반영했어요.");
    }
  } else if (name === "set_follow_up_reply") {
    if (state.versions.length === 0) {
      showToast("후속 요구를 넣을 결과가 아직 없어요.");
    } else {
      renderCurrentVersion();
      elements.replyInput.value = value;
      autoGrow(elements.replyInput);
      scheduleDraft();
      elements.replyInput.focus();
      showToast("후속 요구 입력란에 반영했어요.");
    }
  } else if (name === "enhance") {
    await requestEnhancement();
  } else if (name === "reenhance") {
    await requestEnhancement(
      state.versions.length > 0 ? { regenerateFromOriginal: true } : {}
    );
  } else if (name === "copy_result") {
    const completedText = currentVersion()?.completedText || elements.completedText.value;
    if (!completedText.trim()) {
      showToast("복사할 강화 결과가 아직 없어요.");
    } else {
      await api.apply(completedText);
    }
  } else if (name === "new_writing") {
    resetToInput();
    showToast("새 글을 시작할 준비가 됐어요.");
  } else if (name === "open_history") {
    await openHistory();
  } else if (name === "open_settings") {
    await openSettings();
  } else if (name === "open_memories") {
    await openMemoryManager();
  } else if (name === "open_tools") {
    setView("input");
    setCollapsible(elements.toolsSection, elements.toolsToggle, true, "도구");
    elements.toolsToggle.focus();
  } else if (name === "set_enhancement_level") {
    updateEnhancementControls(value, { schedule: true });
    showToast(`강화 범위를 ${state.enhancementLevel}단계로 바꿨어요.`);
  } else if (name === "previous_result") {
    elements.undoButton.click();
  } else if (name === "next_result") {
    elements.nextButton.click();
  } else if (name === "guess_intent") {
    setView("input");
    await requestGuess();
  }
  scheduleWritingContextSync();
});

async function restoreDraft() {
  const draft = await api.loadDraft();
  elements.situationInput.value = draft.situation || "";
  elements.sourceInput.value = draft.input || "";
  elements.replyInput.value = draft.reply || "";
  elements.guessAnswer.value = draft.guessAnswer || "";
  updateEnhancementControls(draft.enhancementLevel);
  state.attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
  renderAttachments();
  setCollapsible(elements.situationSection, elements.situationToggle, false, "상황");
  setCollapsible(elements.toolsSection, elements.toolsToggle, false, "도구");
  state.historyId = draft.historyId || "";
  state.versions = Array.isArray(draft.versions) ? draft.versions : [];
  state.versionIndex = Math.min(
    Number(draft.versionIndex) || 0,
    Math.max(0, state.versions.length - 1)
  );
  if (state.versions.length > 0) {
    renderCurrentVersion();
  } else if (draft.guessQuestion) {
    state.guess = {
      assumption: draft.guessAssumption || "",
      question: draft.guessQuestion
    };
    elements.guessAssumption.textContent =
      state.guess.assumption || "제가 이해한 방향을 먼저 확인할게요.";
    elements.guessQuestion.textContent = state.guess.question;
    setView("guess");
  } else {
    setView("input");
  }
  autoGrow(elements.replyInput);
  await syncWritingContext();
}

function setQaState(name) {
  document.activeElement?.blur();
  window.scrollTo(0, 0);
  document.body.style.background = "transparent";
  document.querySelector(".panel").style.opacity = "";
  for (const popup of [
    elements.settingsPopup,
    elements.historyPopup,
    elements.memoryPopup,
    elements.memoryApproval
  ]) {
    popup.classList.add("is-hidden");
  }
  if (name === "input") {
    resetToInput();
    elements.situationInput.value = "";
    elements.sourceInput.value = "";
  } else if (name === "attachments") {
    setView("input");
    elements.situationInput.value = "신규 서비스 일정을 팀장에게 보고";
    elements.sourceInput.value = "일정 좀 늦어질듯 품질 때문에 하루 더 필요";
    state.attachments = [
      { id: "qa-1", name: "일정표.pdf", kind: "document", source: "file", size: 382_000 },
      { id: "qa-2", name: "현재 화면.png", kind: "image", source: "screen", size: 640_000 }
    ];
    renderAttachments();
  } else if (name === "tools") {
    setView("input");
    elements.sourceInput.value = "자료를 참고해서 일정 변경 요청으로 자연스럽게 정리해 줘";
    state.attachments = [
      { id: "qa-1", name: "일정표.pdf", kind: "document", source: "file", size: 382_000 }
    ];
    renderAttachments();
    setCollapsible(elements.toolsSection, elements.toolsToggle, true, "도구");
  } else if (name === "guess") {
    setView("guess");
    elements.guessAssumption.textContent = "팀장에게 일정 지연을 보고하는 글로 이해했어요.";
    elements.guessQuestion.textContent = "하루 연장 일정은 이미 확정됐나요, 아니면 승인을 요청하는 단계인가요?";
    elements.guessAnswer.value = "아직 승인 전";
  } else if (name === "result") {
    state.versions = [
      {
        completedText: "핵심 기능의 품질을 확보하기 위해 검수 일정을 하루 연장할 필요가 있습니다.",
        followUp: "팀 내부 보고로 이해했어요.",
        enhancementLevel: 2,
        createdAt: new Date().toISOString()
      },
      {
        completedText:
          "현재 일정대로 진행하면 핵심 기능의 품질 확보가 어렵습니다. 완성도를 유지하기 위해 검수 일정을 하루 연장하고자 합니다. 승인해 주시면 변경된 일정에 맞춰 차질 없이 마무리하겠습니다.",
        followUp:
          "팀장에게 일정 변경 승인을 요청하는 상황으로 보고, 이유와 다음 행동이 바로 보이게 정리했어요. 더 단호하게 바꿀까요?",
        enhancementLevel: 3,
        createdAt: new Date().toISOString()
      },
      {
        completedText:
          "현재 일정으로는 핵심 기능의 품질을 충분히 확보하기 어렵습니다. 검수 일정을 하루 연장해 완성도를 지키고자 하니 승인 부탁드립니다.",
        followUp: "더 짧고 단단하게 다시 강화했어요. 이 정도 강도로 보내면 자연스러워요.",
        enhancementLevel: 4,
        createdAt: new Date().toISOString()
      }
    ];
    state.versionIndex = 1;
    renderCurrentVersion();
    elements.replyInput.value = "조금만 더 부드럽게 부탁";
    autoGrow(elements.replyInput);
  } else if (name === "first-follow-up") {
    elements.sourceInput.value = "일정 좀 늦어질듯 품질 때문에 하루 더 필요";
    state.versions = [
      {
        completedText:
          "현재 일정으로는 핵심 기능의 품질을 충분히 확보하기 어렵습니다. 완성도를 유지하기 위해 검수 일정을 하루 연장하고자 하니 승인 부탁드립니다.",
        followUp:
          "팀장에게 일정 변경 승인을 요청하는 업무 보고로 보여요. 이 목적에 맞게 이유와 요청 흐름을 조금 더 다듬어도 될까요?",
        enhancementLevel: 3,
        createdAt: new Date().toISOString()
      }
    ];
    state.versionIndex = 0;
    renderCurrentVersion();
    elements.replyInput.value = "";
    autoGrow(elements.replyInput);
  } else if (name === "memory-approval") {
    state.versions = [
      {
        completedText:
          "현재 일정으로는 핵심 기능의 품질을 충분히 확보하기 어렵습니다. 검수 일정을 하루 연장해 완성도를 지키고자 하니 승인 부탁드립니다.",
        followUp: "팀장에게 보내는 보고는 결론부터 쓰는 편이 자연스러워 보여요.",
        enhancementLevel: 3,
        createdAt: new Date().toISOString()
      }
    ];
    state.versionIndex = 0;
    renderCurrentVersion();
    state.memoryApprovalToken = "qa-memory";
    state.memoryCandidates = [
      { value: "내부 일정 보고는 결론과 요청 사항을 먼저 쓴다." }
    ];
    elements.memoryCandidateList.replaceChildren();
    const item = document.createElement("li");
    item.textContent = state.memoryCandidates[0].value;
    elements.memoryCandidateList.append(item);
    elements.memoryApproval.classList.remove("is-hidden");
  } else if (name === "history") {
    setView("input");
    renderHistoryItems([
      {
        id: "qa-history-1",
        title: "일정 좀 늦어질듯 품질 때문에",
        inputPreview: "일정 좀 늦어질듯 품질 때문에 하루 더 필요",
        preview: "현재 일정으로는 핵심 기능의 품질을 충분히 확보하기 어렵습니다.",
        updatedAt: new Date().toISOString(),
        versionCount: 3
      },
      {
        id: "qa-history-2",
        title: "고객에게 답장 늦어서 미안하다고",
        inputPreview: "고객에게 답장 늦어서 미안하다고 전하고 싶음",
        preview: "답변이 늦어 죄송합니다. 요청하신 내용을 확인해 안내드립니다.",
        updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
        versionCount: 1
      }
    ]);
    elements.historyPopup.classList.remove("is-hidden");
  } else if (name === "settings") {
    setView("input");
    elements.windowMode.value = "docked";
    elements.opacityInput.value = "98";
    elements.fontScaleInput.value = "100";
    elements.windowWidthInput.value = "440";
    elements.windowHeightInput.value = "740";
    elements.shortcutInput.value = "CommandOrControl+Shift+Space";
    elements.memoryCount.textContent = "3개 저장됨 · 기존 기억은 유지";
    elements.memoryAdditionsDisabled.checked = false;
    settingsRangeLabels();
    elements.settingsPopup.classList.remove("is-hidden");
  } else if (name === "memory") {
    setView("input");
    elements.memoryList.replaceChildren();
    for (const [valueText, scopeText] of [
      ["고객 메시지는 결론부터 짧고 정중하게 작성한다.", "고객 메시지"],
      ["내부 보고는 문제 다음에 제안 일정을 바로 적는다.", "회사 업무 보고"]
    ]) {
      const card = document.createElement("article");
      card.className = "memory-card";
      const value = document.createElement("textarea");
      value.value = valueText;
      const row = document.createElement("div");
      row.className = "memory-card-row";
      const scope = document.createElement("input");
      scope.className = "memory-scope";
      scope.value = scopeText;
      const save = document.createElement("button");
      save.className = "memory-save";
      save.textContent = "저장";
      const remove = document.createElement("button");
      remove.className = "memory-delete";
      remove.textContent = "삭제";
      row.append(scope, save, remove);
      card.append(value, row);
      elements.memoryList.append(card);
    }
    elements.memoryEmpty.classList.add("is-hidden");
    elements.memoryPopup.classList.remove("is-hidden");
  } else if (name === "opacity-min") {
    state.versions = [
      {
        completedText:
          "배경 위에서도 완성된 글과 버튼을 또렷하게 읽을 수 있도록 최소 투명도를 제한했습니다.",
        followUp: "가장 낮은 55% 투명도에서도 조절 상태를 확인하는 화면이에요.",
        enhancementLevel: 3,
        createdAt: new Date().toISOString()
      }
    ];
    state.versionIndex = 0;
    renderCurrentVersion();
    document.body.style.background =
      "linear-gradient(135deg, #4b5563 0 50%, #6b7280 50% 100%)";
    document.querySelector(".panel").style.opacity = "0.55";
  }
}

window.__writingEnhancerQa = { show: setQaState };

api.getPanelState().then(handlePanelState);
restoreDraft();
