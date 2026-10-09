"use strict";

const EXPLICIT_SEARCH_PATTERNS = Object.freeze([
  /(?:웹\s*)?검색(?:해|해서|으로|해\s*줘|해줘|해\s*주세요|해주세요)?/iu,
  /찾아\s*(?:줘|주세요|봐|봐줘|봐\s*줘|주겠|줄래)/iu,
  /찾아\s*보(?:고|면|아서|고서)?/iu,
  /알아\s*(?:봐|봐줘|봐\s*줘|주세요)/iu,
  /조사\s*(?:해|해서|해\s*줘|해주세요|해봐|해\s*봐)/iu,
  /(?:웹|인터넷)(?:에서|으로)?\s*(?:검색|확인|찾아|조사)/iu,
  /(?:출처|근거|공식\s*(?:자료|문서|사이트))(?:를|와|과|도|까지|에)?\s*(?:함께|포함|제시|확인|알려|찾아|달아|줘)/iu,
  /사실\s*(?:확인|검증)|팩트\s*체크/iu,
  /\b(?:search(?:\s+for)?|look\s*up|fact[-\s]?check|verify)\b/iu,
  /\bfind\s+(?:me|out|information|info|sources?|the\s+latest|news|prices?|polic(?:y|ies)|recommendations?)\b/iu,
  /\b(?:research|investigate)\b/iu,
  /\b(?:check|search|look)\s+(?:online|the\s+web|the\s+internet)\b/iu,
  /\b(?:with|include|provide|cite)\s+(?:sources?|citations?|evidence|official\s+(?:sources?|documents?|docs?))\b/iu
]);

const LIVE_TOPIC_PATTERNS = Object.freeze([
  /최신/iu,
  /뉴스/iu,
  /가격|요금/iu,
  /정책|규정/iu,
  /비교/iu,
  /추천/iu,
  /오늘|현재|지금|최근|요즘|이번\s*(?:주|달|월|해|년)/iu,
  /날씨|기온|강수|미세먼지/iu,
  /환율|주가|금리|최저\s*임금/iu,
  /현직\s*(?:공직자|대통령|총리|장관|시장|도지사|의원|CEO|최고\s*경영자|대표\s*이사)|(?:CEO|최고\s*경영자|대표\s*이사)(?:가|는|은|이|\s|누구|어느)/iu,
  /(?:대통령|총리|장관|시장|도지사|의원|대표|CEO)(?:은|는|이|가|\s)*(?:누구|이름|어느\s*분)/iu,
  /일정|출시\s*(?:일|예정)|발매\s*(?:일|예정)|영업\s*시간|운영\s*시간|재고|품절|입고/iu,
  /(?:어제|오늘|이번|최근)\s*(?:경기|게임|시합)|(?:경기|게임|시합)\s*(?:결과|점수|스코어)/iu,
  /\b(?:latest|recent|recently|today|yesterday|currently|current|now|news|weather|forecast|temperature|exchange\s+rate|currency\s+rate|stock\s+(?:price|market)|interest\s+rate|minimum\s+wage|current\s+(?:president|prime\s+minister|minister|mayor|governor|senator|ceo)|(?:president|prime\s+minister|minister|mayor|governor|senator|ceo)\s+(?:name|who)|game\s+(?:result|score)|match\s+(?:result|score)|ceo|schedule|release\s+date|launch\s+date|business\s+hours|opening\s+hours|inventory|availability|in\s+stock|price|pricing|cost|policy|policies|compare|comparison|versus|vs\.?|recommend(?:ation|ations|ed|ing)?)\b/iu
]);

const LOCAL_WRITING_OR_APP_PATTERN =
  /(?:원문|초안|문장|문구|글|결과|제목|문체|말투).*(?:다듬|수정|고쳐|바꿔|작성|써\s*줘|복사|강화|비교|추천)|(?:설정|기록|히스토리|기억|강화\s*범위|새\s*글|검색\s*기능).*(?:열어|보여|바꿔|이동|수정|개선)|\b(?:rewrite|write|compose|edit|polish|revise|draft|copy|enhance|open\s+(?:settings|history))\b/iu;

