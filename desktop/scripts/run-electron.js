"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const executable =
  process.platform === "win32"
    ? path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe")
    : path.join(__dirname, "..", "node_modules", "electron", "dist", "electron");

const child = spawn(executable, process.argv.slice(2), {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  windowsHide: false
});

child.on("error", (error) => {
  console.error(`Electron을 실행할 수 없습니다: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Electron이 ${signal} 신호로 종료되었습니다.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});
