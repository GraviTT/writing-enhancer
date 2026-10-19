"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { appAssetName, windowsAssetName } = require("../src/lib/updater");

const projectDirectory = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectDirectory, "package.json"));
const electronDirectory = path.join(projectDirectory, "node_modules", "electron", "dist");
const electronVersion = require(path.join(projectDirectory, "node_modules", "electron", "package.json")).version;
const outputDirectory = path.join(projectDirectory, "dist", "policy-portable");
const resourcesDirectory = path.join(outputDirectory, "resources");
const appDirectory = path.join(resourcesDirectory, "app");
const sourceExecutable = path.join(electronDirectory, "electron.exe");
const outputExecutable = path.join(outputDirectory, `${packageJson.build.productName}.exe`);
const archivePath = path.join(projectDirectory, "dist", windowsAssetName(packageJson.version));
// 업데이트용 앱 전용 ZIP: Electron은 빼고 resources/app만 담는다. 같은 Electron을 쓰는 앱은
// 전체 ZIP(약 120MB) 대신 이것(수백 KB)만 받아 resources/app을 바꾼다.
const appArchivePath = path.join(
  projectDirectory,
  "dist",
  appAssetName(packageJson.version, electronVersion)
);
const sevenZip = path.join(
  projectDirectory,
  "node_modules",
  "7zip-bin",
  "win",
  "x64",
  "7za.exe"
);

if (!outputDirectory.startsWith(`${path.join(projectDirectory, "dist")}${path.sep}`)) {
  throw new Error("정책 호환 패키지 출력 경로가 프로젝트 dist 밖입니다.");
}
if (fs.existsSync(outputDirectory)) fs.rmSync(outputDirectory, { recursive: true });
fs.cpSync(electronDirectory, outputDirectory, { recursive: true });

// Keep the original Electron executable bytes unchanged; renaming does not alter its
// hash. Electron then treats resources/app as the packaged application.
fs.renameSync(path.join(outputDirectory, "electron.exe"), outputExecutable);
fs.mkdirSync(appDirectory, { recursive: true });
fs.cpSync(path.join(projectDirectory, "src"), path.join(appDirectory, "src"), {
  recursive: true
});
fs.writeFileSync(
  path.join(appDirectory, "package.json"),
  JSON.stringify(
    {
      name: packageJson.name,
      version: packageJson.version,
      productName: packageJson.build.productName,
      main: "src/main.js",
      private: true
    },
    null,
    2
  ),
  "utf8"
);

if (fs.existsSync(archivePath)) fs.rmSync(archivePath);
const archived = spawnSync(sevenZip, ["a", "-tzip", "-mx=1", archivePath, "*"], {
  cwd: outputDirectory,
  stdio: "inherit"
});
if (archived.status !== 0) process.exit(archived.status ?? 1);

// 예전 버전의 앱 전용 ZIP은 지워 dist에 하나만 남긴다.
for (const name of fs.readdirSync(path.join(projectDirectory, "dist"))) {
  if (/^Writing-Enhancer-.+-app-electron-.+\.zip$/u.test(name)) {
    fs.rmSync(path.join(projectDirectory, "dist", name));
  }
}
const appArchived = spawnSync(
  sevenZip,
  ["a", "-tzip", "-mx=9", appArchivePath, path.join("resources", "app")],
  { cwd: outputDirectory, stdio: "inherit" }
);
if (appArchived.status !== 0) process.exit(appArchived.status ?? 1);

const sourceHash = require("node:crypto")
  .createHash("sha256")
  .update(fs.readFileSync(sourceExecutable))
  .digest("hex");
const outputHash = require("node:crypto")
  .createHash("sha256")
  .update(fs.readFileSync(outputExecutable))
  .digest("hex");
if (sourceHash !== outputHash) {
  throw new Error("원본 Electron 실행 파일의 바이트가 변경되었습니다.");
}

console.log(`정책 호환 휴대용 패키지 생성 완료: ${archivePath}`);
console.log(`업데이트용 앱 전용 ZIP: ${appArchivePath} (${fs.statSync(appArchivePath).size} bytes)`);
console.log(`실행 파일 SHA-256 보존: ${outputHash}`);
