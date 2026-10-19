"use strict";

// 자동 업데이트: 릴리스 고르기, 검사 값 확인, 설치 스크립트 실행, 알림은 버전마다 한 번.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  UpdateManager,
  downloadUpdate,
  isNewer,
  parseChecksums,
  pickUpdate,
  updatableInstall
} = require("../src/lib/updater");

const base = "https://github.com/GraviTT/writing-enhancer/releases/download/v0.6.2/";

function release(overrides = {}) {
  return {
    tag_name: "v0.6.2",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/GraviTT/writing-enhancer/releases/tag/v0.6.2",
    assets: [
      { name: "Writing-Enhancer-0.6.2-portable.zip", browser_download_url: `${base}Writing-Enhancer-0.6.2-portable.zip`, size: 12 },
      { name: "WritingEnhancer-0.6.2.apk", browser_download_url: `${base}WritingEnhancer-0.6.2.apk`, size: 10 },
      { name: "SHA256SUMS.txt", browser_download_url: `${base}SHA256SUMS.txt`, size: 100 }
    ],
    ...overrides
  };
}

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "we-updater-"));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withDirectoryAsync(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "we-updater-"));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fakeFetch(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!(url in files)) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    const value = files[url];
    if (typeof value === "object" && !Buffer.isBuffer(value)) {
      return { ok: true, status: 200, json: async () => value };
    }
    const bytes = Buffer.from(value);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === "content-length" ? String(bytes.length) : null) },
      text: async () => bytes.toString("utf8"),
      body: (async function* chunks() {
        for (let index = 0; index < bytes.length; index += 5) yield bytes.subarray(index, index + 5);
      })()
    };
  };
  return { fetchImpl, calls };
}

test("버전 비교와 릴리스 선택은 새 정식 버전의 Windows ZIP만 고른다", () => {
  assert.equal(isNewer("0.6.1", "0.6.0"), true);
  assert.equal(isNewer("v0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.6.0", "0.6.0"), false);
  assert.equal(isNewer("0.6.1-beta", "0.6.0"), false);
  const update = pickUpdate(release(), "0.6.1");
  assert.equal(update.version, "0.6.2");
  assert.equal(update.zip.name, "Writing-Enhancer-0.6.2-portable.zip");
  assert.equal(pickUpdate(release(), "0.6.2"), null);
  assert.equal(pickUpdate(release({ draft: true }), "0.6.1"), null);
  assert.equal(pickUpdate(release({ prerelease: true }), "0.6.1"), null);
  const foreign = release();
  foreign.assets[0].browser_download_url = "https://example.com/Writing-Enhancer-0.6.2-portable.zip";
  assert.equal(pickUpdate(foreign, "0.6.1"), null);
});

test("검사 값 파일을 읽고, 받은 파일의 SHA-256이 다르면 지운다", async () => {
  const zipBytes = Buffer.from("portable zip bytes");
  const hash = crypto.createHash("sha256").update(zipBytes).digest("hex");
  const sums = parseChecksums(`${hash}  Writing-Enhancer-0.6.2-portable.zip\n${"b".repeat(64)} *WritingEnhancer-0.6.2.apk\n`);
  assert.equal(sums.get("Writing-Enhancer-0.6.2-portable.zip"), hash);
  assert.equal(sums.size, 2);

  const update = pickUpdate(release(), "0.6.1");
  await withDirectoryAsync(async (directory) => {
    const good = fakeFetch({
      [`${base}SHA256SUMS.txt`]: `${hash}  Writing-Enhancer-0.6.2-portable.zip\n`,
      [`${base}Writing-Enhancer-0.6.2-portable.zip`]: zipBytes
    });
    const progress = [];
    const saved = await downloadUpdate(update, {
      fetchImpl: good.fetchImpl,
      directory: path.join(directory, "good"),
      userAgent: "test",
      onProgress: (received, total) => progress.push([received, total])
    });
    assert.deepEqual(fs.readFileSync(saved), zipBytes);
    assert.deepEqual(progress.at(-1), [zipBytes.length, zipBytes.length]);

    const bad = fakeFetch({
      [`${base}SHA256SUMS.txt`]: `${"0".repeat(64)}  Writing-Enhancer-0.6.2-portable.zip\n`,
      [`${base}Writing-Enhancer-0.6.2-portable.zip`]: zipBytes
    });
    await assert.rejects(
      downloadUpdate(update, { fetchImpl: bad.fetchImpl, directory: path.join(directory, "bad"), userAgent: "test" }),
      /손상/u
    );
    assert.equal(fs.existsSync(path.join(directory, "bad", update.zip.name)), false);
  });
});

