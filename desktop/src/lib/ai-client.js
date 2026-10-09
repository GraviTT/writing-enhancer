"use strict";

const {
  normalizeAttachments,
  textAttachmentSection,
  toGeminiParts,
  toOpenAIContent
} = require("./attachment-utils");
const enhancementLevels = require("../renderer/enhancement-levels");
const sideChatRules = require("../renderer/side-chat-rules");
const { fillTemplate, labels: sideChatLabels } = require("../renderer/side-chat-text");
const {
  CONTEXT_MESSAGE_LIMIT,
  applyGroundingPolicy,
  createMissingSearchSourcesError,
  hasWebSources,
  prepareSideChatContext,
  requiresWebSearch,
  webSearchPolicy
} = require("./side-chat-policy");

const OPENAI_MODEL = "gpt-5.6-terra";
const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_GEMINI_REQUEST_BYTES = 19_000_000;
const MAX_WEB_SOURCES = sideChatRules.limits.webSources;

const MEMORY_SCHEMA = {
  type: "array",
  maxItems: 3,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: ["style_rule", "context_fact", "relationship", "workflow_rule"]
      },
      value: { type: "string", maxLength: 240 },
      scope: { type: "string", maxLength: 80 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      source: { type: "string", enum: ["explicit", "repeated", "inferred"] },
      conflict_key: {
        anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }]
      },
      keywords: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 40 }
      }
    },
    required: [
      "type",
      "value",
      "scope",
      "confidence",
      "source",
      "conflict_key",
      "keywords"
    ]
  }
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    completed_text: {
      type: "string",
      description: "설명이나 머리말 없이 바로 사용할 수 있는 완성된 글"
    },
    assumption: {
      type: "string",
      maxLength: 240,
      description: "완성에 사용한 가장 중요한 상황 또는 의도 추론 한 문장"
    },
    follow_up: {
      type: "string",
      description: "현재 단계의 규칙에 맞는 짧고 자연스러운 후속 질문 하나"
    },
    memory_candidates: MEMORY_SCHEMA
  },
  required: ["completed_text", "assumption", "follow_up", "memory_candidates"]
};

const GUESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assumption: {
      type: "string",
      maxLength: 240,
      description: "현재 입력에서 추론한 목적과 상황"
    },
    question: {
      type: "string",
      maxLength: 500,
      description: "결과를 크게 개선할 정보 하나를 쉬운 말로 묻는 질문"
    }
  },
  required: ["assumption", "question"]
};

// 사이드 채팅 응답 형식은 Windows·Android가 shared/rules에서 함께 쓴다.
const CHAT_SCHEMA = sideChatRules.responseSchema;

const GEMINI_SCHEMA_KEYS = new Set(sideChatRules.geminiSchemaKeys);

