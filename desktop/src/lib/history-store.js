"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_HISTORY_ITEMS = 40;
const MAX_VERSIONS = 12;

function text(value, maximum) {
  return String(value ?? "").replace(/\u0000/gu, "").slice(0, maximum);
}

function normalizeVersion(value) {
  const completedText = text(value?.completedText, 30_000).trim();
  if (!completedText) return null;
  return {
    completedText,
    followUp: text(value?.followUp, 1_000).trim(),
    enhancementLevel: Math.min(5, Math.max(1, Math.round(Number(value?.enhancementLevel) || 3))),
    createdAt: Number.isFinite(Date.parse(value?.createdAt))
      ? new Date(value.createdAt).toISOString()
      : new Date().toISOString()
  };
}

function normalizeRecord(record, existing) {
  const versions = (Array.isArray(record?.versions) ? record.versions : [])
    .map(normalizeVersion)
    .filter(Boolean)
    .slice(-MAX_VERSIONS);
  if (!text(record?.input, 12_000).trim() || versions.length === 0) {
    throw new Error("입력과 완성본이 있는 작업만 히스토리에 저장할 수 있습니다.");
  }
  const now = new Date().toISOString();
  const requestedIndex = Number(record?.versionIndex);
  return {
    id: existing?.id || text(record?.id, 80) || crypto.randomUUID(),
    situation: text(record?.situation, 2_000),
    input: text(record?.input, 12_000),
    attachmentNames: (Array.isArray(record?.attachmentNames) ? record.attachmentNames : [])
      .map((name) => path.basename(text(name, 120)))
      .filter(Boolean)
      .slice(0, 4),
    versions,
    versionIndex: Math.max(
      0,
      Math.min(Number.isInteger(requestedIndex) ? requestedIndex : versions.length - 1, versions.length - 1)
    ),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function summary(record) {
  const current = record.versions[record.versionIndex] || record.versions.at(-1);
  const titleSource = record.input.trim() || current?.completedText || "이전 작업";
  return {
    id: record.id,
    title: titleSource.split(/\r?\n/u)[0].slice(0, 54),
    inputPreview: String(record.input || "").replace(/\s+/gu, " ").slice(0, 100),
    preview: String(current?.completedText || "").replace(/\s+/gu, " ").slice(0, 100),
    updatedAt: record.updatedAt,
    versionCount: record.versions.length
  };
}

class HistoryStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maximum = Math.min(options.maximum ?? MAX_HISTORY_ITEMS, MAX_HISTORY_ITEMS);
    this.records = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.slice(0, this.maximum) : [];
    } catch {
      return [];
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), "utf8");
  }

  list() {
    return this.records
      .slice()
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map(summary);
  }

  get(id) {
    const record = this.records.find((item) => item.id === id);
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  upsert(record) {
    const index = this.records.findIndex((item) => item.id === record?.id);
    const normalized = normalizeRecord(record, index >= 0 ? this.records[index] : null);
    if (index >= 0) {
      this.records[index] = normalized;
    } else {
      this.records.unshift(normalized);
    }
    this.records = this.records
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, this.maximum);
    this.#write();
    return this.get(normalized.id);
  }

  remove(id) {
    const before = this.records.length;
    this.records = this.records.filter((item) => item.id !== id);
    if (before !== this.records.length) this.#write();
    return before - this.records.length;
  }
}

module.exports = {
  HistoryStore,
  MAX_HISTORY_ITEMS,
  MAX_VERSIONS,
  normalizeRecord
};
