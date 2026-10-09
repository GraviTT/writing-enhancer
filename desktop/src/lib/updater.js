"use strict";

// GitHub 릴리스에서 새 버전을 확인하고, 휴대용 ZIP을 받아 SHA-256을 맞춰 본 뒤
// 앱을 닫고 같은 폴더의 파일을 바꿔 다시 실행한다. 기록·설정은 앱 폴더 밖(userData)에 있어 그대로 남는다.
// Android(AppUpdatePolicy.kt)와 같은 릴리스·파일 이름 규칙을 쓴다.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPOSITORY = "GraviTT/writing-enhancer";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const CHECKSUM_ASSET = "SHA256SUMS.txt";
const PACKAGE_NAME = "writing-enhancer-desktop";
const MAX_ZIP_BYTES = 400 * 1024 * 1024;
const FIRST_CHECK_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/u;
const CHECKSUM_LINE = /^([0-9a-f]{64})\s+\*?(\S+)$/iu;

function parseVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate, current) {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) return next[index] > now[index];
  }
  return false;
}

function windowsAssetName(version) {
  return `Writing-Enhancer-${version}-portable.zip`;
}

function isTrustedDownload(url) {
  return typeof url === "string" && url.startsWith(DOWNLOAD_PREFIX);
}

function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = CHECKSUM_LINE.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

// GitHub `releases/latest` 응답에서 지금보다 새 버전의 Windows ZIP과 검사 파일을 고른다.
function pickUpdate(release, currentVersion) {
  if (!release || release.draft || release.prerelease) return null;
  const version = String(release.tag_name ?? "").replace(/^v/u, "");
  if (!isNewer(version, currentVersion)) return null;
  const assets = (Array.isArray(release.assets) ? release.assets : [])
    .map((asset) => ({
      name: String(asset?.name ?? ""),
      url: String(asset?.browser_download_url ?? ""),
      size: Number(asset?.size) || 0
    }))
    .filter((asset) => isTrustedDownload(asset.url));
  const zip = assets.find((asset) => asset.name === windowsAssetName(version));
  const checksums = assets.find((asset) => asset.name === CHECKSUM_ASSET);
  if (!zip || !checksums || zip.size <= 0 || zip.size > MAX_ZIP_BYTES) return null;
  return { version, zip, checksums, pageUrl: String(release.html_url ?? "") };
}

async function checkForUpdate({ fetchImpl, currentVersion, userAgent }) {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": userAgent }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`업데이트 정보를 받지 못했어요 (${response.status}).`);
  return pickUpdate(await response.json(), currentVersion);
}

async function downloadUpdate(update, { fetchImpl, directory, userAgent, onProgress }) {
  const headers = { "User-Agent": userAgent };
  const sumsResponse = await fetchImpl(update.checksums.url, { headers });
  if (!sumsResponse.ok) throw new Error(`업데이트 검사 값을 받지 못했어요 (${sumsResponse.status}).`);
  const expected = parseChecksums(await sumsResponse.text()).get(update.zip.name);
  if (!expected) throw new Error("업데이트 파일의 검사 값을 찾지 못했어요.");

  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, update.zip.name);
  const response = await fetchImpl(update.zip.url, { headers });
  if (!response.ok || !response.body) throw new Error(`업데이트 파일을 받지 못했어요 (${response.status}).`);
  const total = Number(response.headers?.get?.("content-length")) || update.zip.size;
  const hash = crypto.createHash("sha256");
  const output = fs.createWriteStream(target);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > MAX_ZIP_BYTES) throw new Error("업데이트 파일이 너무 커요.");
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
      onProgress?.(received, total);
    }
    await new Promise((resolve, reject) => output.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    output.destroy();
    fs.rmSync(target, { force: true });
    throw error;
  }
  if (hash.digest("hex") !== expected) {
    fs.rmSync(target, { force: true });
    throw new Error("받은 파일이 손상됐어요. 다시 시도해 주세요.");
  }
  return target;
}

// 이 앱이 압축을 푼 휴대용 폴더에서 실행 중일 때만 업데이트한다(개발 실행·다른 폴더 보호).
function updatableInstall({ execPath, isPackaged }) {
  if (!isPackaged) return null;
  const directory = path.dirname(execPath);
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "resources", "app", "package.json"), "utf8")
    );
    return manifest?.name === PACKAGE_NAME ? directory : null;
  } catch {
    return null;
  }
}