test("이 앱의 휴대용 폴더에서 실행할 때만 업데이트 대상으로 본다", () =>
  withDirectory((directory) => {
    const exe = path.join(directory, "글 강화기.exe");
    assert.equal(updatableInstall({ execPath: exe, isPackaged: true }), null);
    fs.mkdirSync(path.join(directory, "resources", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "resources", "app", "package.json"),
      JSON.stringify({ name: "writing-enhancer-desktop", version: "0.6.1" })
    );
    assert.equal(updatableInstall({ execPath: exe, isPackaged: true }), directory);
    assert.equal(updatableInstall({ execPath: exe, isPackaged: false }), null);
  }));

test("알림은 버전마다 한 번이고, 누르면 받아서 설치 스크립트를 띄운 뒤 앱을 닫는다", async () =>
  withDirectoryAsync(async (directory) => {
    const zipBytes = Buffer.from("new app");
    const hash = crypto.createHash("sha256").update(zipBytes).digest("hex");
    const files = {
      "https://api.github.com/repos/GraviTT/writing-enhancer/releases/latest": release(),
      [`${base}SHA256SUMS.txt`]: `${hash}  Writing-Enhancer-0.6.2-portable.zip\n`,
      [`${base}Writing-Enhancer-0.6.2-portable.zip`]: zipBytes
    };
    const notified = [];
    const states = [];
    const spawned = [];
    let quit = 0;
    const manager = new UpdateManager({
      currentVersion: "0.6.1",
      fetchImpl: (url, options) => fakeFetch(files).fetchImpl(url, options),
      tempDirectory: directory,
      install: { directory: "C:\\Apps\\글 강화기", execPath: "C:\\Apps\\글 강화기\\글 강화기.exe", pid: 4242 },
      notify: (update) => notified.push(update.version),
      onState: (state) => states.push(state.status),
      quit: () => {
        quit += 1;
      },
      spawnSyncImpl: (command, args, options) => {
        spawned.push({ command, args, options });
        return { status: 0 };
      }
    });
    assert.equal((await manager.check()).version, "0.6.2");
    await manager.check();
    assert.deepEqual(notified, ["0.6.2"]);
    assert.equal(manager.state.status, "available");

    assert.equal(await manager.install(), true);
    assert.equal(quit, 1);
    assert.deepEqual(notified, ["0.6.2"]);
    assert.ok(states.includes("downloading"));
    assert.equal(manager.state.status, "installing");
    // 숨긴 PowerShell이 Start-Process로 설치 스크립트를 따로 띄운다(앱이 닫혀도 계속 돈다).
    const { command, args, options } = spawned[0];
    assert.equal(command, "powershell.exe");
    assert.notEqual(options.detached, true);
    assert.equal(options.windowsHide, true);
    const launch = args[args.indexOf("-Command") + 1];
    assert.match(launch, /^Start-Process -FilePath 'powershell\.exe' -WindowStyle Hidden -ArgumentList @\(/u);
    const items = [...launch.matchAll(/'((?:[^']|'')*)'/gu)]
      .slice(1)
      .map((match) => match[1].replace(/''/gu, "'").replace(/^"(.*)"$/u, "$1"));
    const value = (flag) => items[items.indexOf(flag) + 1];
    // 공백이 든 경로는 큰따옴표로 감싸 Start-Process가 하나의 인자로 넘긴다.
    assert.ok(launch.includes(`'"C:\\Apps\\글 강화기\\글 강화기.exe"'`));
    assert.equal(value("-ProcessId"), "4242");
    assert.equal(value("-Target"), "C:\\Apps\\글 강화기");
    assert.equal(value("-Exe"), "C:\\Apps\\글 강화기\\글 강화기.exe");
    assert.ok(fs.existsSync(value("-Zip")));
    const script = fs.readFileSync(value("-File"), "utf8");
    assert.match(script, /Wait-Process -Id \$ProcessId/u);
    assert.match(script, /Expand-Archive -LiteralPath \$Zip/u);
    assert.match(script, /resources\\app\\package\.json/u);
    assert.match(script, /Start-Process -FilePath \$Exe/u);
    // PowerShell 5.1은 BOM 없는 스크립트를 시스템 코드 페이지로 읽으므로 ASCII만 쓰고, 진행 표시는 끈다.
    assert.ok([...script].every((char) => char.charCodeAt(0) < 128), "설치 스크립트는 ASCII만 써야 한다");
    assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/u);
  }));

