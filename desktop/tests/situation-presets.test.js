"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const presets = require("../src/renderer/situation-presets");
const writingRules = require("../src/renderer/writing-rules");
const { ConfigStore } = require("../src/lib/config-store");

test("고친 적이 없으면 공통 규칙의 기본 상황 목록을 쓴다", () => {
  assert.deepEqual(presets.normalize(null), writingRules.selection.situations.map(({ label, text }) => ({ label, text })));
  assert.deepEqual(presets.normalize(undefined), presets.defaults());
  // 사용자가 모두 지웠다면 빈 목록을 그대로 둔다.
  assert.deepEqual(presets.normalize([]), []);
  assert.equal(presets.sameAsDefaults(null), true);
});

test("새 상황 버튼은 공백을 정리하고, 이름은 10자까지 줄여 붙인다", () => {
  const added = presets.add(presets.defaults(), "  친구에게\n보내는   생일 축하 메시지  ");
  assert.equal(added.added, true);
  const last = added.list.at(-1);
  assert.equal(last.text, "친구에게 보내는 생일 축하 메시지");
  // 잘린 자리의 공백은 지우고 말줄임표를 붙인다.
  assert.equal(last.label, "친구에게 보내는…");
  assert.ok([...last.label].length <= presets.limits.maxSituationLabel);
  assert.equal(presets.labelFor("짧은 상황"), "짧은 상황");
});

test("빈 글·이미 있는 상황·가득 찬 목록은 저장하지 않는다", () => {
  assert.equal(presets.add(presets.defaults(), "   ").reason, "empty");
  assert.equal(presets.add(presets.defaults(), "업무 메일").reason, "duplicate");
  let list = [];
  for (let index = 0; index < presets.limits.maxSituations; index += 1) {
    list = presets.add(list, `상황 ${index}`).list;
  }
  assert.equal(list.length, presets.limits.maxSituations);
  assert.equal(presets.add(list, "하나 더").reason, "full");
});

test("버튼 삭제와 저장된 목록 정리(중복·빈 값·개수 한도)", () => {
  const removed = presets.remove(presets.defaults(), "업무 메일");
  assert.equal(removed.some((item) => item.text === "업무 메일"), false);
  assert.equal(removed.length, presets.defaults().length - 1);
  const messy = [
    { label: "", text: "  고객 응대  " },
    { label: "중복", text: "고객 응대" },
    { label: "빈 값", text: "   " },
    ...Array.from({ length: 20 }, (_, index) => ({ label: `L${index}`, text: `T${index}` }))
  ];
  const normalized = presets.normalize(messy);
  assert.equal(normalized[0].text, "고객 응대");
  assert.equal(normalized[0].label, "고객 응대");
  assert.equal(normalized.filter((item) => item.text === "고객 응대").length, 1);
  assert.equal(normalized.length, presets.limits.maxSituations);
});

test("PC 설정 파일에 상황 버튼을 저장하고, 기본값으로 되돌릴 수 있다", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "we-presets-"));
  const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" };
  try {
    const file = path.join(directory, "settings.json");
    const store = new ConfigStore(file, safeStorage);
    assert.equal(store.getSituationPresets().customized, false);
    const custom = presets.add(presets.remove(presets.defaults(), "사과"), "동아리 공지").list;
    store.saveSituationPresets(custom);
    const reloaded = new ConfigStore(file, safeStorage).getSituationPresets();
    assert.equal(reloaded.customized, true);
    assert.deepEqual(reloaded.situations, custom);
    // 다른 설정을 저장해도 상황 버튼은 남는다.
    store.save({ windowWidth: 500 });
    assert.deepEqual(new ConfigStore(file, safeStorage).getSituationPresets().situations, custom);
    store.saveSituationPresets(null);
    const reset = new ConfigStore(file, safeStorage).getSituationPresets();
    assert.equal(reset.customized, false);
    assert.deepEqual(reset.situations, presets.defaults());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
