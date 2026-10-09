"use strict";

// 두 앱의 버전을 함께 올린다. main에 푸시하면 배포 작업이 이 버전의 릴리스를 만든다.
//   node scripts/bump-version.cjs 0.6.2
//   node scripts/bump-version.cjs patch | minor | major

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packagePath = path.join(root, "desktop", "package.json");
const lockPath = path.join(root, "desktop", "package-lock.json");
const gradlePath = path.join(root, "android", "app", "build.gradle.kts");

const current = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const [major, minor, patch] = current.split(".").map(Number);
const argument = process.argv[2];
const next =
  argument === "patch"
    ? `${major}.${minor}.${patch + 1}`
    : argument === "minor"
      ? `${major}.${minor + 1}.0`
      : argument === "major"
        ? `${major + 1}.0.0`
        : argument;
if (!/^\d+\.\d+\.\d+$/u.test(next || "")) {
  console.error("사용법: node scripts/bump-version.cjs <x.y.z | patch | minor | major>");
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.version = next;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

let gradle = fs.readFileSync(gradlePath, "utf8");
const codeMatch = /versionCode = (\d+)/u.exec(gradle);
if (!codeMatch || !/versionName = "[^"]+"/u.test(gradle)) throw new Error("build.gradle.kts에서 버전을 찾지 못했습니다.");
const code = Number(codeMatch[1]) + 1;
gradle = gradle
  .replace(/versionCode = \d+/u, `versionCode = ${code}`)
  .replace(/versionName = "[^"]+"/u, `versionName = "${next}"`);
fs.writeFileSync(gradlePath, gradle);

console.log(`버전 ${current} → ${next} (Android versionCode ${code})`);
