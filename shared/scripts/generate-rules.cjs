"use strict";

// shared/rules/side-chat-rules.json 한 곳에서 Windows·Android가 읽는 파일을 만든다.
//   node scripts/generate-rules.cjs          생성 파일을 다시 쓴다.
//   node scripts/generate-rules.cjs --check  생성 파일이 원본과 일치하는지만 확인한다.
// Android 테스트용 기대 프롬프트는 Windows 구현으로 만들어, 두 앱이 AI에 보내는
// 사이드 채팅 요청이 글자 단위로 같은지 Android 테스트가 확인하게 한다.

const fs = require("node:fs");
const path = require("node:path");

const repository = path.resolve(__dirname, "..", "..");
const rulesPath = path.join(repository, "shared", "rules", "side-chat-rules.json");
const casesPath = path.join(repository, "shared", "rules", "side-chat-cases.json");
const outputs = {
  desktopRules: path.join(repository, "desktop", "src", "renderer", "side-chat-rules.js"),
  androidRules: path.join(
    repository,
    "android/app/src/main/java/com/example/writingenhancer/ai/SharedSideChatRules.kt"
  ),
  androidCases: path.join(
    repository,
    "android/app/src/test/java/com/example/writingenhancer/ai/SharedSideChatCases.kt"
  )
};

const HEADER_LINES = [
  "자동 생성 파일입니다. 직접 고치지 마세요.",
  "원본: shared/rules/ — 고친 뒤 shared 폴더에서 `npm run rules`를 실행하세요."
];
const USER_PROMPT_PLACEHOLDERS = [
  "view",
  "situation",
  "input",
  "completedText",
  "followUp",
  "reply",
  "enhancementLevel",
  "version",
  "attachmentNames",
  "featureGuide",
  "recentConversation",
  "externalHistory",
  "message",
  "continuity",
  "screen",
  "searchMode"
];
const SEARCH_MODES = ["required", "auto", "disabled"];
// 화면 사례용 최소 PNG 데이터. 이미지 내용은 프롬프트 글자에 들어가지 않는다.
const PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString(
  "base64"
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(message) {
  throw new Error(`side-chat 규칙 오류: ${message}`);
}

function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/gu)].map((match) => match[1]);
}

