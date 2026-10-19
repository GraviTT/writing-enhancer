"use strict";

// 다른 프로그램에서 드래그해 둔 글을 가져오고, 강화한 글을 그 자리에 다시 붙여 넣는 도우미.
// Electron만으로는 다른 프로그램에 키를 보낼 수 없어서, Windows 기본 PowerShell 프로세스 하나를
// 띄워 두고 복사·붙여넣기 키와 창 전환만 맡긴다. 서명 없는 실행 파일이나 네이티브 모듈을 쓰지 않으므로
// Smart App Control이 켜진 PC에서도 동작한다. 클립보드 내용은 이 도우미가 아니라 앱이 직접 읽는다.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_SELECTION_CHARACTERS = 12_000;
const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 6_000;

// 터미널은 글이 선택되지 않았을 때 Ctrl+C가 실행 중인 명령을 끊으므로 Ctrl+Insert만 쓴다.
// 붙여 넣기도 터미널에서는 Shift+Insert가 안전하다.
const TERMINAL_PROCESSES = new Set([
  "windowsterminal",
  "openconsole",
  "conhost",
  "cmd",
  "powershell",
  "powershell_ise",
  "pwsh",
  "wt",
  "mintty",
  "alacritty",
  "wezterm-gui",
  "conemu",
  "conemu64",
  "putty",
  "kitty",
  "hyper",
  "tabby",
  "warp",
  "termius"
]);
// 편집기 안에 터미널이 있는 프로그램. 편집기는 Ctrl+Insert로 복사되므로 Ctrl+C를 다시 보내지 않는다.
const EDITOR_WITH_TERMINAL_PROCESSES = new Set([
  "code",
  "code - insiders",
  "cursor",
  "windsurf",
  "antigravity",
  "devenv",
  "idea64",
  "pycharm64",
  "webstorm64",
  "rider64",
  "clion64",
  "goland64",
  "phpstorm64",
  "rustrover64",
  "studio64"
]);
const GENERIC_DESCRIPTIONS = /^(application frame host|electron|java\(tm\) platform se binary|openjdk platform binary|runtime broker)$/iu;

function normalizeProcessName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

function isTerminal(processName) {
  return TERMINAL_PROCESSES.has(normalizeProcessName(processName));
}

/** 복사 키 방식. "insert-only"는 Ctrl+Insert만, "insert-then-c"는 안 되면 Ctrl+C도 보낸다. */
function copyMode(processName) {
  const name = normalizeProcessName(processName);
  return TERMINAL_PROCESSES.has(name) || EDITOR_WITH_TERMINAL_PROCESSES.has(name)
    ? "insert-only"
    : "insert-then-c";
}

function pasteMode(processName) {
  return isTerminal(processName) ? "shift-insert" : "ctrl-v";
}

/** 화면에 보여 줄 프로그램 이름. 파일 설명 → 창 제목 끝부분 → 프로세스 이름 순으로 고른다. */
function appLabel(info) {
  const description = String(info?.description ?? "").trim();
  if (description && !GENERIC_DESCRIPTIONS.test(description)) return description.slice(0, 40);
  const title = String(info?.title ?? "").trim();
  if (title) {
    const parts = title.split(/\s[-–—]\s/u);
    return parts[parts.length - 1].trim().slice(0, 40);
  }
  return normalizeProcessName(info?.process).slice(0, 40);
}

function cleanSelection(value) {
  return String(value ?? "")
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .slice(0, MAX_SELECTION_CHARACTERS);
}

// 선택한 글을 가져오느라 바꾼 클립보드를 되돌리기 위해, 글·서식·그림을 잠시 보관한다.
// 파일 목록처럼 Electron이 읽지 못하는 내용만 있었다면 되돌리지 않는다(restorable=false).
function snapshotClipboard(clipboard) {
  const snapshot = {};
  const text = clipboard.readText();
  if (text) snapshot.text = text;
  const html = clipboard.readHTML();
  if (html) snapshot.html = html;
  const rtf = clipboard.readRTF();
  if (rtf) snapshot.rtf = rtf;
  const image = clipboard.readImage();
  if (image && !image.isEmpty()) snapshot.image = image;
  const formats = clipboard.availableFormats();
  const hasData = Object.keys(snapshot).length > 0;
  return { data: snapshot, empty: !hasData && formats.length === 0, restorable: hasData || formats.length === 0 };
}

function restoreClipboard(clipboard, snapshot) {
  if (!snapshot?.restorable) return false;
  if (snapshot.empty) {
    clipboard.clear();
    return true;
  }
  clipboard.write(snapshot.data);
  return true;
}

