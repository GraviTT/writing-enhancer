"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectDirectory = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectDirectory, "package.json"));
const electronDirectory = path.join(projectDirectory, "node_modules", "electron", "dist");
const outputDirectory = path.join(projectDirectory, "dist", "policy-portable");
const resourcesDirectory = path.join(outputDirectory, "resources");
const appDirectory = path.join(resourcesDirectory, "app");
const sourceExecutable = path.join(electronDirectory, "electron.exe");
const outputExecutable = path.join(outputDirectory, `${packageJson.build.productName}.exe`);
const archivePath = path.join(
  projectDirectory,
  "dist",
  `Writing-Enhancer-${packageJson.version}-portable.zip`
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
console.log(`실행 파일 SHA-256 보존: ${outputHash}`);
