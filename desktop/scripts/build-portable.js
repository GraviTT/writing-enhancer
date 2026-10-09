"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectDirectory = path.join(__dirname, "..");
const packageJson = require(path.join(projectDirectory, "package.json"));
const unpackedDirectory = path.join(projectDirectory, "dist", "win-unpacked");
const archivePath = path.join(
  projectDirectory,
  "dist",
  `Writing-Enhancer-${packageJson.version}-builder-unsigned.zip`
);
const builder = path.join(
  projectDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);
const sevenZip = path.join(
  projectDirectory,
  "node_modules",
  "7zip-bin",
  "win",
  "x64",
  "7za.exe"
);

const packed = spawnSync(builder, ["--win", "dir"], {
  cwd: projectDirectory,
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (packed.status !== 0) {
  process.exit(packed.status ?? 1);
}

if (fs.existsSync(archivePath)) {
  fs.rmSync(archivePath);
}

const archived = spawnSync(sevenZip, ["a", "-tzip", "-mx=1", archivePath, "*"], {
  cwd: unpackedDirectory,
  stdio: "inherit"
});
if (archived.status !== 0) {
  process.exit(archived.status ?? 1);
}

console.log(`휴대용 패키지 생성 완료: ${archivePath}`);
