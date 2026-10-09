"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_MESSAGES = 60;
const MAX_SOURCES = 6;
const MAX_RELATED_QUERIES = 3;

function cleanText(value, maximum) {
  return String(value ?? "").replace(/\u0000/gu, "").slice(0, maximum).trim();
}

function normalizeSources(values) {
  const sources = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const rawUrl = cleanText(value?.url, 2_048);
    if (!rawUrl) continue;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    const url = parsed.href;
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({
      title: cleanText(value?.title, 160) || parsed.hostname,
      url
    });
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

function normalizeRelatedQueries(values) {
  const queries = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const query = cleanText(value, 140);
    const key = query.toLocaleLowerCase("ko-KR");
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= MAX_RELATED_QUERIES) break;
  }
  return queries;
}

function normalizeMessage(value) {
  const role = value?.role === "assistant" ? "assistant" : value?.role === "user" ? "user" : "";
  const content = cleanText(value?.content, role === "assistant" ? 12_000 : 6_000);
  if (!role || !content) return null;
  const sources = role === "assistant" ? normalizeSources(value?.sources) : [];
  const legacyAssistantProvenance =
    role === "assistant" && typeof value?.externalGrounding !== "boolean";
  return {
    id: cleanText(value?.id, 80) || crypto.randomUUID(),
    role,
    content,
    sources,
    relatedQueries:
      role === "assistant" ? normalizeRelatedQueries(value?.relatedQueries) : [],
    externalGrounding:
      role === "assistant" &&
      (value?.externalGrounding === true || sources.length > 0 || legacyAssistantProvenance),
    sourcesMissing: role === "assistant" && value?.sourcesMissing === true,
    createdAt: Number.isFinite(Date.parse(value?.createdAt))
      ? new Date(value.createdAt).toISOString()
      : new Date().toISOString()
  };
}

function normalizeBounds(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.min(680, Math.max(340, Math.round(width))),
    height: Math.min(920, Math.max(480, Math.round(height)))
  };
}

class SideChatStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const rawMessages = Array.isArray(parsed) ? parsed : parsed?.messages;
      return {
        messages: (Array.isArray(rawMessages) ? rawMessages : [])
          .map(normalizeMessage)
          .filter(Boolean)
          .slice(-MAX_MESSAGES),
        windowBounds: normalizeBounds(parsed?.windowBounds)
      };
    } catch {
      return { messages: [], windowBounds: null };
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  list() {
    return JSON.parse(JSON.stringify(this.data.messages));
  }

  appendExchange(
    userContent,
    assistantContent,
    assistantSources = [],
    assistantRelatedQueries = [],
    options = {}
  ) {
    const user = normalizeMessage({ role: "user", content: userContent });
    const assistant = normalizeMessage({
      role: "assistant",
      content: assistantContent,
      sources: assistantSources,
      relatedQueries: assistantRelatedQueries,
      externalGrounding: options?.externalGrounding === true,
      sourcesMissing: options?.sourcesMissing === true
    });
    if (!user || !assistant) {
      throw new Error("사용자 메시지와 AI 답변이 모두 있어야 대화를 저장할 수 있습니다.");
    }
    this.data.messages = [...this.data.messages, user, assistant].slice(-MAX_MESSAGES);
    this.#write();
    return this.list();
  }

  appendAssistant(
    assistantContent,
    assistantSources = [],
    assistantRelatedQueries = [],
    options = {}
  ) {
    const assistant = normalizeMessage({
      role: "assistant",
      content: assistantContent,
      sources: assistantSources,
      relatedQueries: assistantRelatedQueries,
      externalGrounding: options?.externalGrounding === true,
      sourcesMissing: options?.sourcesMissing === true
    });
    if (!assistant) {
      throw new Error("AI 답변이 있어야 대화를 저장할 수 있습니다.");
    }
    this.data.messages = [...this.data.messages, assistant].slice(-MAX_MESSAGES);
    this.#write();
    return this.list();
  }

  rewriteFromUser(messageId, userContent) {
    const id = cleanText(messageId, 80);
    const index = this.data.messages.findIndex(
      (message) => message.id === id && message.role === "user"
    );
    if (index < 0) {
      const error = new Error("수정할 사용자 메시지를 찾지 못했습니다.");
      error.code = "MESSAGE_NOT_FOUND";
      throw error;
    }
    const user = normalizeMessage({
      ...this.data.messages[index],
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString()
    });
    if (!user) {
      const error = new Error("수정할 메시지를 입력해 주세요.");
      error.code = "EMPTY_INPUT";
      throw error;
    }
    this.data.messages = [...this.data.messages.slice(0, index), user].slice(-MAX_MESSAGES);
    this.#write();
    return this.list();
  }

  clear() {
    const removed = this.data.messages.length;
    this.data.messages = [];
    this.#write();
    return removed;
  }

  getWindowBounds() {
    return this.data.windowBounds ? { ...this.data.windowBounds } : null;
  }

  saveWindowBounds(bounds) {
    this.data.windowBounds = normalizeBounds(bounds);
    this.#write();
    return this.getWindowBounds();
  }
}

module.exports = {
  MAX_MESSAGES,
  MAX_RELATED_QUERIES,
  MAX_SOURCES,
  SideChatStore,
  normalizeBounds,
  normalizeMessage,
  normalizeRelatedQueries,
  normalizeSources
};
