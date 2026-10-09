"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_TEXT_CHARACTERS,
  chooseCaptureSource,
  decodedBase64Size,
  fitCaptureDimensions,
  makeBoundedScreenAttachment,
  normalizeAttachment,
  normalizeAttachments,
  readAttachment,
  stepDownCaptureDimensions,
  textAttachmentSection,
  toGeminiParts,
  toOpenAIContent
} = require("../src/lib/attachment-utils");

function pngBuffer(size = 32) {
  const buffer = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  return buffer;
}

function image(name = "참고.png", source = "file") {
  const data = pngBuffer().toString("base64");
  return {
    id: "image-1",
    name,
    mimeType: "image/png",
    kind: "image",
    source,
    size: Buffer.from(data, "base64").length,
    data
  };
}

test("허용된 텍스트 파일만 읽고 모델 전달 텍스트를 파일당 2만 자로 제한한다", () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".test-attachment-"));
  try {
    const filePath = path.join(directory, "notes.txt");
    fs.writeFileSync(filePath, "가".repeat(MAX_TEXT_CHARACTERS + 500), "utf8");
    const attachment = readAttachment(filePath);
    assert.equal(attachment.kind, "text");
    assert.equal(attachment.text.length, MAX_TEXT_CHARACTERS);
    const section = textAttachmentSection([attachment]);
    assert.match(section, /참고 텍스트 시작/);
    assert.match(section, /참고 텍스트 끝/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("지원하지 않는 파일과 4개를 넘는 첨부를 거부한다", () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".test-attachment-"));
  try {
    const filePath = path.join(directory, "script.exe");
    fs.writeFileSync(filePath, "not executable", "utf8");
    assert.throws(() => readAttachment(filePath), /지원되지 않는/);
    assert.throws(
      () =>
        normalizeAttachments(
          Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) =>
            image(`참고-${index}.png`)
          )
        ),
      /최대 4개/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("이미지와 PDF를 OpenAI와 Gemini의 실제 멀티모달 파트로 변환한다", () => {
  const screenshot = image("현재 화면.png", "screen");
  const pdfData = Buffer.from("%PDF-safe").toString("base64");
  const pdf = {
    id: "pdf-1",
    name: "일정표.pdf",
    mimeType: "application/pdf",
    kind: "document",
    source: "file",
    size: Buffer.from(pdfData, "base64").length,
    data: pdfData
  };

  const openAI = toOpenAIContent("사용자 요청", [screenshot, pdf]);
  assert.deepEqual(openAI.map((part) => part.type), ["input_text", "input_image", "input_file"]);
  assert.match(openAI[1].image_url, /^data:image\/png;base64,/);
  assert.equal(openAI[2].filename, "일정표.pdf");
  assert.match(openAI[2].file_data, /^data:application\/pdf;base64,/);

  const gemini = toGeminiParts("사용자 요청", [screenshot, pdf]);
  assert.equal(gemini[1].inlineData.mimeType, "image/png");
  assert.equal(gemini[2].inlineData.mimeType, "application/pdf");
  assert.equal(gemini[1].inlineData.data, screenshot.data);
});

test("현재 창이 속한 디스플레이의 캡처 소스를 우선 선택한다", () => {
  const sources = [
    { id: "first", display_id: "100" },
    { id: "target", display_id: "200" }
  ];
  assert.equal(chooseCaptureSource(sources, 200).id, "target");
  assert.equal(chooseCaptureSource(sources, 999), null);
  assert.equal(chooseCaptureSource([{ id: "only", display_id: "100" }], 999).id, "only");
});

test("화면 캡처 크기는 가로·세로·울트라와이드에서 종횡비를 유지하며 단계적으로 축소된다", () => {
  for (const [width, height] of [
    [1920, 1080],
    [3440, 1440],
    [1440, 3440]
  ]) {
    const fitted = fitCaptureDimensions(width, height);
    assert.ok(fitted.width <= 1920);
    assert.ok(fitted.height <= 1200);
    assert.ok(Math.abs(fitted.width / fitted.height - width / height) < 0.003);

    const smaller = stepDownCaptureDimensions(fitted.width, fitted.height);
    assert.ok(smaller.width < fitted.width || smaller.height < fitted.height);
    assert.ok(
      Math.abs(smaller.width / smaller.height - fitted.width / fitted.height) < 0.003
    );
  }

  let current = { width: 1920, height: 1080 };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = stepDownCaptureDimensions(current.width, current.height);
    if (!next) break;
    current = next;
  }
  assert.equal(Math.max(current.width, current.height), 640);
  assert.equal(stepDownCaptureDimensions(current.width, current.height), null);
});