function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties") {
      result.properties = Object.fromEntries(
        Object.entries(value || {}).map(([property, propertySchema]) => [
          property,
          toGeminiSchema(propertySchema)
        ])
      );
    } else if (key === "items") {
      result.items = toGeminiSchema(value);
    } else if (key === "anyOf") {
      result.anyOf = value.map(toGeminiSchema);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const SYSTEM_PROMPT = `당신은 '글 강화기'다. 사용자는 생각나는 대로 불완전하게 말하고 글의 목적이나 문체를 고르지 못할 수 있다.

가장 중요한 원칙:
1. 기본 작업에서는 질문보다 먼저, 가장 가능성 높은 의도·상황·독자를 스스로 추론해 바로 쓸 수 있는 완성본을 만든다.
2. 맞춤법만 고치지 말고 목적에 맞게 구조·논리·어조를 완성한다.
3. 이름, 날짜, 숫자, 금액, 약속, 인간관계, 부정 표현 같은 사실은 바꾸거나 새로 만들지 않는다. 불명확하면 안전하고 일반적으로 표현한다.
4. 사용자가 프롬프트를 원하면 실행 가능한 명료한 프롬프트로 완성한다.
5. completed_text에는 안내문, 제목 "완성본", 인용 표시를 넣지 않는다.
6. follow_up은 완성본 뒤에만 보인다. 첫 완성 직후에는 완성된 글의 유형·주제·목적을 자연스럽게 예상한 뒤 그 목적에 맞게 더 다듬어도 되는지 묻는다. 두 번째 질문부터는 AI의 추천 해석을 먼저 말하고 사용자가 짧게 정정할 수 있는 질문 하나만 한다. 선택지를 나열하지 않는다.
7. 사용자가 "알아서"라고 답하면 추천 판단으로 즉시 더 좋은 완성본을 만든다.
8. 상황 안내, 사전 질문의 답, 참고 파일과 이미지는 사용자의 원문보다 사실을 꾸며내는 근거가 아니라 맥락을 이해하는 자료로만 쓴다.

기억 후보:
- 다음 요청에도 재사용할 가치가 있는 지속적 문체 선호, 관계별 작성 규칙만 최대 3개 제안한다.
- 원문, 일회성 세부사항, AI가 추측한 사실, 이름·연락처·금융·신분·의료·비밀번호 정보는 후보로 만들지 않는다.
- 사용자가 직접 명시했으면 explicit, 같은 선호가 반복 확인됐으면 repeated, AI 추론이면 inferred다.
- value는 원문 복사가 아닌 240자 이하의 독립적인 한 문장 규칙이어야 한다.`;

const GUESS_SYSTEM_PROMPT = `당신은 글을 쓰기 전에 사용자의 의도를 알아맞히는 도우미다.
사용자가 고르거나 전문 용어로 설명하도록 요구하지 않는다.
현재 입력과 상황, 참고 자료에서 이미 알 수 있는 것은 묻지 않는다.
완성 결과를 실제로 크게 바꿀 정보가 있다면 가장 가능성 높은 해석을 먼저 한 문장으로 말하고, 쉬운 질문 하나만 한다.
정보가 충분해도 형식적인 질문을 만들지 말고, "제가 이해한 방향으로 바로 완성해도 될까요?"처럼 확인한다.`;

// 사이드 채팅 지시문과 요청 틀은 shared/rules/side-chat-rules.json 한 곳에서 관리한다.
const CHAT_SYSTEM_PROMPT = sideChatRules.prompt.systemPrompt;

function buildMemoryText(memories) {
  return memories.length
    ? memories
        .slice(0, 5)
        .map((card, index) => {
          const sourceKind = card.sourceKind || card.source || "inferred";
          return `${index + 1}. ${sourceKind} | ${card.type || "context_fact"} | ` +
            `${card.scope || "general"} | ${card.value}`;
        })
        .join("\n")
    : "없음";
}

const EXPLICIT_LENGTH_PATTERNS = Object.freeze([
  /(?:\d+(?:\.\d+)?|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|몇)\s*(?:줄|문장|문단|배|배수|자|글자|페이지|쪽)(?:\s*(?:로|으로|정도|내외|분량))?/iu,
  /(?:절반|반\s*분량|반으로\s*(?:줄여|줄여서|축약)|두\s*배|세\s*배|몇\s*배)/iu,
  /A4\s*(?:용지\s*)?\d+(?:\.\d+)?\s*(?:장|페이지|쪽)/iu
]);

function hasExplicitLengthDirective(value) {
  const text = String(value || "").trim();
  return Boolean(text) && EXPLICIT_LENGTH_PATTERNS.some((pattern) => pattern.test(text));
}

function buildUserPrompt({
  input,
  situation = "",
  memories = [],
  refinement,
  preflight,
  regenerateFromOriginal = false,
  attachments = [],
  enhancementLevel = enhancementLevels.DEFAULT,
  followUpMode = "subsequent"
}) {
  const attachmentText = textAttachmentSection(attachments);
  const level = enhancementLevels.definition(enhancementLevel);
  const materialLength = String(input || situation || "").trim().length;
  const targetCharacters = enhancementLevels.targetCharacterRange(
    materialLength,
    level.value
  );
  const directRequirements = [
    situation,
    preflight?.answer,
    refinement?.answer
  ]
    .filter(Boolean)
    .join("\n");
  const explicitLength = hasExplicitLengthDirective(directRequirements);
  const lengthGuidance = explicitLength
    ? "사용자가 상황 안내 또는 답변에 직접 지정한 줄 수·문장 수·문단 수·배수·글자 수를 " +
      "그 표현 그대로 최우선 적용한다. 강화 범위 단계의 목표 분량과 글자 수 계산은 이번 결과에는 적용하지 않는다."
    : `목표 분량: ${level.lengthTarget}. 현재 텍스트 재료 ${materialLength}자를 기준으로 ` +
      `결과 본문은 약 ${targetCharacters.minimum}~${targetCharacters.maximum}자를 목표로 한다. ` +
      "문단 수만 늘리지 말고 실제 결과 글자 수가 단계별 차이를 분명히 보여야 한다.";
  const followUpInstruction =
    followUpMode === "first"
      ? `첫 완성 직후의 follow_up 규칙:
- completed_text를 보고 글 유형, 주제, 목적을 가장 자연스럽게 한 문장 안에서 예상한다.
- 그 예상이 맞다면 해당 주제와 목적에 맞게 내용·구조·어조를 한 번 더 다듬어도 되는지 자연스럽게 묻는다.
- 사용자가 글 유형을 직접 고르게 하거나 선택지를 나열하지 않는다.
- 예시 형식: "팀장에게 일정 변경 승인을 요청하는 업무 보고로 보여요. 이 목적에 맞게 이유와 요청 흐름을 조금 더 다듬어도 될까요?"`
      : `두 번째 이후 follow_up 규칙:
- 기존 방식대로 이번 수정에서 적용한 추천 판단을 짧게 말한다.
- 사용자가 다음 수정 방향을 짧게 정정할 수 있는 질문 하나만 한다.`;
  const common = `상황 안내:
${String(situation || "").trim() || "없음"}

관련 기억:
${buildMemoryText(memories)}

참고 자료:
${attachmentText}

처음 입력:
${input}

사용자 직접 요구 우선순위:
- 상황 안내와 사용자의 답은 사용자가 직접 지정한 요구다.
- 문체, 말투, 글 구조, 대상, 목적의 직접 요구는 기본 강화 규칙보다 우선해 강하게 반영한다.
- 줄 수·문장 수·문단 수·배수·글자 수처럼 구체적인 분량 지시가 있으면 그것이 분량의 최우선 기준이다.
- 구체적인 분량 지시가 없을 때만 강화 범위의 목표 분량을 적용한다.
- 사실 안전 규칙은 모든 요구보다 우선한다. 분량을 맞추기 위해 사실을 만들거나 추정하지 않는다.

강화 범위:
${level.value}단계 · ${level.label}
${level.instruction}
${lengthGuidance}
모든 단계에서 입력에 없는 이름·인물·날짜·시간·금액·숫자·장소·약속·확정/취소·완료 여부·원인·관계·부정을 새로 만들거나 사실처럼 추정하지 마라.
일차 사실 근거는 처음 입력, 상황 안내, 사용자의 답, 사용자가 제공한 참고 자료로만 제한한다.
현재 완성본, AI가 직전에 물은 내용과 AI의 추론은 보조 맥락이므로 새로운 사실의 근거로 삼지 마라.
관련 기억의 첫 필드는 출처다. explicit/repeated 기억은 이번 글과 직접 관련될 때만 사실 보조로 쓸 수 있다.
inferred 기억은 문체·선호·질문 힌트일 뿐 사실 근거로 절대 사용하지 마라.`;

  const commonWithFollowUp = `${common}

${followUpInstruction}`;

  if (regenerateFromOriginal) {
    return `${commonWithFollowUp}

재강화 기준:
- 이전 완성본, 이전 후속 질문과 AI 추론은 참조하지 않는다.
- 현재 상황, 참고 자료, 관련 기억, 강화 범위 설정은 유지한다.
- 처음 입력을 유일한 원본으로 삼아 독립적인 새 완성본을 만든다.

사용자에게 설명을 더 요구하지 말고 원문 기준으로 새 결과를 바로 완성하라.`;
  }

  if (refinement?.currentText) {
    return `${commonWithFollowUp}

현재 완성본:
${refinement.currentText}

AI가 직전에 물은 내용:
${refinement.followUp || "없음"}

사용자의 답:
${refinement.answer || "알아서"}

현재 입력과 사용자의 최신 답을 가장 우선해 완성본을 다시 작성하라.`;
  }

  if (preflight?.question || preflight?.answer) {
    return `${commonWithFollowUp}

완성 전 AI 질문:
${preflight.question || "없음"}

사용자의 답:
${preflight.answer || "알아서"}

질문의 답을 반영하되 사용자가 못 고른 경우 가장 자연스러운 판단으로 바로 완성하라.`;
  }

  return `${commonWithFollowUp}

사용자에게 설명을 더 요구하지 말고 최선의 해석으로 먼저 완성하라.`;
}

function buildGuessPrompt({ input, situation = "", attachments = [] }) {
  return `상황 안내:
${String(situation || "").trim() || "없음"}

참고 자료:
${textAttachmentSection(attachments)}

사용자의 입력:
${input}

이 글을 더 정확히 완성하기 위해 정말 필요한 질문 하나만 시작하라.`;
}

function buildSideChatPrompt({
  input,
  messages = [],
  writingContext = {},
  screenContext = false,
  screenKind = "",
  searchPolicy = "auto",
  searchRequired = false,
  searchDisabled = false,
  priorExternalContext = false
}) {
  const { limits, prompt } = sideChatRules;
  const effectiveSearchPolicy =
    searchPolicy === "disabled" || searchDisabled === true
      ? "disabled"
      : searchPolicy === "required" || searchRequired === true
        ? "required"
        : "auto";
  const candidates = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-CONTEXT_MESSAGE_LIMIT);
  const selected = [];
  let remainingCharacters = limits.contextCharacters;
  for (let index = candidates.length - 1; index >= 0 && remainingCharacters > 0; index -= 1) {
    const message = candidates[index];
    const content = String(message.content || "").slice(0, remainingCharacters);
    if (!content) continue;
    const role = message.role === "assistant" ? prompt.roles.assistant : prompt.roles.user;
    const provenance =
      message.role === "assistant" && message.externalGrounding === true
        ? ` [${prompt.provenanceMarker}]`
        : "";
    selected.unshift(`${role}${provenance}: ${content}`);
    remainingCharacters -= content.length;
  }
  const versions = Array.isArray(writingContext?.versions) ? writingContext.versions : [];
  const versionCount = Math.max(
    Number(writingContext?.versionCount) || versions.length,
    versions.length
  );
  const versionIndex = Math.min(
    Math.max(Number(writingContext?.versionIndex) || 0, 0),
    Math.max(versionCount - 1, 0)
  );
  const selectedVersion = versions[versionIndex] || {};
  const attachmentNames = Array.isArray(writingContext?.attachmentNames)
    ? writingContext.attachmentNames.slice(0, 4).join(", ")
    : "";
  const text = (value) => String(value || "").trim() || prompt.empty;
  const screen = screenContext
    ? `${fillTemplate(prompt.screen.intro, {
        label: screenKind === "image" ? prompt.screen.imageLabel : prompt.screen.captureLabel
      })} ${prompt.screen[effectiveSearchPolicy]}`
    : prompt.empty;
  return fillTemplate(prompt.userPromptTemplate, {
    view: String(writingContext?.view || "input"),
    situation: text(writingContext?.situation),
    input: text(writingContext?.input),
    completedText: text(writingContext?.completedText || selectedVersion.completedText),
    followUp: text(writingContext?.followUp || selectedVersion.followUp),
    reply: text(writingContext?.reply),
    enhancementLevel: enhancementLevels.normalize(writingContext?.enhancementLevel),
    version: versionCount ? `${versionIndex + 1}/${versionCount}` : prompt.empty,
    attachmentNames: attachmentNames || prompt.empty,
    featureGuide: prompt.featureGuide,
    recentConversation: selected.join("\n\n") || prompt.empty,
    externalHistory: priorExternalContext ? prompt.externalHistoryPresent : prompt.empty,
    message: String(input || "").trim(),
    continuity: prompt.continuity,
    screen,
    searchMode: prompt.searchMode[effectiveSearchPolicy]
  });
}

