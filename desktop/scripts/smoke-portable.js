"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectDirectory = path.join(__dirname, "..");
const packageJson = require(path.join(projectDirectory, "package.json"));
const unpackedDirectory = path.join(projectDirectory, "dist", "policy-portable");
const executablePath = path.join(unpackedDirectory, `${packageJson.build.productName}.exe`);
const packagedAppPath = path.join(unpackedDirectory, "resources", "app");
const archivePath = path.join(
  projectDirectory,
  "dist",
  `Writing-Enhancer-${packageJson.version}-portable.zip`
);
const reportPath = path.join(projectDirectory, "dist", "smoke-report.json");
const developmentElectron = path.join(
  projectDirectory,
  "node_modules",
  "electron",
  "dist",
  "electron.exe"
);
const sevenZip = path.join(
  projectDirectory,
  "node_modules",
  "7zip-bin",
  "win",
  "x64",
  "7za.exe"
);

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
  return {
    exitCode: result.status,
    timedOut: Boolean(result.error?.code === "ETIMEDOUT"),
    errorCode: result.error?.code || null,
    error: result.error?.message || null
  };
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeDirectoryWithRetry(directory) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(error?.code)) throw error;
      wait(500);
    }
  }
  throw lastError;
}

function cleanupStaleExtractionDirectories() {
  const tempDirectory = path.resolve(os.tmpdir());
  const prefix = "writing-enhancer-archive-smoke-";
  const cutoff = Date.now() - 60_000;
  for (const entry of fs.readdirSync(tempDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = path.resolve(tempDirectory, entry.name);
    if (!candidate.startsWith(`${tempDirectory}${path.sep}`)) continue;
    if (fs.statSync(candidate).mtimeMs > cutoff) continue;
    try {
      removeDirectoryWithRetry(candidate);
    } catch {
      // A different smoke run or Windows scanner may still own the directory.
    }
  }
}

const checks = {
  executableExists: fs.existsSync(executablePath),
  packagedAppExists: fs.existsSync(path.join(packagedAppPath, "src", "main.js")),
  archiveExists: fs.existsSync(archivePath),
  archiveBytes: fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0
};

checks.archiveIntegrity =
  checks.archiveExists && checks.archiveBytes > 1_000_000
    ? run(sevenZip, ["t", archivePath], projectDirectory)
    : null;

cleanupStaleExtractionDirectories();
const extractionDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "writing-enhancer-archive-smoke-")
);
try {
  checks.archiveExtraction = checks.archiveExists
    ? run(
        sevenZip,
        ["x", archivePath, `-o${extractionDirectory}`, "-y"],
        projectDirectory
      )
    : null;
  const extractedExecutable = path.join(
    extractionDirectory,
    `${packageJson.build.productName}.exe`
  );
  checks.archiveExtractedLauncher =
    checks.archiveExtraction?.exitCode === 0 && fs.existsSync(extractedExecutable)
      ? run(extractedExecutable, ["--smoke-test"], extractionDirectory)
      : null;
} finally {
  const resolvedExtraction = path.resolve(extractionDirectory);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (resolvedExtraction.startsWith(`${resolvedTemp}${path.sep}`)) {
    try {
      removeDirectoryWithRetry(resolvedExtraction);
    } catch (error) {
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(error?.code)) throw error;
      // Electron/백신이 방금 실행한 파일 핸들을 잠시 유지할 수 있다. 실행 검증과
      // 임시 폴더 정리는 별개이므로 다음 smoke 시작의 stale cleanup에 맡긴다.
      checks.archiveCleanupDeferred = true;
      checks.archiveCleanupErrorCode = error.code;
    }
  }
}

checks.directLauncher = checks.executableExists
  ? run(executablePath, ["--smoke-test"], unpackedDirectory)
  : null;

if (checks.directLauncher?.exitCode === 0) {
  checks.runtimeVerification = "portable-launcher";
  checks.packagedRuntime = checks.directLauncher;
} else if (checks.packagedAppExists && fs.existsSync(developmentElectron)) {
  // Some managed Windows installations block every locally rebuilt/unsigned PE before
  // process start. Run the exact packaged resources/app with the installed Electron runtime
  // so application boot and renderer readiness are still verified without bypassing policy.
  checks.runtimeVerification = "packaged-app-with-installed-electron";
  checks.packagedRuntime = run(
    developmentElectron,
    [packagedAppPath, "--smoke-test"],
    unpackedDirectory
  );
} else {
  checks.runtimeVerification = "unavailable";
  checks.packagedRuntime = null;
}

checks.directLauncherPolicyBlocked =
  checks.directLauncher?.exitCode === null && checks.directLauncher?.errorCode === "UNKNOWN";
checks.ok =
  checks.executableExists &&
  checks.packagedAppExists &&
  checks.archiveExists &&
  checks.archiveBytes > 1_000_000 &&
  checks.archiveIntegrity?.exitCode === 0 &&
  checks.archiveExtraction?.exitCode === 0 &&
  checks.archiveExtractedLauncher?.exitCode === 0 &&
  !checks.archiveExtractedLauncher?.timedOut &&
  checks.packagedRuntime?.exitCode === 0 &&
  !checks.packagedRuntime?.timedOut;
checks.checkedAt = new Date().toISOString();

fs.writeFileSync(reportPath, JSON.stringify(checks, null, 2), "utf8");
console.log(JSON.stringify(checks, null, 2));
if (!checks.ok) process.exitCode = 1;
