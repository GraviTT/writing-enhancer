"use strict";

// 검색 강제는 사용자가 웹 검색을 직접 요청한 경우에만 적용한다.
// 최신·가격·비교 같은 주제어만으로는 강제하지 않고 모델이 검색 도구를 판단한다.
const EXPLICIT_SEARCH_PATTERNS = Object.freeze([
  /검색\s*(?:좀\s*)?(?:해|하고|하여|부탁|요청)/iu,
  /(?:웹|인터넷)(?:에서|으로)?\s*(?:검색|확인|찾아|조사|알아)/iu,
  /(?:출처|근거|공식\s*(?:자료|문서|사이트))(?:를|와|과|도|까지|에)?\s*(?:함께|포함|제시|확인|알려|찾아|달아|줘)/iu,
  /사실\s*(?:확인|검증)|팩트\s*체크/iu,
  /\b(?:search(?:\s+for)?|look\s*up|fact[-\s]?check)\b/iu,
  /\bfind\s+(?:me|out|information|info|(?:official\s+)?(?:sources?|docs?|documents?)|the\s+latest|news|prices?|polic(?:y|ies)|recommendations?)\b/iu,
  /\b(?:research|investigate)\b/iu,
  /\b(?:check|search|look)\s+(?:online|the\s+web|the\s+internet)\b/iu,
  /\b(?:with|include|provide|cite)\s+(?:sources?|citations?|evidence|official\s+(?:sources?|documents?|docs?))\b/iu
]);

// '찾아줘'·'알아봐'·'조사해'는 현재 글을 가리키지 않을 때만 웹 검색 요청으로 본다.
const GENERIC_FIND_PATTERN =
  /찾아\s*(?:줘|주세요|봐|봐줘|볼래|줄래|보고|봐서)|알아\s*(?:봐|봐줘|봐\s*줘|봐주세요|보고)|조사\s*(?:해|해서|해\s*줘|해주세요|해봐|해\s*봐)/iu;

const LOCAL_TARGET_PATTERN =
  /원문|초안|본문|문장|문구|글(?:에서|의|을|를|에)|결과(?:에서|의|를)|제목|이\s*(?:글|문장|내용|메일|문서)|오타|맞춤법|띄어쓰기|어색한|틀린/iu;

const SEARCH_DISABLED_PATTERN =
  /(?:웹\s*|인터넷\s*)?검색(?:은|을|도)?\s*(?:(?:하지|하면)\s*(?:말(?:고|아|라)|마(?:세요)?|않아도)|말(?:고|아|라)|마(?:세요)?|없이|금지)|(?:웹|인터넷)(?:은|을)?\s*(?:보지|찾지|확인하지)\s*말(?:고|아|라)|\b(?:do\s+not|don't|dont|never)\s+(?:search|browse)(?:\s+(?:the\s+)?(?:web|internet))?|\b(?:without|no)\s+(?:searching|browsing|web\s+search(?:ing)?)\b/iu;

// 프롬프트에 다시 넣는 최근 대화 수. 외부 자료 여부도 같은 범위에서 판단한다.
const CONTEXT_MESSAGE_LIMIT = 20;

// 화면 이동만 하는 동작은 외부 자료가 있어도 바로 실행한다.
const NAVIGATION_ACTIONS = Object.freeze(
  new Set([
    "show_writing",
    "focus_source",
    "open_history",
    "open_settings",
    "open_memories",
    "open_tools",
    "previous_result",
    "next_result"
  ])
);

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
  if (SEARCH_DISABLED_PATTERN.test(text)) return "disabled";
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