function parseJsonText(text) {
  const clean = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(clean);
}

function normalizeResult(value) {
  const completedText = String(value?.completed_text ?? value?.completedText ?? "").trim();
  const followUp = String(value?.follow_up ?? value?.followUp ?? "").trim();
  const assumption = String(value?.assumption ?? "").trim();
  if (!completedText) {
    throw new Error("AI가 완성된 글을 반환하지 않았습니다.");
  }
  return {
    completedText,
    assumption,
    followUp:
      followUp ||
      "이 방향이 가장 자연스러워 보여요. 어색한 부분만 편하게 말해 주세요.",
    memoryCandidates: Array.isArray(value?.memory_candidates)
      ? value.memory_candidates.slice(0, 3)
      : Array.isArray(value?.memoryCandidates)
        ? value.memoryCandidates.slice(0, 3)
        : []
  };
}

function normalizeGuess(value) {
  const assumption = String(value?.assumption ?? "").trim();
  const question = String(value?.question ?? "").trim();
  if (!question) {
    throw new Error("AI가 질문을 만들지 못했습니다.");
  }
  return {
    assumption,
    question
  };
}

function normalizeChatResult(value) {
  const reply = String(value?.reply ?? value?.text ?? "").trim();
  if (!reply) throw new Error("AI가 채팅 답변을 반환하지 않았습니다.");
  const allowedActions = new Set(CHAT_SCHEMA.properties.action.properties.name.enum);
  const requestedName = String(value?.action?.name || "none");
  const name = allowedActions.has(requestedName) ? requestedName : "none";
  const relatedQueries = [];
  const seenQueries = new Set();
  if (name === "none") {
    for (const query of Array.isArray(value?.related_queries)
      ? value.related_queries
      : Array.isArray(value?.relatedQueries)
        ? value.relatedQueries
        : []) {
      const normalized = String(query || "")
        .replace(/\u0000/gu, "")
        .trim()
        .slice(0, sideChatRules.limits.relatedQueryCharacters);
      const key = normalized.toLocaleLowerCase("ko-KR");
      if (!normalized || seenQueries.has(key)) continue;
      seenQueries.add(key);
      relatedQueries.push(normalized);
      if (relatedQueries.length >= sideChatRules.limits.relatedQueries) break;
    }
  }
  return {
    reply,
    action: {
      name,
      value: String(value?.action?.value || "").slice(0, sideChatRules.limits.actionValueCharacters)
    },
    relatedQueries
  };
}

