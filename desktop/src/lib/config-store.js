"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  shortcut: "CommandOrControl+Shift+Space",
  memoryEnabled: true,
  memoryAdditionsEnabled: true,
  windowMode: "docked",
  windowOpacity: 0.98,
  fontScale: 1,
  windowWidth: 440,
  windowHeight: 740,
  dockSide: "right"
});

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function normalizePlacement(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return {
    x: Number.isFinite(x) ? Math.round(x) : null,
    y: Number.isFinite(y) ? Math.round(y) : null,
    side: value?.side === "left" ? "left" : "right"
  };
}

function normalizePublic(value = {}) {
  return {
    shortcut: String(value.shortcut || DEFAULTS.shortcut).slice(0, 120),
    memoryEnabled: value.memoryEnabled !== false,
    memoryAdditionsEnabled:
      typeof value.memoryAdditionsEnabled === "boolean"
        ? value.memoryAdditionsEnabled
        : value.memoryEnabled !== false,
    windowMode: value.windowMode === "free" ? "free" : "docked",
    windowOpacity: clamp(value.windowOpacity, 0.55, 1, DEFAULTS.windowOpacity),
    fontScale: clamp(value.fontScale, 0.85, 1.3, DEFAULTS.fontScale),
    windowWidth: Math.round(clamp(value.windowWidth, 380, 680, DEFAULTS.windowWidth)),
    windowHeight: Math.round(clamp(value.windowHeight, 560, 920, DEFAULTS.windowHeight)),
    dockSide: value.dockSide === "left" ? "left" : "right"
  };
}

class ConfigStore {
  constructor(filePath, safeStorage) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.data = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        ...normalizePublic(parsed),
        placements: {
          expanded: normalizePlacement(parsed?.placements?.expanded),
          collapsed: normalizePlacement(parsed?.placements?.collapsed)
        },
        secrets: parsed.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {}
      };
    } catch {
      return {
        ...DEFAULTS,
        placements: {
          expanded: normalizePlacement(),
          collapsed: normalizePlacement()
        },
        secrets: {}
      };
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  getPublicSettings() {
    return {
      ...normalizePublic(this.data),
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY || this.data.secrets.openai),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || this.data.secrets.gemini),
      openAIFromEnvironment: Boolean(process.env.OPENAI_API_KEY),
      geminiFromEnvironment: Boolean(process.env.GEMINI_API_KEY),
      encryptionAvailable: this.safeStorage.isEncryptionAvailable()
    };
  }

  getShortcut() {
    return this.data.shortcut || DEFAULTS.shortcut;
  }

  getApiKey(provider) {
    const envName = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    if (process.env[envName]) {
      return process.env[envName].trim();
    }

    const encrypted = this.data.secrets[provider];
    if (!encrypted) {
      return "";
    }

    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      return "";
    }
  }

  getPlacement(expanded) {
    const key = expanded ? "expanded" : "collapsed";
    return normalizePlacement(this.data.placements?.[key]);
  }

  savePlacement(expanded, placement) {
    const key = expanded ? "expanded" : "collapsed";
    this.data.placements = this.data.placements || {};
    this.data.placements[key] = normalizePlacement(placement);
    if (placement?.side === "left" || placement?.side === "right") {
      this.data.dockSide = placement.side;
    }
    this.#write();
    return this.getPlacement(expanded);
  }

  save({
    shortcut,
    memoryEnabled,
    memoryAdditionsEnabled,
    windowMode,
    windowOpacity,
    fontScale,
    windowWidth,
    windowHeight,
    dockSide,
    openaiKey,
    geminiKey,
    clearOpenAI,
    clearGemini
  }) {
    if (shortcut) {
      this.data.shortcut = String(shortcut).trim();
    }
    if (typeof memoryEnabled === "boolean") {
      this.data.memoryEnabled = memoryEnabled;
    }
    if (typeof memoryAdditionsEnabled === "boolean") {
      this.data.memoryAdditionsEnabled = memoryAdditionsEnabled;
    }
    const nextPublic = normalizePublic({
      ...this.data,
      windowMode: windowMode ?? this.data.windowMode,
      windowOpacity: windowOpacity ?? this.data.windowOpacity,
      fontScale: fontScale ?? this.data.fontScale,
      windowWidth: windowWidth ?? this.data.windowWidth,
      windowHeight: windowHeight ?? this.data.windowHeight,
      dockSide: dockSide ?? this.data.dockSide
    });
    Object.assign(this.data, nextPublic);

    const hasSecretChange =
      Boolean(String(openaiKey ?? "").trim()) ||
      Boolean(String(geminiKey ?? "").trim()) ||
      clearOpenAI === true ||
      clearGemini === true;

    if (hasSecretChange && !this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows 보안 저장소를 사용할 수 없어 API 키를 저장하지 않았습니다.");
    }

    if (clearOpenAI === true && !process.env.OPENAI_API_KEY) {
      delete this.data.secrets.openai;
    }
    if (clearGemini === true && !process.env.GEMINI_API_KEY) {
      delete this.data.secrets.gemini;
    }

    const cleanOpenAI = String(openaiKey ?? "").trim();
    const cleanGemini = String(geminiKey ?? "").trim();
    if (cleanOpenAI) {
      this.data.secrets.openai = this.safeStorage.encryptString(cleanOpenAI).toString("base64");
    }
    if (cleanGemini) {
      this.data.secrets.gemini = this.safeStorage.encryptString(cleanGemini).toString("base64");
    }

    this.#write();
    return this.getPublicSettings();
  }
}

module.exports = { ConfigStore, DEFAULTS, normalizePlacement, normalizePublic };
