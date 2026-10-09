"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ATTACHMENT_COUNT = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 20_000;
const MAX_TOTAL_TEXT_CHARACTERS = 50_000;
const MAX_CAPTURE_WIDTH = 1920;
const MAX_CAPTURE_HEIGHT = 1200;
const MIN_CAPTURE_LONG_EDGE = 640;

const TYPE_BY_EXTENSION = Object.freeze({
  ".txt": { mimeType: "text/plain", kind: "text" },
  ".md": { mimeType: "text/markdown", kind: "text" },
  ".csv": { mimeType: "text/csv", kind: "text" },
  ".json": { mimeType: "application/json", kind: "text" },
  ".pdf": { mimeType: "application/pdf", kind: "document" },
  ".png": { mimeType: "image/png", kind: "image" },
  ".jpg": { mimeType: "image/jpeg", kind: "image" },
  ".jpeg": { mimeType: "image/jpeg", kind: "image" },
  ".webp": { mimeType: "image/webp", kind: "image" },
  ".gif": { mimeType: "image/gif", kind: "image" }
});

function createAttachmentError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeName(value) {
  return path.basename(String(value || "참고 자료")).replace(/[\u0000-\u001f]/gu, "").slice(0, 120);
}

function decodedBase64Size(value) {
  const clean = String(value || "");
  const maximumEncodedLength = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
  if (!clean || clean.length > maximumEncodedLength || clean.length % 4 !== 0) {
    return -1;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const contentLength = clean.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = clean.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return -1;
  }
  for (let index = contentLength; index < clean.length; index += 1) {
    if (clean.charCodeAt(index) !== 61) return -1;
  }
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function hasBytes(buffer, offset, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function validateBinarySignature(buffer, mimeType) {
  let valid = false;
  if (mimeType === "image/png") {
    valid = hasBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } else if (mimeType === "image/jpeg") {
    valid = hasBytes(buffer, 0, [0xff, 0xd8, 0xff]);
  } else if (mimeType === "image/webp") {
    valid =
      hasBytes(buffer, 0, [0x52, 0x49, 0x46, 0x46]) &&
      hasBytes(buffer, 8, [0x57, 0x45, 0x42, 0x50]);
  } else if (mimeType === "image/gif") {
    valid =
      buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a";
  } else if (mimeType === "application/pdf") {
    valid = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  if (!valid) {
    throw createAttachmentError(
      "파일 확장자와 실제 내용 형식이 일치하지 않습니다.",
      "ATTACHMENT_SIGNATURE_MISMATCH"
    );
  }
  return true;
}

function normalizeAttachment(raw) {
  const name = safeName(raw?.name);
  const extension = path.extname(name).toLocaleLowerCase("en-US");
  const expected = TYPE_BY_EXTENSION[extension];
  const isScreenshot = raw?.source === "screen" && raw?.mimeType === "image/png";
  const descriptor = isScreenshot ? { mimeType: "image/png", kind: "image" } : expected;
  if (!descriptor) {
    throw createAttachmentError(
      "지원되는 파일은 이미지, PDF, TXT, Markdown, CSV, JSON입니다.",
      "UNSUPPORTED_ATTACHMENT"
    );
  }

  const mimeType = String(raw?.mimeType || descriptor.mimeType).toLowerCase();
  if (mimeType !== descriptor.mimeType) {
    throw createAttachmentError("파일 형식과 내용 형식이 일치하지 않습니다.", "INVALID_ATTACHMENT");
  }

  const kind = descriptor.kind;
  let data = "";
  let text = "";
  let size = Number(raw?.size);
  if (kind === "text") {
    text = String(raw?.text ?? "").slice(0, MAX_TEXT_CHARACTERS);
    size = Number.isFinite(size) ? size : Buffer.byteLength(text, "utf8");
    if (!text.trim()) {
      throw createAttachmentError("비어 있는 참고 파일은 첨부할 수 없습니다.", "EMPTY_ATTACHMENT");
    }
  } else {
    data = String(raw?.data ?? "");
    const decodedSize = decodedBase64Size(data);
    if (decodedSize < 0) {
      throw createAttachmentError("첨부 파일 데이터가 올바르지 않습니다.", "INVALID_ATTACHMENT");
    }
    size = decodedSize;
    validateBinarySignature(Buffer.from(data, "base64"), mimeType);
  }

  if (!Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    throw createAttachmentError("파일 하나는 8MB 이하만 첨부할 수 있습니다.", "ATTACHMENT_TOO_LARGE");
  }

  return {
    id: String(raw?.id || crypto.randomUUID()).slice(0, 80),
    name,
    mimeType,
    kind,
    size,
    source: raw?.source === "screen" ? "screen" : "file",
    ...(kind === "text" ? { text } : { data })
  };
}

function normalizeAttachments(rawAttachments) {
  const source = Array.isArray(rawAttachments) ? rawAttachments : [];
  if (source.length > MAX_ATTACHMENT_COUNT) {
    throw createAttachmentError(
      `참고 자료는 최대 ${MAX_ATTACHMENT_COUNT}개까지 첨부할 수 있습니다.`,
      "TOO_MANY_ATTACHMENTS"
    );
  }

  const attachments = source.map(normalizeAttachment);
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw createAttachmentError("첨부 파일 전체 크기는 12MB 이하여야 합니다.", "ATTACHMENTS_TOO_LARGE");
  }
  return attachments;
}

function readAttachment(filePath) {
  const resolvedPath = path.resolve(String(filePath));
  const name = safeName(resolvedPath);
  const descriptor = TYPE_BY_EXTENSION[path.extname(name).toLocaleLowerCase("en-US")];
  if (!descriptor) {
    throw createAttachmentError(
      `${name}: 지원되지 않는 파일 형식입니다.`,
      "UNSUPPORTED_ATTACHMENT"
    );
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw createAttachmentError(`${name}: 비어 있거나 올바른 파일이 아닙니다.`, "EMPTY_ATTACHMENT");
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw createAttachmentError(`${name}: 파일 하나는 8MB 이하여야 합니다.`, "ATTACHMENT_TOO_LARGE");
  }

  const buffer = fs.readFileSync(resolvedPath);
  if (descriptor.kind !== "text") validateBinarySignature(buffer, descriptor.mimeType);
  return normalizeAttachment({
    id: crypto.randomUUID(),
    name,
    mimeType: descriptor.mimeType,
    kind: descriptor.kind,
    size: buffer.length,
    source: "file",
    ...(descriptor.kind === "text"
      ? { text: buffer.toString("utf8") }
      : { data: buffer.toString("base64") })
  });
}

function makeScreenAttachment(buffer, name = "현재 화면.png") {
  return normalizeAttachment({
    id: crypto.randomUUID(),
    name,
    mimeType: "image/png",
    kind: "image",
    size: buffer.length,
    source: "screen",
    data: buffer.toString("base64")
  });
}

function fitCaptureDimensions(
  width,
  height,
  maxWidth = MAX_CAPTURE_WIDTH,
  maxHeight = MAX_CAPTURE_HEIGHT
) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const widthLimit = Math.max(1, Math.round(Number(maxWidth) || MAX_CAPTURE_WIDTH));
  const heightLimit = Math.max(1, Math.round(Number(maxHeight) || MAX_CAPTURE_HEIGHT));
  const scale = Math.min(1, widthLimit / sourceWidth, heightLimit / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function stepDownCaptureDimensions(
  width,
  height,
  factor = 0.82,
  minimumLongEdge = MIN_CAPTURE_LONG_EDGE
) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const minimum = Math.max(1, Math.round(Number(minimumLongEdge) || MIN_CAPTURE_LONG_EDGE));
  if (longEdge <= minimum) return null;
  const safeFactor = Math.min(0.95, Math.max(0.5, Number(factor) || 0.82));
  const targetLongEdge = Math.max(minimum, Math.round(longEdge * safeFactor));
  const scale = targetLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function makeBoundedScreenAttachment(image, name = "현재 화면.png") {
  if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) {
    throw createAttachmentError("현재 화면을 촬영하지 못했습니다.", "CAPTURE_FAILED");
  }
  const original = image;
  const originalSize = original.getSize();
  let dimensions = fitCaptureDimensions(originalSize.width, originalSize.height);
  let current =
    dimensions.width === originalSize.width && dimensions.height === originalSize.height
      ? original
      : original.resize({ ...dimensions, quality: "best" });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const buffer = current.toPNG();
    if (buffer.length <= MAX_ATTACHMENT_BYTES) {
      return makeScreenAttachment(buffer, name);
    }
    const next = stepDownCaptureDimensions(dimensions.width, dimensions.height);
    if (!next) break;
    dimensions = next;
    current = original.resize({ ...dimensions, quality: "best" });
    if (!current || current.isEmpty()) break;
  }
  throw createAttachmentError(
    "현재 화면 이미지가 너무 커서 안전하게 첨부하지 못했습니다.",
    "CAPTURE_TOO_LARGE"
  );
}

function textAttachmentSection(attachments) {
  const normalized = normalizeAttachments(attachments);
  if (normalized.length === 0) {
    return "없음";
  }
  let remainingCharacters = MAX_TOTAL_TEXT_CHARACTERS;
  return normalized
    .map((attachment, index) => {
      if (attachment.kind === "text") {
        const limited = attachment.text.slice(0, Math.max(0, remainingCharacters));
        remainingCharacters -= limited.length;
        return `${index + 1}. ${attachment.name}\n--- 참고 텍스트 시작 ---\n${limited}\n--- 참고 텍스트 끝 ---`;
      }
      return `${index + 1}. ${attachment.name} (${attachment.mimeType}, 별도 첨부)`;
    })
    .join("\n\n");
}

function toOpenAIContent(prompt, attachments) {
  const normalized = normalizeAttachments(attachments);
  return [
    { type: "input_text", text: prompt },
    ...normalized.flatMap((attachment) => {
      if (attachment.kind === "image") {
        return [
          {
            type: "input_image",
            image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
            detail: "auto"
          }
        ];
      }
      if (attachment.kind === "document") {
        return [
          {
            type: "input_file",
            filename: attachment.name,
            file_data: `data:${attachment.mimeType};base64,${attachment.data}`
          }
        ];
      }
      return [];
    })
  ];
}

function toGeminiParts(prompt, attachments) {
  const normalized = normalizeAttachments(attachments);
  return [
    { text: prompt },
    ...normalized.flatMap((attachment) =>
      attachment.kind === "text"
        ? []
        : [
            {
              inlineData: {
                mimeType: attachment.mimeType,
                data: attachment.data
              }
            }
          ]
    )
  ];
}

function chooseCaptureSource(sources, displayId) {
  const candidates = Array.isArray(sources) ? sources : [];
  const target = String(displayId);
  const matched = candidates.find(
    (source) => String(source?.display_id ?? source?.displayId) === target
  );
  if (matched) return matched;
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_WIDTH,
  MIN_CAPTURE_LONG_EDGE,
  MAX_TEXT_CHARACTERS,
  MAX_TOTAL_TEXT_CHARACTERS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  TYPE_BY_EXTENSION,
  chooseCaptureSource,
  decodedBase64Size,
  fitCaptureDimensions,
  makeBoundedScreenAttachment,
  makeScreenAttachment,
  normalizeAttachment,
  normalizeAttachments,
  readAttachment,
  stepDownCaptureDimensions,
  textAttachmentSection,
  toGeminiParts,
  toOpenAIContent,
  validateBinarySignature
};