function normalizeWebSource(value) {
  const rawUrl = String(value?.url ?? value?.uri ?? value?.web?.uri ?? "").trim();
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const title = String(value?.title ?? value?.web?.title ?? parsed.hostname)
    .replace(/\u0000/gu, "")
    .trim()
    .slice(0, 160);
  return {
    title: title || parsed.hostname,
    url: parsed.href.slice(0, 2_048)
  };
}

function normalizeWebSources(values) {
  const sources = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const source = normalizeWebSource(value);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= MAX_WEB_SOURCES) break;
  }
  return sources;
}

function extractOpenAISources(payload) {
  const citations = [];
  const searchSources = [];
  for (const item of payload?.output ?? []) {
    for (const part of item?.content ?? []) {
      for (const annotation of part?.annotations ?? []) {
        if (annotation?.type === "url_citation") citations.push(annotation);
      }
    }
    if (item?.type === "web_search_call") {
      searchSources.push(...(item?.action?.sources ?? []));
    }
  }
  return normalizeWebSources([...citations, ...searchSources]);
}

function extractGeminiSources(payload) {
  const chunks = payload?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return normalizeWebSources(chunks);
}

function openAIWebSearchUsed(payload) {
  return (payload?.output ?? []).some((item) => item?.type === "web_search_call");
}