// 앱이 끝나기를 기다렸다가 ZIP을 풀어 앱 폴더를 바꾸고 다시 실행하는 스크립트. 경로는 인자로 받는다.
const INSTALL_SCRIPT = `param(
  [int]$ProcessId,
  [string]$Zip,
  [string]$Target,
  [string]$Exe,
  [string]$Log
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 renders progress bars very slowly for large archives.
$ProgressPreference = 'SilentlyContinue'
function Write-Log([string]$Message) {
  Add-Content -LiteralPath $Log -Value ('[{0}] {1}' -f (Get-Date -Format s), $Message) -Encoding UTF8
}
try {
  Write-Log "waiting for process $ProcessId"
  try { Wait-Process -Id $ProcessId -Timeout 90 -ErrorAction Stop } catch { }
  Start-Sleep -Milliseconds 700
  $stage = Join-Path (Split-Path -Parent $Zip) 'unpacked'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Expand-Archive -LiteralPath $Zip -DestinationPath $stage -Force
  if (-not (Test-Path -LiteralPath (Join-Path $stage 'resources\\app\\package.json'))) {
    throw 'update archive has no resources\\app'
  }
  $appDir = Join-Path $Target 'resources\\app'
  $done = $false
  for ($attempt = 1; $attempt -le 15 -and -not $done; $attempt++) {
    try {
      if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force }
      & robocopy.exe $stage $Target /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -ge 8) { throw "robocopy exit $LASTEXITCODE" }
      $done = $true
    } catch {
      Write-Log "attempt $attempt failed: $_"
      Start-Sleep -Seconds 1
    }
  }
  if (-not $done) { throw 'could not replace application files' }
  Write-Log 'installed'
} catch {
  Write-Log "failed: $_"
}
Start-Process -FilePath $Exe
`;

function launchInstaller({ zipPath, target, execPath, pid, spawnImpl = spawn }) {
  const directory = path.dirname(zipPath);
  const script = path.join(directory, "install-update.ps1");
  const log = path.join(directory, "install-update.log");
  fs.writeFileSync(script, INSTALL_SCRIPT, "utf8");
  const child = spawnImpl(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-ProcessId",
      String(pid),
      "-Zip",
      zipPath,
      "-Target",
      target,
      "-Exe",
      execPath,
      "-Log",
      log
    ],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref?.();
  return { script, log };
}

/**
 * 확인 일정·상태·알림을 묶는다. 상태: idle | available | downloading | installing | error.
 * 새 버전 알림은 버전마다 한 번만 띄우고, 사용자가 누르면 install()로 바로 업데이트한다.
 */
class UpdateManager {
  constructor({
    currentVersion,
    fetchImpl,
    tempDirectory,
    install,
    notify,
    onState,
    quit,
    spawnImpl,
    timers = { setTimeout, setInterval, clearTimeout, clearInterval }
  }) {
    this.currentVersion = currentVersion;
    this.fetchImpl = fetchImpl;
    this.directory = path.join(tempDirectory, "writing-enhancer-update");
    this.installTarget = install;
    this.notify = notify;
    this.onState = onState;
    this.quit = quit;
    this.spawnImpl = spawnImpl;
    this.timers = timers;
    this.userAgent = `WritingEnhancer-Windows/${currentVersion}`;
    this.state = { status: "idle", version: "", progress: 0, message: "" };
    this.update = null;
    this.notified = new Set();
    this.handles = [];
  }

  get enabled() {
    return Boolean(this.installTarget);
  }

  start() {
    if (!this.enabled) return;
    this.handles.push(this.timers.setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.handles.push(this.timers.setInterval(() => this.check(), CHECK_INTERVAL_MS));
  }

  stop() {
    for (const handle of this.handles) {
      this.timers.clearTimeout(handle);
      this.timers.clearInterval(handle);
    }
    this.handles = [];
  }

  setState(changes) {
    this.state = { ...this.state, ...changes };
    this.onState?.(this.state);
  }

  async check() {
    if (!this.enabled || ["downloading", "installing"].includes(this.state.status)) return this.update;
    try {
      const update = await checkForUpdate({
        fetchImpl: this.fetchImpl,
        currentVersion: this.currentVersion,
        userAgent: this.userAgent
      });
      if (!update) return null;
      this.update = update;
      this.setState({ status: "available", version: update.version, progress: 0, message: "" });
      if (!this.notified.has(update.version)) {
        this.notified.add(update.version);
        this.notify?.(update);
      }
      return update;
    } catch {
      // 확인 실패(오프라인 등)는 조용히 넘기고 다음 확인 때 다시 시도한다.
      return null;
    }
  }

  async install() {
    if (!this.enabled) {
      this.setState({ status: "error", message: "이 실행 방식에서는 자동 업데이트를 할 수 없어요." });
      return false;
    }
    if (["downloading", "installing"].includes(this.state.status)) return false;
    const update = this.update || (await this.check());
    if (!update) return false;
    this.setState({ status: "downloading", version: update.version, progress: 0, message: "" });
    try {
      const zipPath = await downloadUpdate(update, {
        fetchImpl: this.fetchImpl,
        directory: this.directory,
        userAgent: this.userAgent,
        onProgress: (received, total) => {
          const progress = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0;
          if (progress !== this.state.progress) this.setState({ progress });
        }
      });
      this.setState({ status: "installing", progress: 100 });
      launchInstaller({
        zipPath,
        target: this.installTarget.directory,
        execPath: this.installTarget.execPath,
        pid: this.installTarget.pid,
        spawnImpl: this.spawnImpl
      });
      this.quit?.();
      return true;
    } catch (error) {
      this.setState({ status: "error", message: error?.message || "업데이트하지 못했어요." });
      return false;
    }
  }
}

module.exports = {
  CHECKSUM_ASSET,
  LATEST_RELEASE_URL,
  UpdateManager,
  checkForUpdate,
  downloadUpdate,
  isNewer,
  isTrustedDownload,
  launchInstaller,
  parseChecksums,
  parseVersion,
  pickUpdate,
  updatableInstall,
  windowsAssetName
};
