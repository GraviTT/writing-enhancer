"use strict";

// 화면 고르기 창에는 찍어 둔 화면을 받고, 고른 영역이나 취소만 알리는 통로만 연다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenSelect", {
  onImage: (callback) => ipcRenderer.on("screen-select:image", (_event, payload) => callback(payload)),
  done: (rect) => ipcRenderer.send("screen-select:done", rect),
  cancel: () => ipcRenderer.send("screen-select:cancel")
});