function geminiWebSearchUsed(payload) {
  const grounding = payload?.candidates?.[0]?.groundingMetadata;
  return Boolean(
    grounding &&
      ((Array.isArray(grounding.groundingChunks) && grounding.groundingChunks.length > 0) ||
        (Array.isArray(grounding.webSearchQueries) && grounding.webSearchQueries.length > 0) ||
        grounding.searchEntryPoint)
  );
}

function extractOpenAIText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? [])
    .flatMap((item) => item?.content ?? [])
    .filter((part) => part?.type === "output_text" || typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

function extractGeminiText(payload) {
  return (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part?.text ?? "")
    .join("");
}

function createCancelledError() {
  const error = new Error(sideChatLabels.cancelled);
  error.code = "CANCELLED";
  return error;
}

async function fetchJson(fetchImpl, url, options, timeoutMs = 35_000, callerSignal) {
  if (callerSignal?.aborted) throw createCancelledError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (callerSignal?.aborted) throw createCancelledError();
    if (!response.ok) {
      const detail =
        body?.error?.message || body?.error?.status || `${response.status} ${response.statusText}`;
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (callerSignal?.aborted) throw createCancelledError();
    if (error?.name === "AbortError") {
      throw new Error("AI 응답 시간이 너무 길어 요청을 중단했습니다.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener?.("abort", abortFromCaller);
  }
}

// 사이드 채팅 요청에서 검색 정책·외부 자료 여부·화면 종류를 계산한다.
function prepareChatPayload(payload) {
  const attachments = normalizeAttachments(payload?.attachments);
  const forceSearch = payload?.forceSearch === true;
  const preparedContext = prepareSideChatContext(payload?.input, payload?.messages);
  const priorExternalContext =
    payload?.priorExternalContext === true || preparedContext.priorExternalContext;
  const capturedScreen = attachments.some((attachment) => attachment.source === "screen");
  const screenContext = Boolean(payload?.screenContext) || capturedScreen;
  const searchPolicy = webSearchPolicy(payload?.input, { forceSearch });
  return {
    input: String(payload?.input || "").trim(),
    messages: preparedContext.messages,
    writingContext:
      payload?.writingContext && typeof payload.writingContext === "object"
        ? payload.writingContext
        : {},
    attachments,
    screenContext,
    screenKind: capturedScreen ? "capture" : screenContext ? "image" : "",
    forceSearch,
    priorExternalContext,
    searchPolicy,
    searchRequired: searchPolicy === "required",
    searchDisabled: searchPolicy === "disabled",
    signal: payload?.signal,
    onProgress: typeof payload?.onProgress === "function" ? payload.onProgress : null
  };
}

class AIClient {
  constructor({ getApiKey, fetchImpl = globalThis.fetch }) {
    this.getApiKey = getApiKey;
    this.fetchImpl = fetchImpl;
  }

  async enhance(payload) {
    return this.#run("enhance", { ...payload, attachments: normalizeAttachments(payload.attachments) });
  }

  async guess(payload) {
    return this.#run("guess", { ...payload, attachments: normalizeAttachments(payload.attachments) });
  }

  async chat(payload) {
    return this.#run("chat", prepareChatPayload(payload));
  }

  async #run(mode, payload) {
    const attempts = [];
    const openAIKey = this.getApiKey("openai");
    const geminiKey = this.getApiKey("gemini");
    if (openAIKey) {
      attempts.push({
        provider: "openai",
        run: () => this.#callOpenAI(openAIKey, mode, payload)
      });
    }
    if (geminiKey) {
      attempts.push({
        provider: "gemini",
        run: () => this.#callGemini(geminiKey, mode, payload)
      });
    }
    if (attempts.length === 0) {
      const error = new Error("설정에서 OpenAI 또는 Gemini API 키를 한 번만 입력해 주세요.");
      error.code = "NO_API_KEY";
      throw error;
    }

    const failures = [];
    // 검색을 직접 요청했는데 출처가 없던 첫 답변. 모든 공급자가 실패하면 경고와 함께 보여 준다.
    let sourcelessAnswer = null;
    const finish = (result, provider) => ({
      ...result,
      provider,
      model: provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL,
      fallbackUsed: failures.length > 0,
      externalGrounding: mode === "chat" && result?.externalGrounding === true
    });
    for (const attempt of attempts) {
      if (payload.signal?.aborted) throw createCancelledError();
      payload.onProgress?.({
        stage: failures.length > 0 ? "fallback" : "requesting",
        provider: attempt.provider,
        searchPolicy: payload.searchPolicy || "none"
      });
      try {
        let result = await attempt.run();
        if (mode === "chat") {
          result = applyGroundingPolicy(result, {
            screenContext: payload.screenContext,
            priorExternalContext: payload.priorExternalContext
          });
          if (payload.searchRequired && !hasWebSources(result)) {
            const answer = finish({ ...result, sourcesMissing: true }, attempt.provider);
            // 화면 이미지는 다른 공급자에게 다시 보내지 않는다.
            if (payload.screenContext) return answer;
            sourcelessAnswer ??= answer;
            throw createMissingSearchSourcesError();
          }
        }
        return finish(result, attempt.provider);
      } catch (error) {
        if (error?.code === "CANCELLED") throw error;
        failures.push(`${attempt.provider}: ${error.message}`);
        if (mode === "chat" && payload.screenContext) {
          const screenError = new Error(
            "현재 화면을 안전하게 확인하지 못했습니다. 화면은 저장하지 않았으니 다시 촬영해 주세요."
          );
          screenError.code = "SCREEN_CONTEXT_UNAVAILABLE";
          throw screenError;
        }
      }
    }
    if (sourcelessAnswer) return sourcelessAnswer;
    if (mode === "chat" && payload.searchRequired) {
      const searchError = new Error(
        "웹 검색 출처를 확인하지 못했습니다. 잠시 후 다시 검색해 주세요."
      );
      searchError.code = "SEARCH_UNAVAILABLE";
      throw searchError;
    }
    const error = new Error(`AI 연결에 실패했습니다. ${failures.join(" / ")}`);
    error.code = "AI_UNAVAILABLE";
    throw error;
  }

  async #callOpenAI(apiKey, mode, payload) {
    const prompt =
      mode === "guess"
        ? buildGuessPrompt(payload)
        : mode === "chat"
          ? buildSideChatPrompt(payload)
          : buildUserPrompt(payload);
    const schema = mode === "guess" ? GUESS_SCHEMA : mode === "chat" ? CHAT_SCHEMA : OUTPUT_SCHEMA;
    const userContent = toOpenAIContent(prompt, payload.attachments);
    if (mode === "chat" && payload.screenContext) {
      for (const part of userContent) {
        if (part?.type === "input_image") part.detail = "high";
      }
    }
    const request = {
      model: OPENAI_MODEL,
      store: false,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                mode === "guess"
                  ? GUESS_SYSTEM_PROMPT
                  : mode === "chat"
                    ? CHAT_SYSTEM_PROMPT
                    : SYSTEM_PROMPT
            }
          ]
        },
        {
          role: "user",
          content: userContent
        }
      ],
      reasoning: { effort: mode === "chat" ? "medium" : "low" },
      text: {
        verbosity: mode === "chat" ? "medium" : "low",
        format: {
          type: "json_schema",
          name:
            mode === "guess"
              ? "writing_enhancer_question"
              : mode === "chat"
                ? "side_chat_reply"
                : "writing_enhancer_result",
          strict: true,
          schema
        }
      }
    };
    if (mode === "chat" && !payload.searchDisabled) {
      request.tools = [{ type: "web_search", search_context_size: "high" }];
      request.tool_choice = payload.searchRequired ? { type: "web_search" } : "auto";
      request.max_tool_calls = 8;
      request.include = ["web_search_call.action.sources"];
    }
    const response = await fetchJson(
      this.fetchImpl,
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request)
      },
      mode === "chat" ? 60_000 : 35_000,
      payload.signal
    );
    const parsed = parseJsonText(extractOpenAIText(response));
    if (mode === "guess") return normalizeGuess(parsed);
    if (mode === "chat") {
      const chatResult = normalizeChatResult(parsed);
      const sources = extractOpenAISources(response);
      return {
        ...chatResult,
        sources,
        webSearchUsed: openAIWebSearchUsed(response),
        relatedQueries: sources.length > 0 ? chatResult.relatedQueries : []
      };
    }
    return normalizeResult(parsed);
  }

  async #callGemini(apiKey, mode, payload) {
    const prompt =
      mode === "guess"
        ? buildGuessPrompt(payload)
        : mode === "chat"
          ? buildSideChatPrompt(payload)
          : buildUserPrompt(payload);
    const schema = mode === "guess" ? GUESS_SCHEMA : mode === "chat" ? CHAT_SCHEMA : OUTPUT_SCHEMA;
    const request = {
      systemInstruction: {
        parts: [
          {
            text:
              mode === "guess"
                ? GUESS_SYSTEM_PROMPT
                : mode === "chat"
                  ? CHAT_SYSTEM_PROMPT
                  : SYSTEM_PROMPT
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: toGeminiParts(prompt, payload.attachments)
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiSchema(schema)
      }
    };
    if (mode === "chat" && !payload.searchDisabled) {
      request.tools = [{ googleSearch: {} }];
    }
    const requestBody = JSON.stringify(request);
    if (Buffer.byteLength(requestBody, "utf8") >= MAX_GEMINI_REQUEST_BYTES) {
      const error = new Error("Gemini에 보낼 참고 자료가 너무 큽니다. 일부 첨부를 빼 주세요.");
      error.code = "GEMINI_REQUEST_TOO_LARGE";
      throw error;
    }
    const response = await fetchJson(
      this.fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: requestBody
      },
      mode === "chat" ? 60_000 : 35_000,
      payload.signal
    );
    const parsed = parseJsonText(extractGeminiText(response));
    if (mode === "guess") return normalizeGuess(parsed);
    if (mode === "chat") {
      const chatResult = normalizeChatResult(parsed);
      const sources = extractGeminiSources(response);
      return {
        ...chatResult,
        sources,
        webSearchUsed: geminiWebSearchUsed(response),
        relatedQueries: sources.length > 0 ? chatResult.relatedQueries : []
      };
    }
    return normalizeResult(parsed);
  }
}

module.exports = {
  AIClient,
  CHAT_SCHEMA,
  GEMINI_MODEL,
  MAX_WEB_SOURCES,
  MAX_GEMINI_REQUEST_BYTES,
  GUESS_SCHEMA,
  OPENAI_MODEL,
  OUTPUT_SCHEMA,
  buildGuessPrompt,
  buildSideChatPrompt,
  buildUserPrompt,
  hasExplicitLengthDirective,
  extractGeminiText,
  extractGeminiSources,
  extractOpenAIText,
  extractOpenAISources,
  geminiWebSearchUsed,
  openAIWebSearchUsed,
  normalizeWebSource,
  normalizeWebSources,
  normalizeGuess,
  normalizeChatResult,
  normalizeResult,
  parseJsonText,
  prepareChatPayload,
  toGeminiSchema,
  requiresWebSearch
};
