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
  // 스모크 실행은 임시 폴더에 userData(writing-enhancer-smoke-v2-<pid>)를 만든다. 끝나면 지운다.
  if (args.includes("--smoke-test") && result.pid) {
    removeSmokeUserData(path.join(os.tmpdir(), `writing-enhancer-smoke-v2-${result.pid}`));
  }
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

function removeSmokeUserData(directory) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}writing-enhancer-smoke-v2`)) return;
  try {
    removeDirectoryWithRetry(resolved);
  } catch {
    // 백신이 아직 파일을 잡고 있으면 다음 스모크 시작 때 지운다.
  }
}

// 이전 스모크 실행이 남긴 압축 해제 폴더와 userData 폴더(1분 넘게 지난 것)를 지운다.
function cleanupStaleExtractionDirectories() {
  const tempDirectory = path.resolve(os.tmpdir());
  const prefixes = ["writing-enhancer-archive-smoke-", "writing-enhancer-smoke-v2"];
  const cutoff = Date.now() - 60_000;
  for (const entry of fs.readdirSync(tempDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
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

// 업데이트용 앱 전용 ZIP은 resources/app만 담아 작아야 한다.
const appArchiveName = fs
  .readdirSync(path.join(projectDirectory, "dist"))
  .find((name) => name.startsWith(`Writing-Enhancer-${packageJson.version}-app-electron-`) && name.endsWith(".zip"));
checks.appArchiveName = appArchiveName || null;
checks.appArchiveBytes = appArchiveName
  ? fs.statSync(path.join(projectDirectory, "dist", appArchiveName)).size
  : 0;
checks.appArchiveIntegrity = appArchiveName
  ? run(sevenZip, ["t", path.join(projectDirectory, "dist", appArchiveName)], projectDirectory)
  : null;

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
  checks.appArchiveBytes > 10_000 &&
  checks.appArchiveBytes < 5_000_000 &&
  checks.appArchiveIntegrity?.exitCode === 0 &&
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