const LOCAL_EDIT_OR_APP_PATTERN =
  /(?:현재\s*)?(?:원문|초안|문장|문구|글|결과|제목|문체|말투).*(?:다듬|수정|고쳐|바꿔|작성|복사|강화|비교|추천)|(?:설정|기록|히스토리|기억|강화\s*범위|새\s*글).*(?:열어|보여|바꿔|이동|수정)|\b(?:(?:rewrite|edit|polish|revise|copy|enhance)\s+(?:this|the\s+current)\s+(?:draft|text|sentence|result)|open\s+(?:settings|history))\b/iu;

const LOCAL_SEARCH_FEATURE_PATTERN =
  /검색\s*(?:(?:기능|창|버튼|화면|모드|버튼\s*문구).*(?:열어|보여|바꿔|이동|수정|개선|고쳐|다듬|설명|사용|쓰는\s*법|어떻게|동작|작동|오류)|어(?:를|가)?\s*.*(?:수정|고쳐|바꿔|다듬))/iu;

const SEARCH_DISABLED_PATTERN =
  /(?:웹\s*|인터넷\s*)?검색(?:은|을|도)?\s*(?:(?:하지|하면)\s*(?:말(?:고|아|라)|마(?:세요)?|않아도)|말(?:고|아|라)|마(?:세요)?|없이|금지)|(?:웹|인터넷)(?:은|을)?\s*(?:보지|찾지|확인하지)\s*말(?:고|아|라)|\b(?:do\s+not|don't|dont|never)\s+(?:search|browse)(?:\s+(?:the\s+)?(?:web|internet))?|\b(?:without|no)\s+(?:searching|browsing|web\s+search(?:ing)?)\b/iu;

const LOCAL_VIEW_PATTERN =
  /(?:현재|지금|방금)\s*(?:(?:작성|쓰|입력)(?:\s*중인|\s*한|\s*하는|\s*하고\s*있는|\s*고\s*있는|\s*해\s*둔)?\s*)?(?:글|내용|초안|원문|결과)(?:을|를|이|가)?\s*(?:보여|알려|읽어|확인|요약)/iu;

const EXTERNAL_REFERENCE_PATTERN =
  /(?:그대로|그\s*(?:내용|답변|결과|자료|정보|것|걸)|이\s*(?:내용|답변|결과|자료|정보|것|걸)|위\s*(?:내용|답변|결과|자료|정보)|앞서|방금\s*(?:답한|말한)|직전|아까|찾아본|찾은|검색(?:한|해\s*준|한\s*결과)|화면(?:의|에서|에\s*나온|\s*내용)|답변(?:을|대로)|검색\s*결과|(?:그\s*)?(?:둘|셋)(?:은|는|이|가|을|를|과|와|의|도|중|사이)?|(?:두|세)\s*(?:가지|개|대상|물질|제품)(?:은|는|이|가|을|를|과|와|의|도|중|사이)?|양쪽|이들|그들|각각|서로|전(?:자|자는|자의|자와)|후(?:자|자는|자의|자와)|앞의|뒤의|나머지|(?:그|이)\s*중|어느\s*(?:쪽|것))|\b(?:that|those|both|the\s+(?:two|answer|result|search\s+result|screen\s+content)|these|them|each|respectively|former|latter|which\s+(?:one|of\s+them)|above|previous\s+(?:answer|result)|what\s+you\s+found)\b/iu;

const EXTERNAL_DISCARD_PATTERN =
  /(?:검색\s*결과|화면\s*내용|이전\s*답변|위\s*내용|그\s*내용).*(?:무시|제외|말고|쓰지\s*마|반영하지\s*마)|\b(?:ignore|exclude|do\s+not\s+use)\s+(?:that|the\s+(?:search\s+result|screen\s+content|previous\s+answer))\b/iu;

const INDEPENDENT_LOCAL_PATTERN =
  /(?:설정|기록|히스토리|기억|도구)(?:을|를|이|가)?\s*(?:열어|보여|알려)|(?:현재|지금)\s*(?:원문|초안|글|결과|상황).*(?:다듬|수정|고쳐|바꿔|복사|강화|보여|읽어|요약)|새\s*(?:글|채팅|대화)(?:을|를)?\s*(?:시작|열어|만들)|강화\s*범위.*(?:설정|바꿔|올려|내려)|\b(?:open\s+(?:settings|history|memories|tools)|start\s+(?:a\s+)?new\s+(?:writing|chat)|(?:edit|polish|copy|show)\s+(?:the\s+)?current\s+(?:draft|text|result))\b/iu;

const CONTINUATION_TRANSFORM_PATTERN =
  /^(?:좀|조금|더|다시|핵심만|짧게|길게|간단히|자세히)?\s*(?:요약|정리|설명|다듬|고쳐|바꿔|번역|비교|계속|이어|알려|보여|반영|적용|삽입|넣어|옮겨|복사|작성|완성)|\b(?:summarize|shorten|expand|explain|rewrite|translate|continue|apply|insert|copy|use\s+it|tell\s+me\s+more)\b/iu;

const EXTERNAL_APPLY_PATTERN =
  /(?:반영|적용|삽입|붙여\s*넣|넣어|옮겨|복사해|교체|덮어|원문(?:으로|을|에).*(?:바꿔|써|사용|넣)|결과(?:로|를|에).*(?:바꿔|써|사용|넣)|상황(?:으로|을|에).*(?:설정|바꿔|넣)|글(?:을|로)?\s*(?:작성|완성|만들)|초안(?:을|으로)?\s*(?:작성|완성|만들)|그대로\s*(?:해|써))|\b(?:apply|insert|copy|move|put|use)\s+(?:that|it|the\s+(?:answer|result|content)).*(?:draft|text|result|writing)|\b(?:replace|overwrite)\s+(?:the\s+)?(?:draft|text|result)\b/iu;

const EXTERNAL_APPLY_BLOCK_REPLY =
  "검색이나 현재 화면에서 가져온 내용은 안전을 위해 글 강화기에 직접 반영할 수 없어요. 필요한 문장을 직접 입력하거나 붙여넣어 확인한 뒤 다시 요청해 주세요.";

function messageHasExternalProvenance(message) {
  return Boolean(
    message?.role === "assistant" &&
      (message?.externalGrounding === true ||
        (Array.isArray(message?.sources) && message.sources.length > 0))
  );
}

function hasDirectUserMaterial(input) {
  const text = String(input || "").replace(/\u0000/gu, " ").trim();
  const isSubstantialMaterial = (value) => {
    const material = String(value || "").replace(/\s+/gu, " ").trim();
    if (material.length < 16) return false;
    if (
      EXTERNAL_REFERENCE_PATTERN.test(material) &&
      EXTERNAL_APPLY_PATTERN.test(material)
    ) {
      return false;
    }
    return true;
  };
  const colon = text.match(/[:：]\s*([\s\S]+)$/u)?.[1] || "";
  if (isSubstantialMaterial(colon)) return true;
  const lines = text.split(/\r?\n/u);
  if (lines.length > 1 && isSubstantialMaterial(lines.slice(1).join("\n"))) return true;
  const quoted = text.match(/["“‘']([^"”’']+)["”’']/u)?.[1] || "";
  if (isSubstantialMaterial(quoted)) return true;
  const fenced = text.match(/```([\s\S]+)```/u)?.[1] || "";
  return isSubstantialMaterial(fenced);
}

function prepareSideChatContext(input, messages = []) {
  const text = String(input || "").replace(/\u0000/gu, " ").trim();
  const candidates = Array.isArray(messages) ? messages : [];
  let lastExternalIndex = -1;
  let latestAssistantIndex = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index]?.role === "assistant") latestAssistantIndex = index;
    if (messageHasExternalProvenance(candidates[index])) lastExternalIndex = index;
  }
  if (lastExternalIndex < 0) {
    return {
      messages: candidates,
      priorExternalContext: false,
      externalApplyIntent: false
    };
  }

  const directMaterial = hasDirectUserMaterial(text);
  const discardsExternal = EXTERNAL_DISCARD_PATTERN.test(text);
  const explicitReference = EXTERNAL_REFERENCE_PATTERN.test(text);
  const latestAssistantExternal =
    latestAssistantIndex >= 0 && messageHasExternalProvenance(candidates[latestAssistantIndex]);
  const independentLocal = INDEPENDENT_LOCAL_PATTERN.test(text);
  const implicitContinuation =
    latestAssistantExternal &&
    !independentLocal &&
    (CONTINUATION_TRANSFORM_PATTERN.test(text) || EXTERNAL_APPLY_PATTERN.test(text));
  const priorExternalContext =
    !directMaterial && !discardsExternal && (explicitReference || implicitContinuation);

  return {
    messages: priorExternalContext ? candidates : candidates.slice(lastExternalIndex + 1),
    priorExternalContext,
    externalApplyIntent:
      priorExternalContext && EXTERNAL_APPLY_PATTERN.test(text)
  };
}