test("개발 실행처럼 업데이트할 수 없는 곳에서는 확인하지 않고 이유를 알린다", async () => {
  let fetched = 0;
  const manager = new UpdateManager({
    currentVersion: "0.6.1",
    fetchImpl: async () => {
      fetched += 1;
      return { ok: false, status: 500 };
    },
    tempDirectory: os.tmpdir(),
    install: null
  });
  manager.start();
  assert.equal(await manager.check(), null);
  assert.equal(await manager.install(), false);
  assert.match(manager.state.message, /자동 업데이트를 할 수 없어요/u);
  assert.equal(fetched, 0);
});

test("확인이 실패하면(오프라인 등) 조용히 넘기고 상태를 바꾸지 않는다", async () => {
  const manager = new UpdateManager({
    currentVersion: "0.6.1",
    fetchImpl: async () => {
      throw new Error("offline");
    },
    tempDirectory: os.tmpdir(),
    install: { directory: "C:\\Apps", execPath: "C:\\Apps\\a.exe", pid: 1 }
  });
  assert.equal(await manager.check(), null);
  assert.equal(manager.state.status, "idle");
});

test("Windows·Android 업데이트와 배포 작업이 같은 저장소와 파일 이름을 쓴다", () => {
  const repository = path.join(__dirname, "..", "..");
  const read = (relative) => fs.readFileSync(path.join(repository, relative), "utf8");
  const updater = read("desktop/src/lib/updater.js");
  const policy = read("android/app/src/main/java/com/example/writingenhancer/update/AppUpdatePolicy.kt");
  const workflow = read(".github/workflows/release.yml");
  const main = read("desktop/src/main.js");
  for (const source of [updater, policy]) {
    assert.match(source, /REPOSITORY = "GraviTT\/writing-enhancer"/u);
    assert.match(source, /SHA256SUMS\.txt/u);
  }
  assert.match(updater, /`Writing-Enhancer-\$\{version\}-portable\.zip`/u);
  assert.match(policy, /"WritingEnhancer-\$version\.apk"/u);
  assert.match(workflow, /Writing-Enhancer-\$\{VERSION\}-portable\.zip/u);
  assert.match(workflow, /WritingEnhancer-\$\{VERSION\}\.apk/u);
  assert.match(workflow, /> SHA256SUMS\.txt/u);
  assert.match(workflow, /signing-certificate\.sha256/u);
  assert.match(read("android/signing-certificate.sha256"), /^[0-9a-f]{64}\s*$/u);
  // 개발·QA·스모크 실행에서는 업데이트를 확인하지 않는다.
  const start = main.indexOf("    createTray();\n    registerInitialShortcut(configStore.getShortcut());");
  assert.ok(start > main.indexOf("} else if (SMOKE_TEST) {"));
  assert.ok(main.indexOf("    startUpdateChecks();", start) > start);
});

test("같은 Electron으로 만든 앱 전용 ZIP이 있으면 전체 ZIP 대신 그것을 고른다", () => {
  const { appAssetName } = require("../src/lib/updater");
  const name = appAssetName("0.6.2", "37.2.6");
  assert.equal(name, "Writing-Enhancer-0.6.2-app-electron-37.2.6.zip");
  const withApp = release();
  withApp.assets.push({ name, browser_download_url: `${base}${name}`, size: 150_000 });

  const small = pickUpdate(withApp, "0.6.1", { runtime: "37.2.6" });
  assert.equal(small.kind, "app");
  assert.equal(small.zip.name, name);
  // Electron이 다르거나 모르면 전체 ZIP을 받는다.
  assert.equal(pickUpdate(withApp, "0.6.1", { runtime: "38.0.0" }).kind, "full");
  assert.equal(pickUpdate(withApp, "0.6.1").zip.name, "Writing-Enhancer-0.6.2-portable.zip");
  assert.equal(pickUpdate(withApp, "0.6.1", { runtime: "../37.2.6" }).kind, "full");
  // 다른 곳 주소의 앱 전용 ZIP은 쓰지 않는다.
  const foreign = release();
  foreign.assets.push({ name, browser_download_url: `https://example.com/${name}`, size: 150_000 });
  assert.equal(pickUpdate(foreign, "0.6.1", { runtime: "37.2.6" }).kind, "full");
});