function validate(rules, cases) {
  const actionNames = rules.responseSchema?.properties?.action?.properties?.name?.enum;
  if (!Array.isArray(actionNames) || !actionNames.includes("none")) {
    fail("responseSchema의 action.name.enum에 none이 있어야 합니다.");
  }
  const knownActions = new Set(actionNames);
  for (const name of [
    ...rules.actions.navigation,
    ...rules.actions.textValue,
    ...Object.keys(rules.labels.pendingActions)
  ]) {
    if (!knownActions.has(name)) fail(`알 수 없는 동작 이름: ${name}`);
  }
  const allPatterns = [
    ...rules.search.disabledPatterns,
    ...rules.search.explicitPatterns,
    rules.search.genericFindPattern,
    rules.search.localTargetPattern
  ];
  for (const entry of allPatterns) {
    if (!/^i?$/u.test(entry.flags)) fail(`지원하지 않는 정규식 플래그: ${entry.flags}`);
    if (/\(\?[a-z]/u.test(entry.pattern)) fail(`인라인 플래그는 쓰지 말고 flags를 쓰세요: ${entry.pattern}`);
    new RegExp(entry.pattern, `${entry.flags}u`);
  }
  const used = new Set(placeholders(rules.prompt.userPrompt.join("\n")));
  for (const name of USER_PROMPT_PLACEHOLDERS) {
    if (!used.has(name)) fail(`userPrompt에 {${name}} 자리가 없습니다.`);
    used.delete(name);
  }
  if (used.size > 0) fail(`userPrompt에 알 수 없는 자리: ${[...used].join(", ")}`);
  for (const mode of SEARCH_MODES) {
    if (typeof rules.prompt.searchMode[mode] !== "string") fail(`searchMode.${mode}가 없습니다.`);
    if (typeof rules.prompt.screen[mode] !== "string") fail(`screen.${mode}가 없습니다.`);
  }
  if (!placeholders(rules.prompt.screen.intro).includes("label")) fail("screen.intro에 {label}이 없습니다.");
  for (const entry of cases.searchMode) {
    if (!SEARCH_MODES.includes(entry.expected)) fail(`searchMode 사례의 기대값: ${entry.expected}`);
  }
  for (const entry of cases.confirmation) {
    if (!knownActions.has(entry.action)) fail(`confirmation 사례의 동작: ${entry.action}`);
  }
  return actionNames;
}

function platformSystemPrompt(rules, platform) {
  return rules.prompt.system.join("\n").replaceAll("{platform}", rules.prompt.platformNames[platform]);
}

function desktopData(rules, actionNames) {
  const { prompt } = rules;
  return {
    version: rules.version,
    limits: rules.limits,
    search: rules.search,
    actions: { names: actionNames, ...rules.actions },
    labels: rules.labels,
    prompt: {
      systemPrompt: platformSystemPrompt(rules, "desktop"),
      userPromptTemplate: prompt.userPrompt.join("\n"),
      featureGuide: prompt.featureGuide.join("\n"),
      continuity: prompt.continuity.join("\n"),
      empty: prompt.empty,
      roles: prompt.roles,
      provenanceMarker: prompt.provenanceMarker,
      externalHistoryPresent: prompt.externalHistoryPresent,
      searchMode: prompt.searchMode,
      screen: prompt.screen
    },
    geminiSchemaKeys: rules.geminiSchemaKeys,
    responseSchema: rules.responseSchema
  };
}

function renderDesktopRules(data) {
  const json = JSON.stringify(data, null, 2);
  return `${HEADER_LINES.map((line) => `// ${line}`).join("\n")}
(function exposeSideChatRules(root, rules) {
  "use strict";

  const freeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const api = freeze(rules);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.sideChatRules = api;
})(typeof globalThis === "object" ? globalThis : this, ${json});
`;
}

function kt(value) {
  return JSON.stringify(String(value)).replace(/\$/gu, "\\$").replace(/\\f/gu, "\\u000C");
}

function ktRegex(entry) {
  return entry.flags.includes("i")
    ? `Regex(${kt(entry.pattern)}, RegexOption.IGNORE_CASE)`
    : `Regex(${kt(entry.pattern)})`;
}

function ktList(values, render, indent = "        ") {
  return values.map((value) => `${indent}${render(value)},`).join("\n");
}

function renderAndroidRules(rules, actionNames, geminiSchema) {
  const { limits, labels, prompt } = rules;
  const constant = (name, value) => `    const val ${name} = ${kt(value)}`;
  return `${HEADER_LINES.map((line) => `// ${line}`).join("\n")}
package com.example.writingenhancer.ai

object SharedSideChatRules {
    const val VERSION = ${rules.version}
    const val CONTEXT_MESSAGES = ${limits.contextMessages}
    const val CONTEXT_CHARACTERS = ${limits.contextCharacters}
    const val WEB_SOURCES = ${limits.webSources}
    const val RELATED_QUERIES = ${limits.relatedQueries}
    const val RELATED_QUERY_CHARACTERS = ${limits.relatedQueryCharacters}
    const val ACTION_VALUE_CHARACTERS = ${limits.actionValueCharacters}
    const val PENDING_PREVIEW_CHARACTERS = ${limits.pendingPreviewCharacters}
    const val PROGRESS_ELAPSED_AFTER_SECONDS = ${limits.progressElapsedAfterSeconds}

    val DISABLED_SEARCH_PATTERNS: List<Regex> = listOf(
${ktList(rules.search.disabledPatterns, ktRegex)}
    )
    val EXPLICIT_SEARCH_PATTERNS: List<Regex> = listOf(
${ktList(rules.search.explicitPatterns, ktRegex)}
    )
    val GENERIC_FIND_PATTERN: Regex = ${ktRegex(rules.search.genericFindPattern)}
    val LOCAL_TARGET_PATTERN: Regex = ${ktRegex(rules.search.localTargetPattern)}

    val ACTION_NAMES: Set<String> = linkedSetOf(
${ktList(actionNames, kt)}
    )
    val NAVIGATION_ACTIONS: Set<String> = setOf(
${ktList(rules.actions.navigation, kt)}
    )
    val TEXT_VALUE_ACTIONS: Set<String> = setOf(
${ktList(rules.actions.textValue, kt)}
    )

${constant("PROGRESS_REQUESTING", labels.progressRequesting)}
${constant("PROGRESS_SEARCHING", labels.progressSearching)}
${constant("PROGRESS_FALLBACK", labels.progressFallback)}
${constant("PROGRESS_ELAPSED", labels.progressElapsed)}
${constant("SOURCES_MISSING_NOTE", labels.sourcesMissingNote)}
${constant("PENDING_TITLE", labels.pendingTitle)}
${constant("PENDING_NOTE", labels.pendingNote)}
${constant("PENDING_FALLBACK", labels.pendingFallback)}
${constant("PENDING_ENHANCEMENT_LEVEL", labels.pendingEnhancementLevel)}
    val PENDING_ACTION_LABELS: Map<String, String> = mapOf(
${ktList(Object.entries(labels.pendingActions), ([name, label]) => `${kt(name)} to ${kt(label)}`)}
    )
${constant("CANCELLED", labels.cancelled)}
${constant("PENDING_DISMISSED", labels.pendingDismissed)}
${constant("SEARCH_MODE_ON", labels.searchModeOn)}
${constant("SEARCH_MODE_OFF", labels.searchModeOff)}

${constant("SYSTEM_PROMPT", platformSystemPrompt(rules, "android"))}
${constant("USER_PROMPT_TEMPLATE", prompt.userPrompt.join("\n"))}
${constant("FEATURE_GUIDE", prompt.featureGuide.join("\n"))}
${constant("CONTINUITY", prompt.continuity.join("\n"))}
${constant("EMPTY", prompt.empty)}
${constant("ROLE_USER", prompt.roles.user)}
${constant("ROLE_ASSISTANT", prompt.roles.assistant)}
${constant("PROVENANCE_MARKER", prompt.provenanceMarker)}
${constant("EXTERNAL_HISTORY_PRESENT", prompt.externalHistoryPresent)}
${constant("SEARCH_MODE_REQUIRED", prompt.searchMode.required)}
${constant("SEARCH_MODE_AUTO", prompt.searchMode.auto)}
${constant("SEARCH_MODE_DISABLED", prompt.searchMode.disabled)}
${constant("SCREEN_CAPTURE_LABEL", prompt.screen.captureLabel)}
${constant("SCREEN_IMAGE_LABEL", prompt.screen.imageLabel)}
${constant("SCREEN_INTRO", prompt.screen.intro)}
${constant("SCREEN_REQUIRED", prompt.screen.required)}
${constant("SCREEN_AUTO", prompt.screen.auto)}
${constant("SCREEN_DISABLED", prompt.screen.disabled)}

${constant("RESPONSE_SCHEMA_JSON", JSON.stringify(rules.responseSchema))}
${constant("GEMINI_RESPONSE_SCHEMA_JSON", JSON.stringify(geminiSchema))}
}
`;
}

function desktopPromptFor(desktop, entry) {
  const attachments =
    entry.screen === "capture" || entry.screen === "image"
      ? [
          {
            id: "shared-case-visual",
            name: entry.screen === "capture" ? "현재 화면.png" : "첨부 이미지.png",
            mimeType: "image/png",
            kind: "image",
            source: entry.screen === "capture" ? "screen" : "file",
            size: 10,
            data: PNG_DATA
          }
        ]
      : [];
  return desktop.buildSideChatPrompt(
    desktop.prepareChatPayload({
      input: entry.input,
      forceSearch: entry.forceSearch === true,
      screenContext: attachments.length > 0,
      attachments,
      messages: entry.messages.map((message) => ({
        role: message.role,
        content: message.content,
        externalGrounding: message.external === true
      })),
      writingContext: entry.writingContext
    })
  );
}

function renderAndroidCases(cases, prompts) {
  const searchCases = ktList(
    cases.searchMode,
    (entry) => `SearchModeCase(${kt(entry.input)}, ${entry.forceSearch === true}, ${kt(entry.expected)})`
  );
  const confirmationCases = ktList(
    cases.confirmation,
    (entry) => `ConfirmationCase(${kt(entry.action)}, ${entry.grounded}, ${entry.expected})`
  );
  const progressCases = ktList(
    cases.progressLabel,
    (entry) =>
      `ProgressCase(${kt(entry.stage)}, ${entry.searchRequired}, ${entry.elapsedMs}L, ${kt(entry.expected)})`
  );
  const pendingCases = ktList(
    cases.pendingAction,
    (entry) =>
      `PendingActionCase(${kt(entry.action)}, ${kt(entry.value)}, ${kt(entry.label)}, ${
        entry.preview === null ? "null" : kt(entry.preview)
      })`
  );
  const promptCases = cases.prompt
    .map((entry, index) => {
      const context = entry.writingContext;
      const messages = entry.messages
        .map(
          (message) =>
            `                PromptMessage(${kt(message.role)}, ${kt(message.content)}, ${message.external === true}),`
        )
        .join("\n");
      return `        PromptCase(
            name = ${kt(entry.name)},
            input = ${kt(entry.input)},
            forceSearch = ${entry.forceSearch === true},
            screen = ${entry.screen ? kt(entry.screen) : "null"},
            messages = listOf(${messages ? `\n${messages}\n            ` : ""}),
            view = ${kt(context.view)},
            situation = ${kt(context.situation)},
            rawInput = ${kt(context.input)},
            completedText = ${kt(context.completedText)},
            followUp = ${kt(context.followUp)},
            reply = ${kt(context.reply)},
            enhancementLevel = ${context.enhancementLevel},
            versionIndex = ${context.versionIndex},
            versionCount = ${context.versionCount},
            attachmentNames = listOf(${context.attachmentNames.map(kt).join(", ")}),
            expectedPrompt = ${kt(prompts[index])},
        ),`;
    })
    .join("\n");
  return `${HEADER_LINES.map((line) => `// ${line}`).join("\n")}
// 기대 프롬프트는 Windows 구현으로 만든 값이다. Android가 같은 요청을 만드는지 확인한다.
package com.example.writingenhancer.ai

object SharedSideChatCases {
    data class SearchModeCase(val input: String, val forceSearch: Boolean, val expected: String)

    data class ConfirmationCase(val action: String, val grounded: Boolean, val expected: Boolean)

    data class ProgressCase(
        val stage: String,
        val searchRequired: Boolean,
        val elapsedMillis: Long,
        val expected: String,
    )

    data class PendingActionCase(
        val action: String,
        val value: String,
        val label: String,
        val preview: String?,
    )

    data class PromptMessage(val role: String, val content: String, val external: Boolean)

    data class PromptCase(
        val name: String,
        val input: String,
        val forceSearch: Boolean,
        val screen: String?,
        val messages: List<PromptMessage>,
        val view: String,
        val situation: String,
        val rawInput: String,
        val completedText: String,
        val followUp: String,
        val reply: String,
        val enhancementLevel: Int,
        val versionIndex: Int,
        val versionCount: Int,
        val attachmentNames: List<String>,
        val expectedPrompt: String,
    )

    val SEARCH_MODE: List<SearchModeCase> = listOf(
${searchCases}
    )

    val CONFIRMATION: List<ConfirmationCase> = listOf(
${confirmationCases}
    )

    val PROGRESS_LABEL: List<ProgressCase> = listOf(
${progressCases}
    )

    val PENDING_ACTION: List<PendingActionCase> = listOf(
${pendingCases}
    )

    val PROMPT: List<PromptCase> = listOf(
${promptCases}
    )
}
`;
}

function loadDesktop() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(repository, "desktop", "src"))) delete require.cache[key];
  }
  return require(path.join(repository, "desktop", "src", "lib", "ai-client.js"));
}

function relative(file) {
  return path.relative(repository, file).replaceAll("\\", "/");
}

function main() {
  const check = process.argv.includes("--check");
  const rules = readJson(rulesPath);
  const cases = readJson(casesPath);
  const actionNames = validate(rules, cases);

  const stale = [];
  const emit = (file, content) => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === content) return;
    if (check) {
      stale.push(relative(file));
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    console.log(`생성: ${relative(file)}`);
  };

  emit(outputs.desktopRules, renderDesktopRules(desktopData(rules, actionNames)));
  if (check && stale.length > 0) {
    console.error(`생성 파일이 원본과 다릅니다: ${stale.join(", ")}\nshared 폴더에서 npm run rules 를 실행하세요.`);
    process.exitCode = 1;
    return;
  }

  const desktop = loadDesktop();
  const geminiSchema = desktop.toGeminiSchema(rules.responseSchema);
  const prompts = cases.prompt.map((entry) => desktopPromptFor(desktop, entry));
  emit(outputs.androidRules, renderAndroidRules(rules, actionNames, geminiSchema));
  emit(outputs.androidCases, renderAndroidCases(cases, prompts));

  if (check) {
    if (stale.length > 0) {
      console.error(`생성 파일이 원본과 다릅니다: ${stale.join(", ")}\nshared 폴더에서 npm run rules 를 실행하세요.`);
      process.exitCode = 1;
    } else {
      console.log("사이드 채팅 공통 규칙: 생성 파일이 최신입니다.");
    }
  }
}

main();