function webSearchPolicy(input, { screenContext = false, forceSearch = false } = {}) {
  const text = String(input || "").replace(/\u0000/gu, " ").trim();
  if (SEARCH_DISABLED_PATTERN.test(text)) return "disabled";
  if (screenContext || forceSearch === true) return "required";
  if (!text || LOCAL_SEARCH_FEATURE_PATTERN.test(text) || LOCAL_VIEW_PATTERN.test(text)) return "auto";
  if (EXPLICIT_SEARCH_PATTERNS.some((pattern) => pattern.test(text))) return "required";
  if (/\bfind\b/iu.test(text) && !LOCAL_WRITING_OR_APP_PATTERN.test(text)) return "required";
  const liveTopicCount = LIVE_TOPIC_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0
  );
  if (liveTopicCount === 0) return "auto";
  if (LOCAL_EDIT_OR_APP_PATTERN.test(text)) return "auto";
  if (LOCAL_WRITING_OR_APP_PATTERN.test(text) && liveTopicCount < 2) return "auto";
  return "required";
}

function requiresWebSearch(input, { screenContext = false } = {}) {
  return webSearchPolicy(input, { screenContext }) === "required";
}

function hasWebSources(result) {
  return Array.isArray(result?.sources) && result.sources.length > 0;
}

