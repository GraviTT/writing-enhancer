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
const { groundMemoryCandidates } = require("./lib/memory-grounding");
const { MemoryStore } = require("./lib/memory-store");
const { SideChatStore } = require("./lib/side-chat-store");
const chatAnswer = require("./renderer/chat-answer");
const enhancementLevels = require("./renderer/enhancement-levels");
const {
  DEFAULT_SHORTCUT,
  registerWithFallback
} = require("./lib/shortcut-registration");
const { finalizeDraggedBounds, resolvePanelBounds } = require("./lib/window-layout");

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
let isExpanded = false;
let isQuitting = false;
let autoCollapseSuppressedUntil = 0;
let autoCollapseBlockCount = 0;
let shortcutStatus = {
  registered: false,
  activeShortcut: "",
  warning: ""
};
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
    return;
  }
  setPanelState(!isExpanded, { animate: true });
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
  mainWindow.on("blur", () => {
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
  await mainWindow.webContents.executeJavaScript('window.writingPanel?.showSurface("writing")');
  setPanelState(true, { focus: false, remember: false });
  await setQa("opacity-min");  setPanelState(true, { focus: false, remember: false });
  await setQa("opacity-min");
  await capture("v3-10-opacity-min-readability.png");

  isQuitting = true;
  app.quit();
}

function registerShortcut(shortcut) {
  globalShortcut.unregisterAll();
  if (!globalShortcut.register(shortcut, togglePanel)) {
    throw new Error(`단축키 ${shortcut}을 등록할 수 없습니다. 다른 조합을 입력해 주세요.`);
  }
}

function registerInitialShortcut(preferred) {
  shortcutStatus = registerWithFallback({
    preferred,
    fallback: DEFAULT_SHORTCUT,
    register: registerShortcut
  });
  if (!shortcutStatus.registered) globalShortcut.unregisterAll();
  return shortcutStatus;
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("글 강화기");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "열기 / 접기", click: togglePanel },
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
  tray.on("click", togglePanel);
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
    clipboard.writeText(value);
    setTimeout(() => setPanelState(false, { animate: true, focus: false }), 180);
    return { ok: true };
  });

  ipcMain.handle("clipboard:write", (_event, request) => {
    const value = String(request?.text ?? "");
    if (!value.trim()) return { ok: false };
    clipboard.writeText(value);
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

  ipcMain.handle("settings:get", () => ({
    ...configStore.getPublicSettings(),
    memoryCount: memoryStore.list().length,
    shortcutRegistered: shortcutStatus.registered,
    activeShortcut: shortcutStatus.activeShortcut,
    shortcutWarning: shortcutStatus.warning
  }));
  ipcMain.handle("settings:save", (_event, settings) => {
    const previousShortcut = configStore.getShortcut();
    try {
      const nextShortcut = String(settings?.shortcut || previousShortcut).trim();
      const shouldRegisterShortcut =
        settings?.updateShortcut === true || nextShortcut !== previousShortcut;
      if (shouldRegisterShortcut && !QA_CAPTURE && !SMOKE_TEST) {
        registerShortcut(nextShortcut);
        shortcutStatus = {
          registered: true,
          activeShortcut: nextShortcut,
          warning: ""
        };
      }
      const saved = configStore.save({ ...settings, shortcut: nextShortcut });
      applyAppearance();
      setPanelState(isExpanded, { focus: false, remember: false });
      return {
        ok: true,
        settings: {
          ...saved,
          memoryCount: memoryStore.list().length,
          shortcutRegistered: shortcutStatus.registered,
          activeShortcut: shortcutStatus.activeShortcut,
          shortcutWarning: shortcutStatus.warning
        }
      };
    } catch (error) {
      if (!QA_CAPTURE && !SMOKE_TEST) {
        try {
          registerShortcut(previousShortcut);
          shortcutStatus = {
            registered: true,
            activeShortcut: previousShortcut,
            warning: ""
          };
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
  }
}

if (gotSingleInstanceLock) {
  app.whenReady().then(initialize);
  app.on("second-instance", () => setPanelState(true));
  app.on("activate", () => {
    if (!mainWindow) createWindow();
    setPanelState(true);
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