test("8MB를 넘는 화면 PNG는 종횡비를 유지해 줄인 뒤 다시 검증한다", () => {
  const resizeCalls = [];
  const makeNativeImage = (width, height, oversized) => ({
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => pngBuffer(oversized ? MAX_ATTACHMENT_BYTES + 1 : 256 * 1024),
    resize: ({ width: nextWidth, height: nextHeight, quality }) => {
      resizeCalls.push({ width: nextWidth, height: nextHeight, quality });
      return makeNativeImage(nextWidth, nextHeight, false);
    }
  });

  const result = makeBoundedScreenAttachment(
    makeNativeImage(1920, 1080, true),
    "단계 축소 화면.png"
  );
  assert.equal(result.source, "screen");
  assert.ok(result.size < MAX_ATTACHMENT_BYTES);
  assert.equal(resizeCalls.length, 1);
  assert.equal(resizeCalls[0].quality, "best");
  assert.ok(Math.abs(resizeCalls[0].width / resizeCalls[0].height - 16 / 9) < 0.003);
});

test("PNG·JPEG·WebP·PDF의 실제 헤더를 검사하고 위장 파일을 거부한다", () => {
  const fixtures = [
    ["photo.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])],
    ["image.webp", "image/webp", Buffer.from("RIFF0000WEBPpayload", "ascii")],
    ["document.pdf", "application/pdf", Buffer.from("%PDF-1.7\nsafe", "ascii")]
  ];
  for (const [name, mimeType, buffer] of fixtures) {
    const normalized = normalizeAttachment({
      id: name,
      name,
      mimeType,
      kind: mimeType === "application/pdf" ? "document" : "image",
      source: "file",
      size: buffer.length,
      data: buffer.toString("base64")
    });
    assert.equal(normalized.mimeType, mimeType);
  }

  assert.throws(
    () =>
      normalizeAttachment({
        id: "fake",
        name: "위장.png",
        mimeType: "image/png",
        kind: "image",
        source: "file",
        size: 12,
        data: Buffer.from("not-a-png", "ascii").toString("base64")
      }),
    /실제 내용 형식/
  );
  assert.throws(
    () =>
      normalizeAttachment({
        ...image("이름.png"),
        mimeType: "image/jpeg"
      }),
    /형식과 내용 형식/
  );
});

test("8MB 상한의 정상 base64를 정규식 스택 위험 없이 검사한다", () => {
  const data = Buffer.alloc(MAX_ATTACHMENT_BYTES, 7).toString("base64");
  assert.equal(decodedBase64Size(data), MAX_ATTACHMENT_BYTES);
  assert.equal(decodedBase64Size(`${data.slice(0, -1)}!`), -1);
});

test("Gemini 20MB 요청 예산을 위해 첨부 합계를 12MB로 제한한다", () => {
  const firstData = pngBuffer(7 * 1024 * 1024).toString("base64");
  const secondData = pngBuffer(6 * 1024 * 1024).toString("base64");
  assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 12 * 1024 * 1024);
  assert.throws(
    () =>
      normalizeAttachments([
        {
          id: "first",
          name: "first.png",
          mimeType: "image/png",
          kind: "image",
          source: "file",
          size: 7 * 1024 * 1024,
          data: firstData
        },
        {
          id: "second",
          name: "second.png",
          mimeType: "image/png",
          kind: "image",
          source: "file",
          size: 6 * 1024 * 1024,
          data: secondData
        }
      ]),
    /전체 크기는 12MB/
  );
});