function groundedActionBlocked(
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

function enforceGroundedAction(
  result,
  {
    screenContext = false,
    priorExternalContext = false,
    externalApplyIntent = false
  } = {}
) {
  if (!result || typeof result !== "object") return result;
  if (priorExternalContext && externalApplyIntent) {
    return {
      ...result,
      reply: EXTERNAL_APPLY_BLOCK_REPLY,
      action: { name: "none", value: "" },
      relatedQueries: []
    };
  }
  if (!groundedActionBlocked(result, { screenContext, priorExternalContext })) return result;
  return {
    ...result,
    action: { name: "none", value: "" }
  };
}

function createMissingSearchSourcesError() {
  const error = new Error("웹 검색 결과의 출처를 확인하지 못했습니다.");
  error.code = "SEARCH_SOURCES_MISSING";
  return error;
}

module.exports = {
  EXTERNAL_APPLY_BLOCK_REPLY,
  EXPLICIT_SEARCH_PATTERNS,
  LIVE_TOPIC_PATTERNS,
  createMissingSearchSourcesError,
  enforceGroundedAction,
  groundedActionBlocked,
  hasDirectUserMaterial,
  hasWebSources,
  messageHasExternalProvenance,
  prepareSideChatContext,
  requiresWebSearch,
  webSearchPolicy
};