// PowerShell 5.1은 스크립트 파일을 ANSI로 읽을 수 있어 영문만 쓴다.
const HELPER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace WritingEnhancer -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
[DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
$native = [WritingEnhancer.Native]

function Write-Reply($id, $data) {
  $data['id'] = $id
  [Console]::Out.WriteLine(($data | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Get-WindowInfo([IntPtr]$hwnd) {
  $processId = [uint32]0
  [void]$native::GetWindowThreadProcessId($hwnd, [ref]$processId)
  $name = ''
  $description = ''
  try {
    $process = Get-Process -Id $processId
    $name = [string]$process.ProcessName
    $description = [string]$process.Description
  } catch {}
  $title = New-Object System.Text.StringBuilder 512
  [void]$native::GetWindowText($hwnd, $title, 512)
  return @{ ok = $true; hwnd = [string]$hwnd.ToInt64(); pid = [int]$processId; process = $name; description = $description; title = $title.ToString() }
}

# Waits until the user lets go of Ctrl, Shift, Alt and Windows so that the keys sent next are not combined with them.
function Wait-Modifiers([int]$timeout) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $held = $false
    foreach ($key in 0x10, 0x11, 0x12, 0x5B, 0x5C) {
      if ($native::GetAsyncKeyState($key) -band 0x8000) { $held = $true }
    }
    if (-not $held) { return $true }
    if ($watch.ElapsedMilliseconds -gt $timeout) { return $false }
    Start-Sleep -Milliseconds 15
  }
}

function Wait-Clipboard([uint32]$before, [int]$timeout) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $timeout) {
    if ($native::GetClipboardSequenceNumber() -ne $before) { return $true }
    Start-Sleep -Milliseconds 15
  }
  return $false
}

function Invoke-Copy([string]$mode) {
  if (-not (Wait-Modifiers 2500)) { return @{ ok = $false; reason = 'modifiers' } }
  $before = $native::GetClipboardSequenceNumber()
  [System.Windows.Forms.SendKeys]::SendWait('^{INSERT}')
  $changed = Wait-Clipboard $before 450
  if (-not $changed -and $mode -eq 'insert-then-c') {
    [System.Windows.Forms.SendKeys]::SendWait('^c')
    $changed = Wait-Clipboard $before 450
  }
  if ($changed) { Start-Sleep -Milliseconds 60 }
  return @{ ok = $true; changed = $changed }
}

function Set-Focus([IntPtr]$hwnd) {
  if (-not $native::IsWindow($hwnd)) { return $false }
  if ($native::IsIconic($hwnd)) { [void]$native::ShowWindow($hwnd, 9) }
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $foreground = $native::GetForegroundWindow()
    if ($foreground -eq $hwnd) { return $true }
    $ignored = [uint32]0
    $foregroundThread = $native::GetWindowThreadProcessId($foreground, [ref]$ignored)
    $ownThread = $native::GetCurrentThreadId()
    $attached = $false
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $ownThread) {
      $attached = $native::AttachThreadInput($ownThread, $foregroundThread, $true)
    }
    if ($attempt -gt 0) {
      # Windows lets the process that sent the latest input move the foreground, so tap Alt once.
      $native::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      $native::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    }
    [void]$native::BringWindowToTop($hwnd)
    [void]$native::SetForegroundWindow($hwnd)
    if ($attached) { [void]$native::AttachThreadInput($ownThread, $foregroundThread, $false) }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.ElapsedMilliseconds -lt 300) {
      if ($native::GetForegroundWindow() -eq $hwnd) { return $true }
      Start-Sleep -Milliseconds 15
    }
  }
  return $false
}