test("앱 전용 ZIP은 빌드·배포·설치 스크립트가 같은 이름과 구조(resources/app)를 쓴다", () => {
  const repository = path.join(__dirname, "..", "..");
  const read = (relative) => fs.readFileSync(path.join(repository, relative), "utf8");
  const build = read("desktop/scripts/build-policy-portable.js");
  const workflow = read(".github/workflows/release.yml");
  const main = read("desktop/src/main.js");
  const { INSTALL_SCRIPT } = require("../src/lib/updater");
  assert.match(build, /appAssetName\(packageJson\.version, electronVersion\)/u);
  assert.match(build, /path\.join\("resources", "app"\)/u);
  assert.match(workflow, /Writing-Enhancer-\$\{\{ needs\.plan\.outputs\.version \}\}-app-electron-\*\.zip/u);
  assert.match(workflow, /sha256sum "Writing-Enhancer-\$\{VERSION\}-portable\.zip" "\$\{app_zip\}"/u);
  assert.match(workflow, /"release\/\$\{app_zip\}"/u);
  assert.match(main, /runtimeVersion: process\.versions\.electron/u);
  // 설치 스크립트는 resources\app을 지우고 압축을 푼 내용만 덮어써, 앱 전용 ZIP도 그대로 설치한다.
  assert.match(INSTALL_SCRIPT, /resources\\app\\package\.json/u);
  assert.match(INSTALL_SCRIPT, /Remove-Item -LiteralPath \$appDir -Recurse -Force/u);
  assert.match(INSTALL_SCRIPT, /robocopy\.exe \$stage \$Target \/E/u);
});

test("설치를 누르면 최신 릴리스를 다시 확인해, 며칠 전에 찾아 둔 옛 버전을 받지 않는다", async () =>
  withDirectoryAsync(async (directory) => {
    const newer = release({ tag_name: "v0.6.3" });
    newer.assets = newer.assets.map((asset) => ({
      ...asset,
      name: asset.name.replace("0.6.2", "0.6.3"),
      browser_download_url: asset.browser_download_url.replaceAll("0.6.2", "0.6.3")
    }));
    const zipBytes = Buffer.from("newest app");
    const hash = crypto.createHash("sha256").update(zipBytes).digest("hex");
    const base3 = base.replace("v0.6.2", "v0.6.3");
    const files = {
      "https://api.github.com/repos/GraviTT/writing-enhancer/releases/latest": release(),
      [`${base3}SHA256SUMS.txt`]: `${hash}  Writing-Enhancer-0.6.3-portable.zip\n`,
      [`${base3}Writing-Enhancer-0.6.3-portable.zip`]: zipBytes
    };
    const notified = [];
    let quit = 0;
    const manager = new UpdateManager({
      currentVersion: "0.6.1",
      fetchImpl: (url, options) => fakeFetch(files).fetchImpl(url, options),
      tempDirectory: directory,
      install: { directory: "C:\\Apps", execPath: "C:\\Apps\\a.exe", pid: 7 },
      notify: (update) => notified.push(update.version),
      quit: () => {
        quit += 1;
      },
      spawnSyncImpl: () => ({ status: 0 })
    });
    assert.equal((await manager.check()).version, "0.6.2");
    // 그 사이 새 릴리스가 올라왔다.
    files["https://api.github.com/repos/GraviTT/writing-enhancer/releases/latest"] = newer;
    assert.equal(await manager.install(), true);
    assert.equal(manager.state.version, "0.6.3");
    assert.ok(fs.existsSync(path.join(directory, "writing-enhancer-update", "Writing-Enhancer-0.6.3-portable.zip")));
    // 설치 직전 확인에서는 알림을 다시 띄우지 않는다.
    assert.deepEqual(notified, ["0.6.2"]);
    assert.equal(quit, 1);
  }));

test("설치 프로그램을 띄우지 못하면 앱을 닫지 않고 다시 시도하게 한다", async () =>
  withDirectoryAsync(async (directory) => {
    const zipBytes = Buffer.from("new app");
    const hash = crypto.createHash("sha256").update(zipBytes).digest("hex");
    const files = {
      "https://api.github.com/repos/GraviTT/writing-enhancer/releases/latest": release(),
      [`${base}SHA256SUMS.txt`]: `${hash}  Writing-Enhancer-0.6.2-portable.zip\n`,
      [`${base}Writing-Enhancer-0.6.2-portable.zip`]: zipBytes
    };
    let quit = 0;
    const manager = new UpdateManager({
      currentVersion: "0.6.1",
      fetchImpl: (url, options) => fakeFetch(files).fetchImpl(url, options),
      tempDirectory: directory,
      install: { directory: "C:\\Apps", execPath: "C:\\Apps\\a.exe", pid: 7 },
      quit: () => {
        quit += 1;
      },
      spawnSyncImpl: () => ({ status: 1 })
    });
    assert.equal(await manager.install(), false);
    assert.equal(quit, 0);
    assert.equal(manager.state.status, "error");
    assert.match(manager.state.message, /설치 프로그램을 시작하지 못했어요/u);
  }));
