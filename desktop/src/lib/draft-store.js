"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeAttachments } = require("./attachment-utils");
const enhancementLevels = require("../renderer/enhancement-levels");

function clean(value, maximum) {
  return String(value ?? "").replace(/\u0000/gu, "").slice(0, maximum);
}

function normalizeDraft(value) {
  const versions = (Array.isArray(value?.versions) ? value.versions : [])
    .map((version) => ({
      completedText: clean(version?.completedText, 30_000),
      followUp: clean(version?.followUp, 1_000),
      enhancementLevel: enhancementLevels.normalize(version?.enhancementLevel),
      createdAt: clean(version?.createdAt, 40)
    }))
    .filter((version) => version.completedText.trim())
    .slice(-12);
  return {
    situation: clean(value?.situation, 2_000),
    input: clean(value?.input, 12_000),
    reply: clean(value?.reply, 2_000),
    guessAnswer: clean(value?.guessAnswer, 2_000),
    guessAssumption: clean(value?.guessAssumption, 1_000),
    guessQuestion: clean(value?.guessQuestion, 1_000),
    historyId: clean(value?.historyId, 80),
    enhancementLevel: enhancementLevels.normalize(value?.enhancementLevel),
    versionIndex: Math.max(0, Math.min(Number(value?.versionIndex) || 0, Math.max(0, versions.length - 1))),
    versions,
    attachments: Array.isArray(value?.attachments) ? value.attachments.slice(0, 4) : [],
    updatedAt: new Date().toISOString()
  };
}

class DraftStore {
  constructor(filePath, attachmentDirectory = `${filePath}.attachments`) {
    this.filePath = filePath;
    this.attachmentDirectory = attachmentDirectory;
  }

  #loadAttachments(metadata) {
    const loaded = [];
    for (const item of Array.isArray(metadata) ? metadata : []) {
      try {
        const cacheName = path.basename(clean(item?.cacheName, 120));
        if (!cacheName) continue;
        const buffer = fs.readFileSync(path.join(this.attachmentDirectory, cacheName));
        loaded.push({
          id: clean(item.id, 80),
          name: clean(item.name, 120),
          mimeType: clean(item.mimeType, 80),
          kind: clean(item.kind, 20),
          source: item.source === "screen" ? "screen" : "file",
          size: buffer.length,
          ...(item.kind === "text"
            ? { text: buffer.toString("utf8") }
            : { data: buffer.toString("base64") })
        });
      } catch {
        // A missing or damaged cache entry should not prevent the text draft from loading.
      }
    }
    try {
      return normalizeAttachments(loaded);
    } catch {
      return [];
    }
  }

  #saveAttachments(rawAttachments) {
    let attachments;
    try {
      attachments = normalizeAttachments(rawAttachments);
    } catch {
      attachments = [];
    }
    fs.mkdirSync(this.attachmentDirectory, { recursive: true });
    const keep = new Set();
    const metadata = attachments.map((attachment, index) => {
      const safeId = attachment.id.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 70) || `item-${index}`;
      const cacheName = `${index}-${safeId}.bin`;
      keep.add(cacheName);
      fs.writeFileSync(
        path.join(this.attachmentDirectory, cacheName),
        attachment.kind === "text"
          ? Buffer.from(attachment.text, "utf8")
          : Buffer.from(attachment.data, "base64")
      );
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        source: attachment.source,
        size: attachment.size,
        cacheName
      };
    });
    for (const name of fs.readdirSync(this.attachmentDirectory)) {
      if (!keep.has(name) && /^[A-Za-z0-9_-]+\.bin$/u.test(name)) {
        fs.rmSync(path.join(this.attachmentDirectory, name));
      }
    }
    return metadata;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const draft = normalizeDraft(parsed);
      draft.attachments = this.#loadAttachments(parsed.attachments);
      return draft;
    } catch {
      return normalizeDraft({});
    }
  }

  save(value) {
    const normalized = normalizeDraft(value);
    let attachmentMetadata = [];
    if (Object.prototype.hasOwnProperty.call(value || {}, "attachments")) {
      attachmentMetadata = this.#saveAttachments(value.attachments);
    } else {
      try {
        const previous = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        attachmentMetadata = Array.isArray(previous.attachments) ? previous.attachments.slice(0, 4) : [];
      } catch {
        attachmentMetadata = [];
      }
    }
    normalized.attachments = attachmentMetadata;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return { ...normalized, attachments: this.#loadAttachments(attachmentMetadata) };
  }

  clear() {
    if (fs.existsSync(this.attachmentDirectory)) {
      fs.rmSync(this.attachmentDirectory, { recursive: true });
    }
    try {
      fs.rmSync(this.filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}

module.exports = { DraftStore, normalizeDraft };
