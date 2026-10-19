"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  shell,
  Tray
} = require("electron");

const { AIClient } = require("./lib/ai-client");
const {
  MAX_ATTACHMENT_COUNT,
  chooseCaptureSource,
  fitCaptureDimensions,
  makeBoundedScreenAttachment,
  normalizeAttachments,
  readAttachment
} = require("./lib/attachment-utils");
const { ConfigStore } = require("./lib/config-store");
const { DraftStore } = require("./lib/draft-store");
const { HistoryStore } = require("./lib/history-store");
const { APP_USER_MODEL_ID, ensureInstallShortcuts } = require("./lib/install-shortcuts");
const { groundMemoryCandidates } = require("./lib/memory-grounding");
const { MemoryStore } = require("./lib/memory-store");
const {
  SelectionHelper,
  appLabel,
  cleanSelection,
  copyMode,
  pasteMode,
  restoreClipboard,
  snapshotClipboard
} = require("./lib/selection-helper");
const { SideChatStore } = require("./lib/side-chat-store");
const { UpdateManager, updatableInstall } = require("./lib/updater");
const chatAnswer = require("./renderer/chat-answer");
const enhancementLevels = require("./renderer/enhancement-levels");
const {
  DEFAULT_SELECTION_SHORTCUT,
  DEFAULT_SHORTCUT,
  registerWithFallback
} = require("./lib/shortcut-registration");
const { finalizeDraggedBounds, resolvePanelBounds } = require("./lib/window-layout");
const { imageCropRect, normalizeSelection } = require("./lib/screen-read");

const QA_CAPTURE = process.argv.includes("--qa-capture");
const SMOKE_TEST = process.argv.includes("--smoke-test");

if (QA_CAPTURE) {
  app.setPath("userData", path.join(app.getAppPath(), "qa", ".user-data-v2"));
} else if (SMOKE_TEST) {
  app.setPath("userData", path.join(os.tmpdir(), `writing-enhancer-smoke-v2-${process.pid}`));
}

let mainWindow;
let tray;
let configStore;
let memoryStore;
let historyStore;
let draftStore;
let sideChatStore;
let aiClient;
let updateManager = null;
// 알림 객체를 잡아 두지 않으면 누르기 전에 정리될 수 있다.
let updateNotification = null;
let isExpanded = false;
let isQuitting = false;
let autoCollapseSuppressedUntil = 0;
let autoCollapseBlockCount = 0;
let shortcutStatus = {
  registered: false,
  activeShortcut: "",
  warning: ""
};
let selectionShortcutStatus = {
  registered: false,
  activeShortcut: "",
  warning: ""
};
// 전역 단축키 두 개(창 열기, 선택한 글 강화)가 지금 쓰는 조합.
const registeredShortcuts = { panel: "", selection: "" };
let selectionHelper = null;
let selectionCaptureBusy = false;
// 바꿔 넣을 프로그램 창은 화면에 넘기지 않고 이 표식으로만 찾는다. 가장 최근 것 하나만 둔다.
const selectionTargets = new Map();
// 마지막으로 확인한 클립보드 글의 지문. 새로 복사한 글만 강화 제안에 쓴다.
let lastClipboardFingerprint = "";
const pendingMemoryApprovals = new Map();
// 진행 중인 사이드 채팅 요청과, 사용자 확인을 기다리는 채팅 제안 동작.
let activeSideChatRequest = null;
let pendingSideChatAction = null;

function suppressAutoCollapse(durationMs = 900) {
  autoCollapseSuppressedUntil = Math.max(
    autoCollapseSuppressedUntil,
    Date.now() + Math.max(0, Number(durationMs) || 0)
  );
}

function canAutoCollapse() {
  return (
    !isQuitting &&
    !QA_CAPTURE &&
    !SMOKE_TEST &&
    autoCollapseBlockCount === 0 &&
    Date.now() >= autoCollapseSuppressedUntil
  );
}

function blockAutoCollapse() {
  autoCollapseBlockCount += 1;
  return () => {
    autoCollapseBlockCount = Math.max(0, autoCollapseBlockCount - 1);
    suppressAutoCollapse(400);
  };
}
let panelDragSession;
let panelResizeSession;
let latestWritingContext = {};

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function limitedText(value, maximum) {
  return String(value ?? "").replace(/\u0000/gu, "").slice(0, maximum).trim();
}

function normalizeWritingContext(value = {}) {
  const view = ["input", "guess", "result", "loading"].includes(value?.view)
    ? value.view
    : "input";
  const versionCount = Math.max(0, Math.min(100, Number(value?.versionCount) || 0));
  const versionIndex = Math.max(
    0,
    Math.min(Math.max(versionCount - 1, 0), Number(value?.versionIndex) || 0)
  );
  return {
    view,
    situation: limitedText(value?.situation, 4_000),
    input: limitedText(value?.input, 12_000),
    completedText: limitedText(value?.completedText, 16_000),
    followUp: limitedText(value?.followUp, 2_000),
    reply: limitedText(value?.reply, 4_000),
    enhancementLevel: enhancementLevels.normalize(value?.enhancementLevel),
    versionCount,
    versionIndex,
    attachmentNames: (Array.isArray(value?.attachmentNames) ? value.attachmentNames : [])
      .map((name) => limitedText(name, 180))
      .filter(Boolean)
      .slice(0, MAX_ATTACHMENT_COUNT)
  };
}

function writingContextFromDraft() {
  const draft = draftStore?.load?.() || {};
  const versions = Array.isArray(draft.versions) ? draft.versions : [];
  const versionIndex = Math.max(
    0,
    Math.min(versions.length - 1, Number(draft.versionIndex) || 0)
  );
  const version = versions[versionIndex] || {};
  return normalizeWritingContext({
    view: versions.length > 0 ? "result" : draft.guessQuestion ? "guess" : "input",
    situation: draft.situation,
    input: draft.input,
    completedText: version.completedText,
    followUp: version.followUp || draft.guessQuestion,
    reply: draft.reply || draft.guessAnswer,
    enhancementLevel: draft.enhancementLevel || version.enhancementLevel,
    versionCount: versions.length,
    versionIndex,
    attachmentNames: (Array.isArray(draft.attachments) ? draft.attachments : []).map(
      (attachment) => attachment?.name
    )
  });
}

function getWritingContext() {
  return normalizeWritingContext({
    ...writingContextFromDraft(),
    ...latestWritingContext
  });
}

function broadcastWritingContext() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("side-chat:writing-context-updated", getWritingContext());
}

// 사이드 채팅은 글 강화기 창 안의 화면이다. 창을 보이게 하고 채팅 입력칸에 초점을 준다.
function focusChatSurface() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send("side-chat:focus-input");
}

function dispatchWritingAction(action) {
  const name = limitedText(action?.name, 80) || "none";
  if (name === "none" || !mainWindow || mainWindow.isDestroyed()) return null;
  const normalized = {
    name,
    value: limitedText(action?.value, 12_000)
  };
  setPanelState(true, { focus: false });
  mainWindow.focus();
  mainWindow.webContents.send("side-chat:writing-action", normalized);
  return normalized;
}

function sendSideChatProgress(progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("side-chat:progress", {
    stage: limitedText(progress?.stage, 40),
    provider: limitedText(progress?.provider, 40),
    searchPolicy: limitedText(progress?.searchPolicy, 40)
  });
}

