"use strict";

// 검색 판단 정규식과 동작 분류는 Windows·Android가 shared/rules에서 함께 쓴다.
const sideChatRules = require("../renderer/side-chat-rules");

const compile = (entry) => new RegExp(entry.pattern, `${entry.flags}u`);

// 검색 강제는 사용자가 웹 검색을 직접 요청한 경우에만 적용한다.
// 최신·가격·비교 같은 주제어만으로는 강제하지 않고 모델이 검색 도구를 판단한다.
const EXPLICIT_SEARCH_PATTERNS = Object.freeze(sideChatRules.search.explicitPatterns.map(compile));

// '찾아줘'·'알아봐'·'조사해'는 현재 글을 가리키지 않을 때만 웹 검색 요청으로 본다.
const GENERIC_FIND_PATTERN = compile(sideChatRules.search.genericFindPattern);
const LOCAL_TARGET_PATTERN = compile(sideChatRules.search.localTargetPattern);
const SEARCH_DISABLED_PATTERNS = Object.freeze(
  sideChatRules.search.disabledPatterns.map(compile)
);

// 프롬프트에 다시 넣는 최근 대화 수. 외부 자료 여부도 같은 범위에서 판단한다.
const CONTEXT_MESSAGE_LIMIT = sideChatRules.limits.contextMessages;

// 화면 이동만 하는 동작은 외부 자료가 있어도 바로 실행한다.
const NAVIGATION_ACTIONS = Object.freeze(new Set(sideChatRules.actions.navigation));

function cleanInput(input) {
  return String(input || "").replace(/\u0000/gu, " ").trim();
}

function messageHasExternalProvenance(message) {
  return Boolean(
    message?.role === "assistant" &&
      (message?.externalGrounding === true ||
        (Array.isArray(message?.sources) && message.sources.length > 0))
  );
}

// 대화 맥락은 항상 그대로 유지하고, 최근 대화에 검색·화면 자료가 있는지만 표시한다.
function prepareSideChatContext(_input, messages = []) {
  const candidates = Array.isArray(messages) ? messages : [];
  return {
    messages: candidates,
    priorExternalContext: candidates
      .slice(-CONTEXT_MESSAGE_LIMIT)
      .some(messageHasExternalProvenance)
  };
}

function explicitlyRequestsWebSearch(text) {
  if (EXPLICIT_SEARCH_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return GENERIC_FIND_PATTERN.test(text) && !LOCAL_TARGET_PATTERN.test(text);
}

function webSearchPolicy(input, { forceSearch = false } = {}) {
  const text = cleanInput(input);
  if (SEARCH_DISABLED_PATTERNS.some((pattern) => pattern.test(text))) return "disabled";
  if (forceSearch === true) return "required";
  if (text && explicitlyRequestsWebSearch(text)) return "required";
  return "auto";
}

function requiresWebSearch(input, options = {}) {
  return webSearchPolicy(input, options) === "required";
}

function hasWebSources(result) {
  return Array.isArray(result?.sources) && result.sources.length > 0;
}

function isExternallyGrounded(
  result,
  { screenContext = false, priorExternalContext = false } = {}
) {
  return (
    Boolean(screenContext) ||
    Boolean(priorExternalContext) ||
    result?.webSearchUsed === true ||
    hasWebSources(result)
  );
}

function actionNeedsConfirmation(action, externallyGrounded) {
  const name = String(action?.name || "none");
  return Boolean(externallyGrounded) && name !== "none" && !NAVIGATION_ACTIONS.has(name);
}

// 검색·화면 자료가 섞인 응답의 동작은 지우지 않고, 사용자 확인 뒤에만 실행하도록 표시한다.
function applyGroundingPolicy(result, context = {}) {
  if (!result || typeof result !== "object") return result;
  const externalGrounding = isExternallyGrounded(result, context);
  return {
    ...result,
    externalGrounding,
    actionRequiresConfirmation: actionNeedsConfirmation(result.action, externalGrounding)
  };
}

function createMissingSearchSourcesError() {
  const error = new Error("웹 검색 결과의 출처를 확인하지 못했습니다.");
  error.code = "SEARCH_SOURCES_MISSING";
  return error;
}

module.exports = {
  CONTEXT_MESSAGE_LIMIT,
  EXPLICIT_SEARCH_PATTERNS,
  NAVIGATION_ACTIONS,
  actionNeedsConfirmation,
  applyGroundingPolicy,
  createMissingSearchSourcesError,
  hasWebSources,
  isExternallyGrounded,
  messageHasExternalProvenance,
  prepareSideChatContext,
  requiresWebSearch,
  webSearchPolicy
};