function Invoke-Paste([string]$handle, [string]$mode) {
  $hwnd = [IntPtr][Int64]$handle
  if (-not (Set-Focus $hwnd)) { return @{ ok = $false; reason = 'focus' } }
  Start-Sleep -Milliseconds 80
  if (-not (Wait-Modifiers 2500)) { return @{ ok = $false; reason = 'modifiers' } }
  if ($mode -eq 'shift-insert') {
    [System.Windows.Forms.SendKeys]::SendWait('+{INSERT}')
  } else {
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  return @{ ok = $true }
}

# The window right below ours in the z-order is the program the user was using before opening the panel.
function Find-PreviousWindow([int]$excludeProcess) {
  $className = New-Object System.Text.StringBuilder 256
  $hwnd = $native::GetTopWindow([IntPtr]::Zero)
  while ($hwnd -ne [IntPtr]::Zero) {
    if ($native::IsWindowVisible($hwnd) -and $native::GetWindowTextLength($hwnd) -gt 0) {
      $processId = [uint32]0
      [void]$native::GetWindowThreadProcessId($hwnd, [ref]$processId)
      $exStyle = $native::GetWindowLong($hwnd, -20)
      $cloaked = 0
      [void]$native::DwmGetWindowAttribute($hwnd, 14, [ref]$cloaked, 4)
      [void]$className.Clear()
      [void]$native::GetClassName($hwnd, $className, 256)
      $shell = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -contains $className.ToString()
      if ($processId -ne $excludeProcess -and -not $shell -and $cloaked -eq 0 -and ($exStyle -band 0x80) -eq 0 -and ($exStyle -band 0x08000000) -eq 0) {
        return $hwnd
      }
    }
    $hwnd = $native::GetWindow($hwnd, 2)
  }
  return [IntPtr]::Zero
}

Write-Reply 0 @{ ok = $true; ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -lt 2) { continue }
  $id = [int]$parts[0]
  try {
    switch ($parts[1]) {
      'foreground' { $reply = Get-WindowInfo ($native::GetForegroundWindow()) }
      'copy' { $reply = Invoke-Copy $parts[2] }
      'paste' { $reply = Invoke-Paste $parts[2] $parts[3] }
      'previous' {
        $found = Find-PreviousWindow ([int]$parts[2])
        if ($found -eq [IntPtr]::Zero) { $reply = @{ ok = $false; reason = 'none' } } else { $reply = Get-WindowInfo $found }
      }
      default { $reply = @{ ok = $false; reason = 'unknown' } }
    }
  } catch {
    $reply = @{ ok = $false; reason = 'error'; message = [string]$_.Exception.Message }
  }
  Write-Reply $id $reply
}
`;

const ARGUMENT_PATTERN = /^[\w-]{1,40}$/u;

function parseHelperLine(line) {
  const text = String(line ?? "").replace(/^\uFEFF/u, "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return Number.isInteger(value?.id) ? value : null;
  } catch {
    return null;
  }
}

class SelectionHelper {
  constructor({ directory, spawnImpl = spawn, platform = process.platform, timers = { setTimeout, clearTimeout } }) {
    this.directory = directory;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.timers = timers;
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 0;
  }

  get supported() {
    return this.platform === "win32";
  }

  start() {
    if (!this.supported) return Promise.reject(new Error("Windows에서만 쓸 수 있어요."));
    if (this.ready) return this.ready;
    fs.mkdirSync(this.directory, { recursive: true });
    const script = path.join(this.directory, "selection-helper.ps1");
    fs.writeFileSync(script, HELPER_SCRIPT, "utf8");
    const child = this.spawnImpl(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    this.child = child;
    let buffer = "";
    let markReady;
    let failReady;
    const readyTimer = this.timers.setTimeout(
      () => failReady?.(new Error("선택한 글을 가져오는 도우미를 시작하지 못했어요.")),
      READY_TIMEOUT_MS
    );
    this.ready = new Promise((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    // 시작에 실패하면 다음 요청 때 다시 띄운다.
    this.ready.catch(() => this.#reset(child));
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = parseHelperLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!message) continue;
        if (message.id === 0) {
          this.timers.clearTimeout(readyTimer);
          markReady(true);
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter.resolve(message);
        }
      }
    });
    child.stderr?.on?.("data", () => {});
    const onGone = () => {
      this.timers.clearTimeout(readyTimer);
      failReady?.(new Error("선택한 글을 가져오는 도우미가 멈췄어요."));
      this.#reset(child);
    };
    child.on("exit", onGone);
    child.on("error", onGone);
    return this.ready;
  }

  #reset(child) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error("선택한 글을 가져오는 도우미가 멈췄어요."));
    this.pending.clear();
  }

  async request(command, args = [], timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!ARGUMENT_PATTERN.test(command) || !args.every((value) => ARGUMENT_PATTERN.test(String(value)))) {
      throw new Error("잘못된 도우미 요청입니다.");
    }
    await this.start();
    const child = this.child;
    if (!child) throw new Error("선택한 글을 가져오는 도우미가 멈췄어요.");
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("도우미 응답이 늦어요."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          this.timers.clearTimeout(timer);
          reject(error);
        }
      });
      child.stdin.write(`${id} ${[command, ...args.map(String)].join(" ")}\n`);
    });
  }

  dispose() {
    const child = this.child;
    if (!child) return;
    this.#reset(child);
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // 이미 끝난 프로세스다.
    }
  }
}

module.exports = {
  HELPER_SCRIPT,
  MAX_SELECTION_CHARACTERS,
  SelectionHelper,
  appLabel,
  cleanSelection,
  copyMode,
  isTerminal,
  normalizeProcessName,
  parseHelperLine,
  pasteMode,
  restoreClipboard,
  snapshotClipboard
};
