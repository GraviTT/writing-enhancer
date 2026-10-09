"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("writingEnhancer", {
  getPanelState: () => ipcRenderer.invoke("panel:get-state"),
  togglePanel: () => ipcRenderer.invoke("panel:toggle"),
  collapsePanel: () => ipcRenderer.invoke("panel:collapse"),
  beginPanelDrag: () => ipcRenderer.invoke("panel:drag-start"),
  movePanel: (payload) => ipcRenderer.invoke("panel:drag-move", payload),
  beginPanelResize: () => ipcRenderer.invoke("panel:resize-start"),
  resizePanel: (payload) => ipcRenderer.invoke("panel:resize-move", payload),
  openSideChat: () => ipcRenderer.invoke("side-chat:open"),
  closeSideChat: () => ipcRenderer.invoke("side-chat:close"),
  minimizeSideChat: () => ipcRenderer.invoke("side-chat:minimize"),
  openWritingFromSideChat: () => ipcRenderer.invoke("side-chat:open-writing"),
  beginSideChatDrag: () => ipcRenderer.invoke("side-chat:drag-start"),
  moveSideChat: (payload) => ipcRenderer.invoke("side-chat:drag-move", payload),
  beginSideChatResize: () => ipcRenderer.invoke("side-chat:resize-start"),
  resizeSideChat: (payload) => ipcRenderer.invoke("side-chat:resize-move", payload),
  loadSideChat: () => ipcRenderer.invoke("side-chat:load"),
  sendSideChat: (input, screenAttachment = null, forceSearch = false) =>
    ipcRenderer.invoke("side-chat:send", {
      input,
      screenAttachment,
      forceSearch: forceSearch === true
    }),
  captureSideChatScreen: () => ipcRenderer.invoke("side-chat:capture-screen"),
  pickSideChatImage: () => ipcRenderer.invoke("side-chat:pick-image"),
  editSideChat: (messageId, input) =>
    ipcRenderer.invoke("side-chat:edit", { messageId, input }),
  cancelSideChat: () => ipcRenderer.invoke("side-chat:cancel"),
  applySideChatAction: (token) => ipcRenderer.invoke("side-chat:apply-action", { token }),
  dismissSideChatAction: (token) =>
    ipcRenderer.invoke("side-chat:dismiss-action", { token }),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", { text }),
  openExternalLink: (url) => ipcRenderer.invoke("external-link:open", { url }),
  clearSideChat: () => ipcRenderer.invoke("side-chat:clear"),
  focusSideChatInput: () => ipcRenderer.invoke("side-chat:focus-input"),
  getSideChatWritingContext: () => ipcRenderer.invoke("side-chat:get-writing-context"),
  syncSideChatWritingContext: (context) =>
    ipcRenderer.invoke("side-chat:sync-writing-context", context),
  openMainSettings: () => ipcRenderer.invoke("side-chat:open-settings"),
  pickAttachments: (existing) => ipcRenderer.invoke("attachments:pick", { existing }),
  captureScreen: (existing) =>
    ipcRenderer.invoke("attachments:capture-screen", { existing }),
  guess: (payload) => ipcRenderer.invoke("writing:guess", payload),
  enhance: (payload) => ipcRenderer.invoke("writing:enhance", payload),
  apply: (text) => ipcRenderer.invoke("writing:apply", text),
  listHistory: () => ipcRenderer.invoke("history:list"),
  getHistory: (id) => ipcRenderer.invoke("history:get", id),
  saveHistory: (record) => ipcRenderer.invoke("history:save", record),
  removeHistory: (id) => ipcRenderer.invoke("history:remove", id),
  loadDraft: () => ipcRenderer.invoke("draft:load"),
  saveDraft: (draft) => ipcRenderer.invoke("draft:save", draft),
  clearDraft: () => ipcRenderer.invoke("draft:clear"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  listMemories: () => ipcRenderer.invoke("memory:list"),
  approveMemoryCandidates: (token) =>
    ipcRenderer.invoke("memory:approve-candidates", token),
  rejectMemoryCandidates: (token) =>
    ipcRenderer.invoke("memory:reject-candidates", token),
  updateMemory: (id, changes) => ipcRenderer.invoke("memory:update", id, changes),
  removeMemories: (ids) => ipcRenderer.invoke("memory:remove", ids),
  clearMemories: () => ipcRenderer.invoke("memory:clear"),
  onPanelState: (callback) => subscribe("panel:state", callback),
  onFocusInput: (callback) => subscribe("panel:focus-input", callback),
  onOpenSettings: (callback) => subscribe("settings:open", callback),
  onOpenHistory: (callback) => subscribe("history:open", callback),
  onSideChatFocus: (callback) => subscribe("side-chat:focus-input", callback),
  onSideChatDiscardScreenContext: (callback) =>
    subscribe("side-chat:discard-screen-context", callback),
  onSideChatWritingContext: (callback) =>
    subscribe("side-chat:writing-context-updated", callback),
  onSideChatProgress: (callback) => subscribe("side-chat:progress", callback),
  onSideChatWritingAction: (callback) =>
    subscribe("side-chat:writing-action", callback)
});