// 스트리밍 글을 40ms마다 모아 화면에 보낸다. 제어 블록은 보내지 않는다.
function createSideChatDeltaSender() {
  let latest = "";
  let timer = null;
  const send = () => {
    timer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("side-chat:delta", { text: chatAnswer.visibleStreamText(latest) });
  };
  return {
    push(text) {
      latest = String(text || "");
      if (!timer) timer = setTimeout(send, 40);
    },
    reset() {
      latest = "";
      if (timer) clearTimeout(timer);
      timer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("side-chat:delta", { text: "" });
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

function discardPendingSideChatAction() {
  pendingSideChatAction = null;
}

function cancelActiveSideChatRequest() {
  activeSideChatRequest?.abort();
  activeSideChatRequest = null;
}

async function requestSideChatReply({ input, messages, attachments = [], forceSearch = false }) {
  cancelActiveSideChatRequest();
  discardPendingSideChatAction();
  const controller = new AbortController();
  activeSideChatRequest = controller;
  const deltas = createSideChatDeltaSender();
  try {
    return await aiClient.chat({
      input,
      messages,
      writingContext: getWritingContext(),
      attachments,
      screenContext: attachments.length > 0,
      forceSearch,
      signal: controller.signal,
      onProgress: (progress) => {
        // 다른 AI로 다시 물으면 앞서 흘려 보낸 글을 지운다.
        if (progress?.stage === "fallback") deltas.reset();
        sendSideChatProgress(progress);
      },
      onDelta: (text) => deltas.push(text)
    });
  } finally {
    deltas.stop();
    if (activeSideChatRequest === controller) activeSideChatRequest = null;
  }
}

// 외부 자료가 섞인 답변의 동작은 바로 실행하지 않고 사용자가 [적용]을 누를 때까지 보관한다.
function settleSideChatAction(result) {
  const name = limitedText(result?.action?.name, 80) || "none";
  if (name === "none") return { action: null, pendingAction: null };
  const action = { name, value: limitedText(result?.action?.value, 12_000) };
  if (result?.actionRequiresConfirmation === true) {
    pendingSideChatAction = { token: crypto.randomUUID(), action };
    return {
      action: null,
      pendingAction: { token: pendingSideChatAction.token, ...action }
    };
  }
  return { action: dispatchWritingAction(action), pendingAction: null };
}

function sideChatMessageOptions(result) {
  return {
    externalGrounding: result.externalGrounding === true,
    sourcesMissing: result.sourcesMissing === true,
    citations: result.citations,
    styles: result.styles,
    category: result.category,
    searchQueries: result.searchQueries
  };
}

function sideChatReplyResponse(messages, result) {
  const settled = settleSideChatAction(result);
  return {
    ok: true,
    messages,
    action: settled.action,
    pendingAction: settled.pendingAction,
    result: {
      reply: result.reply,
      provider: result.provider,
      model: result.model,
      fallbackUsed: result.fallbackUsed,
      webSearchUsed: result.webSearchUsed === true,
      sourcesMissing: result.sourcesMissing === true,
      category: result.category
    }
  };
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="9" fill="#6D5DFB"/>
    <path d="M9 9h14v3H9zm0 6h10v3H9zm0 6h7v3H9z" fill="white"/>
    <path d="m22 18 1.2 2.8L26 22l-2.8 1.2L22 26l-1.2-2.8L18 22l2.8-1.2z" fill="#CFFAFE"/>
  </svg>`;
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 16, height: 16 });
}

function getDisplayForBounds(bounds) {
  return screen.getDisplayMatching(bounds || mainWindow?.getBounds() || screen.getPrimaryDisplay().workArea);
}

function getPanelBounds(expanded) {
  const display = getDisplayForBounds();
  return resolvePanelBounds({
    expanded,
    settings: configStore.getPublicSettings(),
    placement: configStore.getPlacement(expanded),
    workArea: display.workArea
  });
}

function currentSide() {
  const display = getDisplayForBounds();
  const bounds = mainWindow?.getBounds();
  if (!bounds) return configStore.getPublicSettings().dockSide;
  return bounds.x + bounds.width / 2 < display.workArea.x + display.workArea.width / 2
    ? "left"
    : "right";
}

function persistPlacement(expanded = isExpanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  configStore.savePlacement(expanded, { x: bounds.x, y: bounds.y, side: currentSide() });
}

function applyAppearance() {
  const settings = configStore.getPublicSettings();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOpacity(settings.windowOpacity);
    mainWindow.webContents.setZoomFactor(settings.fontScale);
  }
}

// 글 강화기 창을 펼치고 그 안의 화면("writing" 또는 "chat")을 보여 준다.
function showSurface(surface, { focus = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  suppressAutoCollapse();
  setPanelState(true, { focus, remember: false });
  mainWindow.webContents.send("panel:surface", surface);
}

function showChatSurface({ focus = true } = {}) {
  showSurface("chat", { focus });
  broadcastWritingContext();
}

function showWritingWindow({ settings = false, focus = true } = {}) {
  showSurface("writing", { focus });
  if (settings) mainWindow.webContents.send("settings:open");
}

function repositionForDisplayChange() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const side =
    current.x + current.width / 2 < display.workArea.x + display.workArea.width / 2
      ? "left"
      : "right";
  const resolved = resolvePanelBounds({
    expanded: isExpanded,
    settings: configStore.getPublicSettings(),
    placement: { x: current.x, y: current.y, side },
    workArea: display.workArea
  });
  const { side: resolvedSide, ...bounds } = resolved;
  mainWindow.setBounds(bounds);
  configStore.savePlacement(isExpanded, { ...bounds, side: resolvedSide });
  sendPanelState();
}

function sendPanelState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("panel:state", {
    expanded: isExpanded,
    side: currentSide(),
    windowMode: configStore.getPublicSettings().windowMode,
    shortcutWarning: shortcutStatus.warning
  });
}

function setPanelState(expanded, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  panelDragSession = undefined;
  panelResizeSession = undefined;
  if (isExpanded !== expanded && mainWindow.isVisible() && options.remember !== false) {
    persistPlacement(isExpanded);
  }
  if (isExpanded && !expanded) {
    // 접을 때 사이드 채팅에 준비해 둔 일회성 화면 이미지를 버린다.
    mainWindow.webContents.send("side-chat:discard-screen-context");
  }
  isExpanded = expanded;
  const { side: _side, ...bounds } = getPanelBounds(expanded);
  mainWindow.setResizable(false);
  mainWindow.setBounds(bounds, options.animate === true);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyAppearance();
  sendPanelState();
  if (options.show !== false) {
    if (options.focus === false) mainWindow.showInactive();
    else mainWindow.show();
  }
  if (expanded && options.focus !== false) {
    mainWindow.focus();
    mainWindow.webContents.send("panel:focus-input");
  }
}

function togglePanel() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) {
    setPanelState(true);
    offerCopiedText();
    return;
  }
  setPanelState(!isExpanded, { animate: true });
  if (isExpanded) offerCopiedText();
}

function createWindow() {
  const { side: _side, ...bounds } = getPanelBounds(false);
  mainWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: "글 강화기",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyAppearance();
  const appSession = mainWindow.webContents.session;
  appSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission !== "media") return false;
    const mediaTypes = details?.mediaTypes || (details?.mediaType ? [details.mediaType] : []);
    return mediaTypes.includes("audio") && !mediaTypes.includes("video");
  });
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = details?.mediaTypes || (details?.mediaType ? [details.mediaType] : []);
    const audioOnly =
      permission === "media" &&
      mediaTypes.includes("audio") &&
      !mediaTypes.includes("video");
    callback(webContents === mainWindow.webContents && audioOnly);
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => setPanelState(false, { focus: false, remember: false }));
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      setPanelState(false, { focus: false });
    }
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const template = editContextMenu(params);
    if (template.length === 0) return;
    const release = blockAutoCollapse();
    Menu.buildFromTemplate(template).popup({ window: mainWindow, callback: release });
  });
  mainWindow.on("blur", () => {
    // 이 창에서 복사한 글은 나중에 "복사한 글 강화" 제안으로 다시 묻지 않는다.
    rememberClipboard();
    if (!canAutoCollapse() || !mainWindow?.isVisible() || !isExpanded) return;
    setPanelState(false, { animate: true, focus: false });
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

async function captureQaScreens() {
  const qaDirectory = path.join(app.getAppPath(), "qa");
  fs.mkdirSync(qaDirectory, { recursive: true });
  await wait(300);
  setPanelState(true, { focus: false, remember: false });
  await wait(300);

  const capture = async (fileName) => {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(qaDirectory, fileName), image.toPNG());
  };
  const setQa = async (state) => {
    await mainWindow.webContents.executeJavaScript(`window.__writingEnhancerQa?.show(${JSON.stringify(state)})`);
    await wait(140);
  };

  await setQa("input");
  await capture("v3-01-input.png");
  await setQa("attachments");
  await capture("v3-02-attachments.png");
  await setQa("tools");
  await capture("v3-03-tools-expanded.png");
  await setQa("guess");
  await capture("v3-04-guess-first.png");
  await setQa("result");
  await capture("v3-05-result-versions.png");
  await setQa("first-follow-up");
  await capture("v4-02-first-follow-up.png");
  await setQa("memory-approval");
  await capture("v3-06-memory-approval.png");
  await setQa("history");
  await capture("v3-07-history.png");
  await setQa("settings");
  await capture("v3-08-settings-memory.png");
  await setQa("memory");
  await capture("v3-09-memory-editor.png");
  const captureChat = async (script, fileName) => {
    await mainWindow.webContents.executeJavaScript(
      `window.__writingEnhancerQa?.show("result"); window.writingPanel?.showSurface("chat"); ${script}`
    );
    await wait(180);
    await capture(fileName);
  };
  await captureChat("window.__sideChatQa?.showDemo()", "v4-01-side-chat-beta.png");
  await captureChat("window.__sideChatQa?.showEditDemo()", "v4-03-side-chat-edit.png");
  await captureChat("window.__sideChatQa?.showSearchDemo()", "v5-01-side-chat-confirm.png");
  await captureChat("window.__sideChatQa?.showProgressDemo()", "v5-02-side-chat-progress.png");
  await captureChat("window.__sideChatQa?.showSourceDialogDemo()", "v5-03-side-chat-source-dialog.png");
  await captureChat("window.__sideChatQa?.showStreamingDemo()", "v5-04-side-chat-streaming.png");
  const captureSelection = async (script, fileName) => {
    await mainWindow.webContents.executeJavaScript(
      `window.writingPanel?.showSurface("writing"); window.__writingEnhancerQa?.show("input"); ${script}`
    );
    await wait(180);
    await capture(fileName);
  };
  await captureSelection('window.selectionPanel?.showDemo("options")', "v6-01-selection-options.png");
  await captureSelection('window.selectionPanel?.showDemo("result")', "v6-02-selection-result.png");
  await captureSelection('window.selectionPanel?.showDemo("situations")', "v6-04-selection-situations.png");
  await captureSelection('window.selectionPanel?.showDemo("screen")', "v7-01-screen-read-translate.png");
  await captureSelection('window.selectionPanel?.showDemo("translate-result")', "v7-02-translate-result.png");
  await captureSelection(
    'window.selectionPanel?.close(); document.querySelector("#copyOfferPreview").textContent = "내일 회의 자료 아직 못 만들었어. 오늘 밤까지 정리해서… · 41자"; document.querySelector("#copyOffer").classList.remove("is-hidden")',
    "v6-03-copy-offer.png"
  );
  await mainWindow.webContents.executeJavaScript('document.querySelector("#copyOffer").classList.add("is-hidden")');
  await mainWindow.webContents.executeJavaScript('window.writingPanel?.showSurface("writing")');
  setPanelState(true, { focus: false, remember: false });
  setPanelState(true, { focus: false, remember: false });
  await setQa("opacity-min");
  await capture("v3-10-opacity-min-readability.png");

  isQuitting = true;
  app.quit();
}

const SHORTCUT_ACTIONS = {
  panel: () => togglePanel(),
  selection: () => enhanceSelectionFromShortcut()
};

// kind("panel" 또는 "selection") 단축키를 바꾼다. 실패하면 쓰던 조합을 그대로 둔다.
function registerShortcut(shortcut, kind = "panel") {
  const other = kind === "panel" ? "selection" : "panel";
  if (shortcut && shortcut.toLowerCase() === registeredShortcuts[other].toLowerCase()) {
    throw new Error(`단축키 ${shortcut}은 이미 다른 기능에 쓰고 있어요. 다른 조합을 입력해 주세요.`);
  }
  const previous = registeredShortcuts[kind];
  if (previous === shortcut && globalShortcut.isRegistered(shortcut)) return;
  if (previous) globalShortcut.unregister(previous);
  registeredShortcuts[kind] = "";
  let registered = false;
  try {
    registered = globalShortcut.register(shortcut, SHORTCUT_ACTIONS[kind]);
  } catch {
    registered = false;
  }
  if (!registered) {
    if (previous) {
      try {
        if (globalShortcut.register(previous, SHORTCUT_ACTIONS[kind])) registeredShortcuts[kind] = previous;
      } catch {
        // 예전 조합도 쓸 수 없으면 비워 둔다.
      }
    }
    throw new Error(`단축키 ${shortcut}을 등록할 수 없습니다. 다른 조합을 입력해 주세요.`);
  }
  registeredShortcuts[kind] = shortcut;
}

function registerInitialShortcut(preferred) {
  shortcutStatus = registerWithFallback({
    preferred,
    fallback: DEFAULT_SHORTCUT,
    register: (shortcut) => registerShortcut(shortcut, "panel")
  });
  return shortcutStatus;
}

function registerInitialSelectionShortcut(preferred) {
  const result = registerWithFallback({
    preferred,
    fallback: DEFAULT_SELECTION_SHORTCUT,
    register: (shortcut) => registerShortcut(shortcut, "selection")
  });
  selectionShortcutStatus = {
    ...result,
    warning: result.registered
      ? result.warning.replace("열 수 있어요", "선택한 글을 강화할 수 있어요")
      : "선택한 글 강화 단축키를 등록하지 못했어요. 설정에서 다른 조합을 입력해 주세요."
  };
  return selectionShortcutStatus;
}

function shortcutSettings() {
  return {
    shortcutRegistered: shortcutStatus.registered,
    activeShortcut: shortcutStatus.activeShortcut,
    shortcutWarning: shortcutStatus.warning,
    selectionShortcutRegistered: selectionShortcutStatus.registered,
    activeSelectionShortcut: selectionShortcutStatus.activeShortcut,
    selectionShortcutWarning: selectionShortcutStatus.warning
  };
}

// ── 선택한 글 강화 ─────────────────────────────────────────

function getSelectionHelper() {
  if (process.platform !== "win32") return null;
  selectionHelper ??= new SelectionHelper({ directory: path.join(app.getPath("userData"), "helper") });
  return selectionHelper;
}

function clipboardFingerprint(value) {
  return crypto.createHash("sha256").update(cleanSelection(value)).digest("hex");
}

// 지금 클립보드 글을 "이미 본 글"로 기록한다. 앱이 직접 쓴 글이나 이 앱 창에서 복사한 글은 제안하지 않는다.
function rememberClipboard() {
  try {
    lastClipboardFingerprint = clipboardFingerprint(clipboard.readText());
  } catch {
    lastClipboardFingerprint = "";
  }
}

function writeClipboardText(value) {
  clipboard.writeText(value);
  rememberClipboard();
}

function rememberSelectionTarget(target) {
  selectionTargets.clear();
  if (!target?.hwnd) return "";
  const token = crypto.randomUUID();
  selectionTargets.set(token, target);
  return token;
}

function selectionPayload({ text, target, source, language = "", languageName = "" }) {
  return {
    text,
    source,
    token: rememberSelectionTarget(target),
    targetLabel: target ? appLabel(target) : "",
    canReplace: Boolean(target?.hwnd),
    language,
    languageName
  };
}

function openSelection({ text, target = null, source, language = "", languageName = "" }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showWritingWindow({ focus: true });
  mainWindow.webContents.send(
    "selection:open",
    selectionPayload({ text, target, source, language, languageName })
  );
}

// ── 화면에서 글 읽기 ───────────────────────────────────────
// 드래그할 수 없는 글(이미지·게임·영상 자막 등)은 화면을 찍고, 사용자가 고른 부분을 AI가 읽는다.

let screenReadBusy = false;

// 찍어 둔 화면을 전체 화면 창에 띄워 사용자가 읽을 부분을 드래그로 고르게 한다. 취소하면 null.
function selectScreenRegion(display, shot) {
  return new Promise((resolve) => {
    const { bounds } = display;
    const picker = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      backgroundColor: "#000000",
      title: "읽을 부분 고르기",
      webPreferences: {
        preload: path.join(__dirname, "screen-select-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    picker.setAlwaysOnTop(true, "screen-saver");
    let settled = false;
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener("screen-select:done", onDone);
      ipcMain.removeListener("screen-select:cancel", onCancel);
      if (!picker.isDestroyed()) picker.destroy();
      resolve(rect);
    };
    const onDone = (event, rect) => {
      if (event.sender === picker.webContents) finish(normalizeSelection(rect, bounds));
    };
    const onCancel = (event) => {
      if (event.sender === picker.webContents) finish(null);
    };
    // 2분 안에 고르지 않으면 닫는다.
    const timer = setTimeout(() => finish(null), 120_000);
    ipcMain.on("screen-select:done", onDone);
    ipcMain.on("screen-select:cancel", onCancel);
    picker.on("closed", () => finish(null));
    picker.webContents.once("did-finish-load", () => {
      picker.webContents.send("screen-select:image", {
        dataUrl: `data:image/jpeg;base64,${shot.toJPEG(88).toString("base64")}`
      });
      picker.show();
      picker.focus();
    });
    picker.loadFile(path.join(__dirname, "renderer", "screen-select.html"));
  });
}

async function startScreenRead() {
  if (screenReadBusy || !mainWindow || mainWindow.isDestroyed()) return;
  screenReadBusy = true;
  const wasVisible = mainWindow.isVisible();
  const expandedBefore = isExpanded;
  let opened = false;
  try {
    // 글 강화기 창이 찍히지 않게 잠시 숨기고, 마우스가 있는 화면을 찍는다.
    suppressAutoCollapse(3_000);
    if (wasVisible) mainWindow.hide();
    await wait(220);
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = captureRequestDimensions(display);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = chooseCaptureSource(sources, display.id);
    if (!source || source.thumbnail.isEmpty()) throw new Error("현재 화면을 찍지 못했어요.");
    const shot = source.thumbnail;
    const selection = await selectScreenRegion(display, shot);
    if (!selection) return;
    const crop = shot.crop(imageCropRect(selection, display.bounds, shot.getSize()));
    const attachment = makeBoundedScreenAttachment(crop, "화면에서 읽을 부분.png");
    showWritingWindow({ focus: true });
    opened = true;
    mainWindow.webContents.send("selection:reading", {});
    const result = await aiClient.readImageText({ attachment });
    if (!result.text) {
      mainWindow.webContents.send("selection:read-failed", {
        message: "글자를 찾지 못했어요. 글자가 있는 부분을 조금 더 넓게 골라 주세요."
      });
      return;
    }
    openSelection({
      text: result.text,
      source: "screen",
      language: result.language,
      languageName: result.languageName
    });
  } catch (error) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    showWritingWindow({ focus: true });
    opened = true;
    mainWindow.webContents.send("selection:read-failed", {
      message: error?.message || "화면의 글을 읽지 못했어요.",
      code: error?.code || ""
    });
  } finally {
    screenReadBusy = false;
    // 고르기를 취소했으면 창을 원래대로 되돌린다.
    if (!opened && wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      setPanelState(expandedBefore, { focus: false, remember: false });
    }
  }
}

// 맨 앞 프로그램에서 선택한 글을 복사 키로 가져오고, 원래 클립보드 내용을 되돌린다.
async function captureForegroundSelection() {
  const helper = getSelectionHelper();
  if (!helper) return { text: "", reason: "unsupported" };
  const target = await helper.request("foreground");
  if (!target?.ok) return { text: "", reason: "foreground" };
  const ownWindow = Number(target.pid) === process.pid;
  const snapshot = snapshotClipboard(clipboard);
  const copied = await helper.request("copy", [copyMode(target.process)], 8_000);
  if (!copied?.ok) return { text: "", reason: copied?.reason || "copy" };
  if (!copied.changed) return { text: "", reason: "empty" };
  let text = "";
  for (let attempt = 0; attempt < 5 && !text; attempt += 1) {
    text = cleanSelection(clipboard.readText());
    if (!text) await wait(40);
  }
  restoreClipboard(clipboard, snapshot);
  rememberClipboard();
  return { text, target: ownWindow ? null : target, reason: text ? "" : "empty" };
}

async function enhanceSelectionFromShortcut() {
  if (selectionCaptureBusy || !mainWindow || mainWindow.isDestroyed()) return;
  selectionCaptureBusy = true;
  try {
    const { text, target, reason } = await captureForegroundSelection();
    if (text) {
      openSelection({ text, target, source: "shortcut" });
      return;
    }
    // 드래그한 글이 없으면 화면에서 읽을 부분을 고르게 한다(설정에서 끌 수 있음).
    if (reason === "empty" && configStore.getPublicSettings().screenReadFallback) {
      selectionCaptureBusy = false;
      await startScreenRead();
      return;
    }
    showWritingWindow({ focus: true });
    mainWindow.webContents.send("selection:empty", {
      reason,
      shortcut: selectionShortcutStatus.activeShortcut
    });
  } catch {
    showWritingWindow({ focus: true });
    mainWindow.webContents.send("selection:empty", {
      reason: "error",
      shortcut: selectionShortcutStatus.activeShortcut
    });
  } finally {
    selectionCaptureBusy = false;
  }
}

// 창을 열 때, 그 사이 다른 프로그램에서 새로 복사한 글이 있으면 강화할지 묻는다.
function offerCopiedText() {
  if (!configStore.getPublicSettings().copyOfferEnabled || !mainWindow || mainWindow.isDestroyed()) return;
  let text = "";
  try {
    text = cleanSelection(clipboard.readText());
  } catch {
    return;
  }
  const fingerprint = clipboardFingerprint(text);
  if (!text || fingerprint === lastClipboardFingerprint) return;
  lastClipboardFingerprint = fingerprint;
  if ([...text].length < 2) return;
  mainWindow.webContents.send("selection:offer", {
    preview: text.replace(/\s+/gu, " ").slice(0, 60),
    length: text.length
  });
}

async function useCopiedText() {
  const text = cleanSelection(clipboard.readText());
  if (!text) {
    return { ok: false, error: { code: "EMPTY_CLIPBOARD", message: "복사한 글이 없어요." } };
  }
  rememberClipboard();
  let target = null;
  try {
    // 창을 열기 직전에 쓰던 프로그램(창 순서상 바로 아래 창)에 바꿔 넣을 수 있게 한다.
    const previous = await getSelectionHelper()?.request("previous", [String(process.pid)]);
    if (previous?.ok) target = previous;
  } catch {
    target = null;
  }
  return { ok: true, ...selectionPayload({ text, target, source: "clipboard" }) };
}

async function replaceSelection(request) {
  const target = selectionTargets.get(limitedText(request?.token, 80));
  const text = String(request?.text ?? "").trim();
  if (!text) return { ok: false, error: { code: "EMPTY_RESULT", message: "바꿔 넣을 글이 없어요." } };
  if (!target) {
    writeClipboardText(text);
    return {
      ok: false,
      error: { code: "TARGET_MISSING", message: "바꿔 넣을 곳을 찾지 못해 복사해 두었어요. 직접 붙여 넣어 주세요." }
    };
  }
  const snapshot = snapshotClipboard(clipboard);
  writeClipboardText(text);
  let pasted = null;
  try {
    pasted = await getSelectionHelper().request("paste", [target.hwnd, pasteMode(target.process)], 8_000);
  } catch {
    pasted = null;
  }
  if (!pasted?.ok) {
    return {
      ok: false,
      error: {
        code: "PASTE_FAILED",
        message: `${appLabel(target) || "원래 프로그램"}에 붙여 넣지 못해 복사해 두었어요. 직접 붙여 넣어 주세요.`
      }
    };
  }
  selectionTargets.clear();
  setPanelState(false, { animate: true, focus: false });
  // 붙여 넣기가 끝날 시간을 두고 원래 클립보드를 되돌린다.
  setTimeout(() => {
    try {
      if (clipboard.readText() === text) {
        restoreClipboard(clipboard, snapshot);
        rememberClipboard();
      }
    } catch {
      // 클립보드를 다른 프로그램이 쓰고 있으면 그대로 둔다.
    }
  }, 1_200);
  return { ok: true, targetLabel: appLabel(target) };
}

function editContextMenu(params) {
  const template = [];
  for (const suggestion of (params.dictionarySuggestions || []).slice(0, 4)) {
    template.push({ label: suggestion, click: () => mainWindow?.webContents.replaceMisspelling(suggestion) });
  }
  if (template.length > 0) template.push({ type: "separator" });
  const selected = cleanSelection(params.selectionText);
  if (selected) {
    template.push(
      { label: "선택한 글 강화", click: () => openSelection({ text: selected, source: "context-menu" }) },
      { type: "separator" }
    );
  }
  const flags = params.editFlags || {};
  if (params.isEditable) template.push({ label: "잘라내기", role: "cut", enabled: flags.canCut !== false });
  if (params.isEditable || selected) template.push({ label: "복사", role: "copy", enabled: flags.canCopy !== false });
  if (params.isEditable) {
    template.push(
      { label: "붙여넣기", role: "paste", enabled: flags.canPaste !== false },
      { type: "separator" },
      { label: "모두 선택", role: "selectAll" }
    );
  }
  return template;
}

function updateMenuItems() {
  if (!updateManager?.enabled) return [];
  const { status, version, progress } = updateManager.state;
  if (status === "downloading") {
    return [{ label: `업데이트 받는 중 ${progress}%`, enabled: false }, { type: "separator" }];
  }
  if (status === "installing") {
    return [{ label: "업데이트 설치 중…", enabled: false }, { type: "separator" }];
  }
  if (status === "available" || (status === "error" && version)) {
    return [
      { label: `업데이트 설치 (${version})`, click: () => updateManager.install() },
      { type: "separator" }
    ];
  }
  return [{ label: "업데이트 확인", click: () => checkForUpdatesNow() }, { type: "separator" }];
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...updateMenuItems(),
      { label: "열기 / 접기", click: togglePanel },
      { label: "화면에서 글 읽기", click: () => startScreenRead() },
      {
        label: "복사한 글 강화",
        click: async () => {
          const response = await useCopiedText();
          if (response.ok) openSelection(response);
          else tray?.displayBalloon({ title: "글 강화기", content: "먼저 강화할 글을 복사해 주세요." });
        }
      },
      {
        label: "히스토리",
        click: () => {
          setPanelState(true);
          mainWindow.webContents.send("history:open");
        }
      },
      {
        label: "설정",
        click: () => {
          setPanelState(true);
          mainWindow.webContents.send("settings:open");
        }
      },
      {
        label: "사이드 채팅 (베타)",
        click: () => showChatSurface()
      },
      { type: "separator" },
      {
        label: "종료",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("글 강화기");
  refreshTrayMenu();
  tray.on("click", togglePanel);
  tray.on("balloon-click", () => updateManager?.install());
}

function showUpdateNotification(update) {
  const title = `글 강화기 ${update.version} 업데이트가 있어요`;
  const body = "눌러서 바로 업데이트하세요. 작성 중인 글과 기록은 그대로 남아요.";
  if (Notification.isSupported()) {
    updateNotification = new Notification({ title, body });
    updateNotification.on("click", () => updateManager?.install());
    updateNotification.show();
  } else {
    tray?.displayBalloon({ title, content: body });
  }
}

async function checkForUpdatesNow() {
  const update = await updateManager?.check();
  if (!update) {
    tray?.displayBalloon({ title: "글 강화기", content: `지금 쓰는 ${app.getVersion()}이 최신 버전이에요.` });
  }
}

// 업데이트 설치 직전, 작성 중인 글을 저장하고 앱을 닫는다. 설치 스크립트가 끝나면 다시 실행한다.
async function quitForUpdate() {
  try {
    await mainWindow?.webContents.executeJavaScript("window.writingPanel?.flushDraft?.()");
  } catch {
    // 창이 이미 닫혔으면 저장할 내용도 없다.
  }
  isQuitting = true;
  app.quit();
}

function startUpdateChecks() {
  const directory = updatableInstall({ execPath: process.execPath, isPackaged: app.isPackaged });
  updateManager = new UpdateManager({
    currentVersion: app.getVersion(),
    // 같은 Electron으로 만든 앱 전용 ZIP이 있으면 전체 ZIP 대신 그것만 받는다.
    runtimeVersion: process.versions.electron,
    fetchImpl: (url, options) => globalThis.fetch(url, options),
    tempDirectory: app.getPath("temp"),
    install: directory ? { directory, execPath: process.execPath, pid: process.pid } : null,
    notify: showUpdateNotification,
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:state", state);
      refreshTrayMenu();
    },
    quit: quitForUpdate
  });
  updateManager.start();
  refreshTrayMenu();
}

function safeError(error) {
  return {
    message: error?.message || "처리 중 문제가 생겼습니다.",
    code: error?.code || "UNKNOWN"
  };
}

function captureRequestDimensions(display) {
  const scale = display?.scaleFactor || 1;
  return fitCaptureDimensions(
    Math.max(1, Math.round((display?.size?.width || 1) * scale)),
    Math.max(1, Math.round((display?.size?.height || 1) * scale))
  );
}

async function captureCurrentScreen() {
  const wasVisible = mainWindow.isVisible();
  const expandedBeforeCapture = isExpanded;
  const bounds = mainWindow.getBounds();
  const display = getDisplayForBounds(bounds);
  suppressAutoCollapse(2_000);
  mainWindow.hide();
  await wait(220);
  try {
    const { width, height } = captureRequestDimensions(display);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = chooseCaptureSource(sources, display.id);
    if (!source || source.thumbnail.isEmpty()) {
      const error = new Error("현재 화면을 촬영하지 못했습니다.");
      error.code = "CAPTURE_FAILED";
      throw error;
    }
    return makeBoundedScreenAttachment(source.thumbnail);
  } finally {
    if (wasVisible) {
      setPanelState(expandedBeforeCapture, { focus: false, remember: false });
    }
  }
}

async function captureSideChatScreen() {
  const mainWasVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const mainWasFocused = Boolean(mainWasVisible && mainWindow.isFocused());
  const expandedBeforeCapture = isExpanded;
  const display = getDisplayForBounds(mainWindow.getBounds());
  suppressAutoCollapse(2_000);
  // 촬영 화면에 글 강화기 창이 찍히지 않도록 잠시 숨긴다.
  if (mainWasVisible) mainWindow.hide();
  await wait(260);
  try {
    const { width, height } = captureRequestDimensions(display);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = chooseCaptureSource(sources, display.id);
    if (!source || source.thumbnail.isEmpty()) {
      const error = new Error("현재 화면을 촬영하지 못했습니다.");
      error.code = "CAPTURE_FAILED";
      throw error;
    }
    return makeBoundedScreenAttachment(source.thumbnail, "사이드 채팅 현재 화면.png");
  } finally {
    if (mainWasVisible) {
      setPanelState(expandedBeforeCapture, { focus: false, remember: false });
      if (mainWasFocused) focusChatSurface();
    }
  }
}

function registerIpcHandlers() {
  ipcMain.handle("panel:get-state", () => ({
    expanded: isExpanded,
    side: currentSide(),
    windowMode: configStore.getPublicSettings().windowMode,
    shortcutWarning: shortcutStatus.warning
  }));
  ipcMain.handle("panel:toggle", () => {
    togglePanel();
    return { expanded: isExpanded };
  });
  ipcMain.handle("panel:collapse", () => {
    setPanelState(false, { animate: true, focus: false });
    return { expanded: false };
  });
  ipcMain.handle("panel:drag-start", () => {
    panelResizeSession = undefined;
    panelDragSession = mainWindow.getBounds();
    mainWindow.setResizable(false);
    return { bounds: { ...panelDragSession } };
  });
  ipcMain.handle("panel:drag-move", (_event, request) => {
    const current = mainWindow.getBounds();
    const locked = panelDragSession || current;
    const requested = {
      x: Number.isFinite(Number(request?.x)) ? Number(request.x) : current.x,
      y: Number.isFinite(Number(request?.y)) ? Number(request.y) : current.y,
      width: locked.width,
      height: locked.height
    };
    const display = getDisplayForBounds(requested);
    const settings = configStore.getPublicSettings();
    const next = finalizeDraggedBounds({
      bounds: requested,
      workArea: display.workArea,
      mode: request?.final ? settings.windowMode : "free"
    });
    mainWindow.setBounds({
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height
    });
    if (request?.final) {
      configStore.savePlacement(isExpanded, next);
      panelDragSession = undefined;
      sendPanelState();
    }
    return { bounds: mainWindow.getBounds(), side: next.side };
  });
  ipcMain.handle("panel:resize-start", () => {
    panelDragSession = undefined;
    panelResizeSession = mainWindow.getBounds();
    return { bounds: { ...panelResizeSession } };
  });
  ipcMain.handle("panel:resize-move", (_event, request) => {
    const current = mainWindow.getBounds();
    if (!isExpanded) return { bounds: current };
    const width = Math.min(680, Math.max(380, Math.round(Number(request?.width) || current.width)));
    const height = Math.min(920, Math.max(560, Math.round(Number(request?.height) || current.height)));
    const settings = configStore.getPublicSettings();
    const side = currentSide();
    const next = {
      x:
        settings.windowMode === "docked" && side === "right"
          ? current.x + current.width - width
          : current.x,
      y: current.y,
      width,
      height
    };
    mainWindow.setBounds(next);
    if (request?.final) {
      configStore.save({ windowWidth: width, windowHeight: height });
      persistPlacement(true);
      panelResizeSession = undefined;
      sendPanelState();
    }
    return { bounds: mainWindow.getBounds(), side };
  });
  ipcMain.handle("side-chat:open", () => {
    showChatSurface();
    return { opened: true };
  });
  ipcMain.handle("side-chat:close", () => {
    setPanelState(false, { animate: true, focus: false });
    return { closed: true };
  });
  ipcMain.handle("side-chat:load", () => ({
    messages: sideChatStore.list(),
    writingContext: getWritingContext()
  }));
  ipcMain.handle("side-chat:get-writing-context", () => getWritingContext());
  ipcMain.handle("side-chat:sync-writing-context", (_event, context) => {
    latestWritingContext = normalizeWritingContext(context);
    broadcastWritingContext();
    return latestWritingContext;
  });
  ipcMain.handle("side-chat:focus-input", () => {
    focusChatSurface();
    setTimeout(focusChatSurface, 80);
    return { focused: true };
  });
  ipcMain.handle("side-chat:clear", async () => {
    cancelActiveSideChatRequest();
    discardPendingSideChatAction();
    const removed = sideChatStore.clear();
    focusChatSurface();
    setTimeout(focusChatSurface, 80);
    setTimeout(focusChatSurface, 220);
    return { removed, messages: [] };
  });
  ipcMain.handle("side-chat:capture-screen", async () => {
    try {
      const attachment = await captureSideChatScreen();
      return { ok: true, attachment };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });
  ipcMain.handle("side-chat:pick-image", async () => {
    const releaseAutoCollapse = blockAutoCollapse();
    try {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: "검색할 이미지 선택",
        properties: ["openFile"],
        filters: [
          { name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }
        ]
      });
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, attachment: null };
      const attachment = readAttachment(selection.filePaths[0]);
      if (attachment.kind !== "image") {
        const error = new Error("이미지 파일만 선택할 수 있습니다.");
        error.code = "INVALID_VISUAL_CONTEXT";
        throw error;
      }
      return { ok: true, attachment };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    } finally {
      releaseAutoCollapse();
    }
  });
  ipcMain.handle("side-chat:send", async (_event, request) => {
    try {
      const input = limitedText(request?.input, 6_000);
      const forceSearch = request?.forceSearch === true;
      if (!input) {
        return {
          ok: false,
          error: { code: "EMPTY_INPUT", message: "메시지를 먼저 입력해 주세요." }
        };
      }
      const screenAttachments = request?.screenAttachment
        ? normalizeAttachments([request.screenAttachment])
        : [];
      if (
        screenAttachments.some(
          (attachment) =>
            attachment.kind !== "image" ||
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              attachment.mimeType
            )
        )
      ) {
        const error = new Error("검색할 이미지가 올바르지 않습니다.");
        error.code = "INVALID_VISUAL_CONTEXT";
        throw error;
      }
      const result = await requestSideChatReply({
        input,
        messages: sideChatStore.list(),
        attachments: screenAttachments,
        forceSearch
      });
      const messages = sideChatStore.appendExchange(
        input,
        result.reply,
        result.sources,
        result.relatedQueries,
        sideChatMessageOptions(result)
      );
      return sideChatReplyResponse(messages, result);
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });
  ipcMain.handle("side-chat:cancel", () => {
    const cancelled = Boolean(activeSideChatRequest);
    cancelActiveSideChatRequest();
    return { cancelled };
  });
  ipcMain.handle("side-chat:apply-action", (_event, request) => {
    const token = limitedText(request?.token, 80);
    if (!token || pendingSideChatAction?.token !== token) {
      return {
        ok: false,
        error: {
          code: "ACTION_EXPIRED",
          message: "적용할 제안이 만료됐어요. 다시 요청해 주세요."
        }
      };
    }
    const { action } = pendingSideChatAction;
    discardPendingSideChatAction();
    const dispatched = dispatchWritingAction(action);
    return dispatched
      ? { ok: true, action: dispatched }
      : {
          ok: false,
          error: { code: "WRITING_UNAVAILABLE", message: "글 강화기 창을 찾지 못했어요." }
        };
  });
  ipcMain.handle("side-chat:dismiss-action", (_event, request) => {
    const token = limitedText(request?.token, 80);
    if (token && pendingSideChatAction?.token === token) discardPendingSideChatAction();
    return { dismissed: true };
  });
  ipcMain.handle("side-chat:edit", async (_event, request) => {
    try {
      const messageId = limitedText(request?.messageId, 80);
      const input = limitedText(request?.input, 6_000);
      if (!messageId || !input) {
        return {
          ok: false,
          messages: sideChatStore.list(),
          error: { code: "EMPTY_INPUT", message: "수정할 메시지를 입력해 주세요." }
        };
      }
      const truncated = sideChatStore.rewriteFromUser(messageId, input);
      const priorMessages = truncated.slice(0, -1);
      try {
        const result = await requestSideChatReply({ input, messages: priorMessages });
        const messages = sideChatStore.appendAssistant(
          result.reply,
          result.sources,
          result.relatedQueries,
          sideChatMessageOptions(result)
        );
        return sideChatReplyResponse(messages, result);
      } catch (error) {
        return {
          ok: false,
          messages: sideChatStore.list(),
          error: safeError(error)
        };
      }
    } catch (error) {
      return {
        ok: false,
        messages: sideChatStore.list(),
        error: safeError(error)
      };
    }
  });
  ipcMain.handle("side-chat:open-settings", () => {
    // 설정 팝업은 채팅 화면 위에도 그대로 열린다.
    mainWindow.webContents.send("settings:open");
    return { opened: true };
  });
  ipcMain.handle("external-link:open", async (_event, request) => {
    try {
      const url = new URL(limitedText(request?.url, 2_048));
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { ok: false };
      }
      await shell.openExternal(url.href);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("attachments:pick", async (_event, request) => {
    try {
      const existing = normalizeAttachments(request?.existing);
      const remaining = MAX_ATTACHMENT_COUNT - existing.length;
      if (remaining <= 0) {
        return { ok: false, error: { code: "TOO_MANY_ATTACHMENTS", message: "참고 자료는 최대 4개까지 첨부할 수 있습니다." } };
      }
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: "참고 파일이나 이미지 첨부",
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "지원되는 참고 자료",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md", "csv", "json"]
          }
        ]
      });
      if (selection.canceled) return { ok: true, attachments: [] };
      const attachments = selection.filePaths.slice(0, remaining).map(readAttachment);
      normalizeAttachments([...existing, ...attachments]);
      return { ok: true, attachments };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });

  ipcMain.handle("attachments:capture-screen", async (_event, request) => {
    try {
      const existing = normalizeAttachments(request?.existing);
      if (existing.length >= MAX_ATTACHMENT_COUNT) {
        return { ok: false, error: { code: "TOO_MANY_ATTACHMENTS", message: "참고 자료는 최대 4개까지 첨부할 수 있습니다." } };
      }
      const attachment = await captureCurrentScreen();
      normalizeAttachments([...existing, attachment]);
      return { ok: true, attachment };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });

  ipcMain.handle("writing:guess", async (_event, request) => {
    try {
      const input = limitedText(request?.input, 12_000);
      const situation = limitedText(request?.situation, 2_000);
      if (!input && !situation) {
        return { ok: false, error: { code: "EMPTY_INPUT", message: "떠오르는 내용이나 상황을 먼저 적어 주세요." } };
      }
      const result = await aiClient.guess({
        input,
        situation,
        attachments: normalizeAttachments(request?.attachments)
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });

  ipcMain.handle("writing:enhance", async (_event, request) => {
    try {
      const input = limitedText(request?.input, 12_000);
      const situation = limitedText(request?.situation, 2_000);
      if (!input) {
        return { ok: false, error: { code: "EMPTY_INPUT", message: "떠오르는 내용을 먼저 적어 주세요." } };
      }
      const attachments = normalizeAttachments(request?.attachments);
      const preflight = request?.preflight
        ? {
            question: limitedText(request.preflight.question, 1_000),
            answer: limitedText(request.preflight.answer, 2_000)
          }
        : undefined;
      const refinement = request?.refinement
        ? {
            currentText: limitedText(request.refinement.currentText, 30_000),
            followUp: limitedText(request.refinement.followUp, 1_000),
            answer: limitedText(request.refinement.answer, 2_000)
          }
        : undefined;
      const regenerateFromOriginal = request?.regenerateFromOriginal === true;
      const enhancementLevel = enhancementLevels.normalize(request?.enhancementLevel);
      const followUpMode = request?.followUpMode === "first" ? "first" : "subsequent";
      const memoryQuery = [
        situation,
        input,
        preflight?.answer,
        refinement?.answer,
        refinement?.currentText
      ]
        .filter(Boolean)
        .join(" ");
      const memoryEnabled = configStore.getPublicSettings().memoryEnabled;
      const memories = memoryEnabled ? memoryStore.search(memoryQuery, 5) : [];
      const result = await aiClient.enhance({
        input,
        situation,
        attachments,
        memories,
        preflight,
        refinement,
        regenerateFromOriginal,
        enhancementLevel,
        followUpMode
      });
      const groundingEvidence = [
        situation,
        input,
        preflight?.answer,
        refinement?.answer
      ]
        .filter(Boolean)
        .join("\n");
      const groundedCandidates = groundMemoryCandidates(
        result.memoryCandidates,
        groundingEvidence
      );
      const additionsEnabled =
        configStore.getPublicSettings().memoryAdditionsEnabled !== false;
      pendingMemoryApprovals.clear();
      let memoryApprovalToken = "";
      if (additionsEnabled && groundedCandidates.length > 0) {
        memoryApprovalToken = crypto.randomUUID();
        pendingMemoryApprovals.set(memoryApprovalToken, groundedCandidates);
      }
      return {
        ok: true,
        result: {
          completedText: result.completedText,
          followUp: result.followUp,
          provider: result.provider,
          model: result.model,
          fallbackUsed: result.fallbackUsed,
          enhancementLevel,
          memoryCandidates: memoryApprovalToken ? groundedCandidates : [],
          memoryApprovalToken,
          memoryCount: memoryStore.list().length
        }
      };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });

  ipcMain.handle("writing:apply", (_event, text) => {
    const value = String(text ?? "").trim();
    if (!value) return { ok: false };
    writeClipboardText(value);
    setTimeout(() => setPanelState(false, { animate: true, focus: false }), 180);
    return { ok: true };
  });

  ipcMain.handle("clipboard:write", (_event, request) => {
    const value = String(request?.text ?? "");
    if (!value.trim()) return { ok: false };
    writeClipboardText(value);
    return { ok: true };
  });

  ipcMain.handle("history:list", () => historyStore.list());
  ipcMain.handle("history:get", (_event, id) => historyStore.get(String(id || "")));
  ipcMain.handle("history:save", (_event, record) => {
    try {
      return { ok: true, record: historyStore.upsert(record) };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });
  ipcMain.handle("history:remove", (_event, id) => ({
    removed: historyStore.remove(String(id || ""))
  }));

  ipcMain.handle("draft:load", () => draftStore.load());
  ipcMain.handle("draft:save", (_event, draft) => draftStore.save(draft));
  ipcMain.handle("draft:clear", () => ({ cleared: draftStore.clear() }));

  ipcMain.handle("update:state", () => ({
    enabled: Boolean(updateManager?.enabled),
    ...(updateManager?.state ?? { status: "idle" })
  }));
  ipcMain.handle("update:install", () => updateManager?.install() ?? false);
  ipcMain.handle("settings:get", () => ({
    ...configStore.getPublicSettings(),
    memoryCount: memoryStore.list().length,
    ...shortcutSettings()
  }));
  ipcMain.handle("selection:get-situations", () => configStore.getSituationPresets());
  ipcMain.handle("selection:save-situations", (_event, request) =>
    configStore.saveSituationPresets(request?.reset === true ? null : request?.situations)
  );
  ipcMain.handle("selection:use-copied", () => useCopiedText());
  ipcMain.handle("selection:read-screen", () => {
    startScreenRead();
    return { started: true };
  });
  ipcMain.handle("writing:translate", async (_event, request) => {
    try {
      const result = await aiClient.translate({
        input: limitedText(request?.input, 12_000),
        targetLanguage: limitedText(request?.targetLanguage, 8),
        situation: limitedText(request?.situation, 2_000)
      });
      return { ok: true, result: { translatedText: result.translatedText, provider: result.provider } };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });
  ipcMain.handle("selection:replace", (_event, request) => replaceSelection(request));
  ipcMain.handle("selection:copy", (_event, request) => {
    const value = String(request?.text ?? "").trim();
    if (!value) return { ok: false };
    writeClipboardText(value);
    return { ok: true };
  });
  ipcMain.handle("settings:save", (_event, settings) => {
    const previousShortcut = configStore.getShortcut();
    const previousSelectionShortcut = configStore.getSelectionShortcut();
    const canRegister = !QA_CAPTURE && !SMOKE_TEST;
    try {
      const nextShortcut = String(settings?.shortcut || previousShortcut).trim();
      const nextSelectionShortcut = String(
        settings?.selectionShortcut || previousSelectionShortcut
      ).trim();
      const shouldRegisterShortcut =
        settings?.updateShortcut === true || nextShortcut !== previousShortcut;
      const shouldRegisterSelection =
        settings?.updateShortcut === true || nextSelectionShortcut !== previousSelectionShortcut;
      if (shouldRegisterShortcut && canRegister) {
        registerShortcut(nextShortcut, "panel");
        shortcutStatus = { registered: true, activeShortcut: nextShortcut, warning: "" };
      }
      if (shouldRegisterSelection && canRegister) {
        try {
          registerShortcut(nextSelectionShortcut, "selection");
        } catch (error) {
          // 창 열기 단축키만 바뀐 상태로 남지 않게 되돌린다.
          if (shouldRegisterShortcut && nextShortcut !== previousShortcut) {
            registerShortcut(previousShortcut, "panel");
            shortcutStatus = { registered: true, activeShortcut: previousShortcut, warning: "" };
          }
          throw error;
        }
        selectionShortcutStatus = {
          registered: true,
          activeShortcut: nextSelectionShortcut,
          warning: ""
        };
      }
      const saved = configStore.save({
        ...settings,
        shortcut: nextShortcut,
        selectionShortcut: nextSelectionShortcut
      });
      applyAppearance();
      setPanelState(isExpanded, { focus: false, remember: false });
      return {
        ok: true,
        settings: {
          ...saved,
          memoryCount: memoryStore.list().length,
          ...shortcutSettings()
        }
      };
    } catch (error) {
      if (canRegister && registeredShortcuts.panel !== previousShortcut) {
        try {
          registerShortcut(previousShortcut, "panel");
          shortcutStatus = { registered: true, activeShortcut: previousShortcut, warning: "" };
        } catch {
          shortcutStatus = {
            registered: false,
            activeShortcut: "",
            warning:
              "전역 단축키를 등록하지 못했어요. 화면 손잡이나 트레이 아이콘으로 열 수 있어요."
          };
        }
      }
      return { ok: false, error: safeError(error) };
    }
  });

  ipcMain.handle("memory:list", () => memoryStore.list());
  ipcMain.handle("memory:approve-candidates", (_event, token) => {
    const key = limitedText(token, 100);
    const candidates = pendingMemoryApprovals.get(key) || [];
    pendingMemoryApprovals.delete(key);
    if (
      candidates.length === 0 ||
      configStore.getPublicSettings().memoryAdditionsEnabled === false
    ) {
      return { ok: true, memoryIds: [], memoryCount: memoryStore.list().length };
    }
    const memoryIds = memoryStore.addCandidates(candidates);
    return { ok: true, memoryIds, memoryCount: memoryStore.list().length };
  });
  ipcMain.handle("memory:reject-candidates", (_event, token) => ({
    rejected: pendingMemoryApprovals.delete(limitedText(token, 100))
  }));
  ipcMain.handle("memory:update", (_event, id, changes) => {
    try {
      return { ok: true, memory: memoryStore.update(String(id || ""), changes) };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  });
  ipcMain.handle("memory:remove", (_event, ids) => ({
    removed: memoryStore.remove(ids),
    memoryCount: memoryStore.list().length
  }));
  ipcMain.handle("memory:clear", () => ({
    removed: memoryStore.clear(),
    memoryCount: 0
  }));
}

async function initialize() {
  // Windows 알림에 앱 이름을 붙이고 알림을 눌렀을 때 이 앱으로 돌아오게 한다.
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  const userData = app.getPath("userData");
  configStore = new ConfigStore(path.join(userData, "settings.json"), safeStorage);
  memoryStore = new MemoryStore(path.join(userData, "memories.json"));
  historyStore = new HistoryStore(path.join(userData, "history.json"));
  draftStore = new DraftStore(path.join(userData, "draft.json"));
  sideChatStore = new SideChatStore(path.join(userData, "side-chat.json"));
  aiClient = new AIClient({ getApiKey: (provider) => configStore.getApiKey(provider) });
  registerIpcHandlers();
  createWindow();
  screen.on("display-added", repositionForDisplayChange);
  screen.on("display-removed", repositionForDisplayChange);
  screen.on("display-metrics-changed", repositionForDisplayChange);

  if (QA_CAPTURE) {
    mainWindow.webContents.once("did-finish-load", captureQaScreens);
  } else if (SMOKE_TEST) {
    mainWindow.once("ready-to-show", async () => {
      try {
        setPanelState(true, { focus: false, remember: false });
        const captured = await captureCurrentScreen();
        const state = await mainWindow.webContents.executeJavaScript(
          "({ title: document.title, ready: Boolean(window.writingEnhancer), input: Boolean(document.querySelector('#sourceInput')) })"
        );
        const expandedDrag = await mainWindow.webContents.executeJavaScript(`(async () => {
          const start = await window.writingEnhancer.beginPanelDrag();
          const moved = await window.writingEnhancer.movePanel({
            x: start.bounds.x + 18,
            y: start.bounds.y + 12,
            final: true
          });
          return { start: start.bounds, end: moved.bounds };
        })()`);
        setPanelState(false, { focus: false, remember: false });
        const collapsedDrag = await mainWindow.webContents.executeJavaScript(`(async () => {
          const start = await window.writingEnhancer.beginPanelDrag();
          const moved = await window.writingEnhancer.movePanel({
            x: start.bounds.x - 16,
            y: start.bounds.y + 10,
            final: true
          });
          return { start: start.bounds, end: moved.bounds };
        })()`);
        setPanelState(true, { focus: false, remember: false });
        const chatState = await mainWindow.webContents.executeJavaScript(
          "(() => { const surface = window.writingPanel.showSurface('chat'); return { surface, ready: Boolean(window.writingEnhancer && window.sideChatSurface), input: Boolean(document.querySelector('#chatInput')), visible: !document.querySelector('#chatSurface').classList.contains('is-hidden') }; })()"
        );
        await mainWindow.webContents.executeJavaScript(`(() => {
          const input = document.querySelector("#sourceInput");
          input.value = "사이드 채팅 연동 확인용 원문";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
        await wait(220);
        const contextLinked = await mainWindow.webContents.executeJavaScript(
          'document.querySelector("#writingContextText").textContent.includes("현재 작성 중인 원문 연동")'
        );
        dispatchWritingAction({ name: "set_enhancement_level", value: "5" });
        await wait(100);
        const actionLinked = await mainWindow.webContents.executeJavaScript(
          'document.querySelector("#enhancementLevelInput").value === "5"'
        );
        const chatResetProbe = await mainWindow.webContents.executeJavaScript(
          "window.writingPanel.showSurface('chat'); window.__sideChatQa.resetAndProbe()"
        );
        mainWindow.webContents.insertText("초기화 직후 입력 가능");
        await wait(80);
        const chatResetReady = await mainWindow.webContents.executeJavaScript(`({
          confirmShown: ${Boolean(chatResetProbe?.confirmShown)},
          value: document.querySelector("#chatInput").value,
          disabled: document.querySelector("#chatInput").disabled,
          readOnly: document.querySelector("#chatInput").readOnly,
          focused: document.activeElement === document.querySelector("#chatInput")
        })`);
        await mainWindow.webContents.executeJavaScript("window.writingPanel.showSurface('writing')");
        const dragSizeStable =
          expandedDrag.start.width === expandedDrag.end.width &&
          expandedDrag.start.height === expandedDrag.end.height &&
          collapsedDrag.start.width === collapsedDrag.end.width &&
          collapsedDrag.start.height === collapsedDrag.end.height;
        const captureReady =
          captured?.source === "screen" &&
          captured?.mimeType === "image/png" &&
          captured?.size > 0 &&
          mainWindow.isVisible() &&
          isExpanded;
        if (
          state.title !== "글 강화기" ||
          !state.ready ||
          !state.input ||
          chatState.surface !== "chat" ||
          !chatState.visible ||
          !chatState.ready ||
          !chatState.input ||
          !chatResetReady.confirmShown ||
          !chatResetReady.focused ||
          chatResetReady.disabled ||
          chatResetReady.readOnly ||
          chatResetReady.value !== "초기화 직후 입력 가능" ||
          !contextLinked ||
          !actionLinked ||
          !dragSizeStable ||
          !captureReady
        ) {
          process.exitCode = 2;
        }
      } catch {
        process.exitCode = 3;
      } finally {
        isQuitting = true;
        app.quit();
      }
    });
  } else {
    createTray();
    registerInitialShortcut(configStore.getShortcut());
    registerInitialSelectionShortcut(configStore.getSelectionShortcut());
    // 앱을 켜기 전부터 클립보드에 있던 글은 "방금 복사한 글"로 묻지 않는다.
    rememberClipboard();
    // 도우미는 처음 띄울 때 몇 초 걸리므로, 단축키를 처음 누르기 전에 미리 띄워 둔다.
    setTimeout(() => getSelectionHelper()?.start().catch(() => {}), 8_000);
    startUpdateChecks();
    createInstallShortcuts();
  }
}

// 설치하거나 업데이트한 뒤 처음 켤 때 바탕화면·시작 메뉴 바로 가기를 만든다.
function createInstallShortcuts() {
  if (process.platform !== "win32") return;
  if (!updatableInstall({ execPath: process.execPath, isPackaged: app.isPackaged })) return;
  try {
    ensureInstallShortcuts({
      execPath: process.execPath,
      version: app.getVersion(),
      desktopDirectory: app.getPath("desktop"),
      startMenuDirectory: path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs"),
      statePath: path.join(app.getPath("userData"), "install-shortcuts.json"),
      shell,
      temporaryDirectory: app.getPath("temp")
    });
  } catch {
    // 바로 가기를 만들지 못해도 앱은 그대로 쓴다.
  }
}

if (gotSingleInstanceLock) {
  app.whenReady().then(initialize);
  app.on("second-instance", () => setPanelState(true));
  app.on("activate", () => {
    if (!mainWindow) createWindow();
    setPanelState(true);
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    selectionHelper?.dispose();
  });
}
