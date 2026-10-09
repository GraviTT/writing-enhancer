// 사이드 채팅 답변 처리. Android의 ChatAnswer.kt와 같은 규칙이며 shared/rules의 공통 사례로 함께 검사한다.
//  - 스트리밍 중 보여 줄 글과 답변 끝 제어 블록 분리
//  - 요청 분류(앱 조작·웹 조사·글 상담)
//  - 출처 표시를 문장 링크로 바꾸고 굵게·코드 서식을 위치와 함께 정리
(function exposeChatAnswer(root, factory) {
  "use strict";

  const rules =
    typeof module === "object" && module.exports ? require("./side-chat-rules") : root.sideChatRules;
  const api = factory(rules);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.chatAnswer = api;
})(typeof globalThis === "object" ? globalThis : this, (rules) => {
  "use strict";

  const FENCE = `\`\`\`${rules.control.fence}`;
  const ACTION_NAMES = new Set(rules.actions.names);
  const ROLES = new Set(rules.control.roles);
  const { limits, labels } = rules;

  const TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "…"]);
  const MARKER = /^\(?(?:\[[^\]\n]{1,180}\]\(https?:\/\/[^\s)]+\)|https?:\/\/\S+|[\w.-]+\.[a-z]{2,})\)?$/iu;
  const MARKDOWN_LINK = /\[([^\]\n]{1,180})\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gu;
  const BARE_URL = /https?:\/\/[^\s<>()[\]{}]+/gu;
  const MARKUP = /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*|^#{1,3} ([^\n]+)$/dgmu;
  const BULLET = /^(?:[-*•]|\d{1,2}[.)])\s+/u;

  const isSpace = (char) => char !== undefined && /\s/u.test(char);
  const clean = (value) => String(value ?? "").replace(/\u0000/gu, "");

  // 스트리밍 중에는 제어 블록과, 제어 블록 시작이 잘려 들어온 꼬리를 보여 주지 않는다.
  function visibleStreamText(accumulated) {
    const text = clean(accumulated);
    const fence = text.indexOf(FENCE);
    if (fence >= 0) return text.slice(0, fence).trimEnd();
    for (let length = Math.min(FENCE.length - 1, text.length); length > 0; length -= 1) {
      if (text.endsWith(FENCE.slice(0, length))) return text.slice(0, text.length - length);
    }
    return text;
  }

  function parseLooseJson(body) {
    try {
      return JSON.parse(body.trim());
    } catch {
      const start = body.indexOf("{");
      const end = body.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  function normalizeAction(value) {
    const name = ACTION_NAMES.has(value?.name) ? value.name : "none";
    if (name === "none") return { name, value: "" };
    return { name, value: clean(value?.value).slice(0, limits.actionValueCharacters) };
  }

  function normalizeQueries(values) {
    const queries = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      if (typeof value !== "string") continue;
      const query = clean(value).trim().slice(0, limits.relatedQueryCharacters);
      const key = query.toLowerCase();
      if (!query || seen.has(key)) continue;
      seen.add(key);
      queries.push(query);
      if (queries.length >= limits.relatedQueries) break;
    }
    return queries;
  }

  // 답변 끝의 ```app-control 블록에서 분류·동작·후속 질문을 읽는다. 블록이 없거나 깨져도 답변은 살린다.
  // answerOffset: 답변 앞에서 잘라 낸 공백 수. 원래 글 기준 인용 위치를 답변 기준으로 옮길 때 쓴다.
  function parseControlBlock(full) {
    const text = clean(full);
    const fence = text.lastIndexOf(FENCE);
    const head = fence < 0 ? text : text.slice(0, fence);
    const trimmedStart = head.trimStart();
    const answer = trimmedStart.trimEnd();
    const answerOffset = head.length - trimmedStart.length;
    if (fence < 0) {
      return { answer, answerOffset, role: "", action: normalizeAction(null), relatedQueries: [] };
    }
    let body = text.slice(fence + FENCE.length);
    const close = body.indexOf("```");
    if (close >= 0) body = body.slice(0, close);
    const control = parseLooseJson(body) || {};
    return {
      answer,
      answerOffset,
      role: ROLES.has(control.role) ? control.role : "",
      action: normalizeAction(control.action),
      relatedQueries: normalizeQueries(control.related_queries)
    };
  }

  function finalRole(parsedRole, actionName, hasSources) {
    if (actionName && actionName !== "none") return "command";
    if (hasSources || parsedRole === "research") return "research";
    return "writing";
  }

  function roleLabel(role, hasSources) {
    if (role === "command") return labels.roles.command;
    if (role === "research") {
      return hasSources ? labels.roles.research : labels.roles.researchWithoutSources;
    }
    return labels.roles.writing;
  }

  // 정렬되고 겹치지 않는 편집을 적용하고, 원래 위치를 새 위치로 옮기는 함수를 함께 돌려준다.
  function applyEdits(text, edits) {
    let output = "";
    let cursor = 0;
    const applied = [];
    for (const edit of edits) {
      output += text.slice(cursor, edit.start);
      const outStart = output.length;
      output += edit.replacement;
      applied.push({ ...edit, outStart, outEnd: output.length });
      cursor = edit.end;
    }
    output += text.slice(cursor);
    const map = (index, bias) => {
      let delta = 0;
      for (const edit of applied) {
        if (edit.end <= index) {
          delta += edit.replacement.length - (edit.end - edit.start);
        } else if (edit.start < index) {
          return bias === "end" ? edit.outEnd : edit.outStart;
        } else {
          break;
        }
      }
      return index + delta;
    };
    return { text: output, map };
  }

  const overlaps = (start, end, ranges) =>
    ranges.some((range) => start < range.end && range.start < end);

  // 주소의 사이트 이름(소문자, www. 제외). 두 앱이 같은 결과를 내도록 URL 해석기 대신 직접 읽는다.
  function hostOf(url) {
    const match = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)/iu.exec(String(url ?? "").trim());
    return match ? match[1].toLowerCase().replace(/^www\./u, "") : "";
  }

  function hostLabel(url) {
    const host = hostOf(url.replace(/[.,;:!?)]+$/u, ""));
    return host ? `[${host}]` : "[출처]";
  }

  // 출처 표시 바로 앞의 문장 범위. 목록 기호와 앞뒤 공백은 링크에서 뺀다.
  function sentenceBefore(text, anchor) {
    let end = Math.min(anchor, text.length);
    while (end > 0 && isSpace(text[end - 1])) end -= 1;
    if (end === 0) return null;
    let start = 0;
    for (let index = end - 2; index >= 0; index -= 1) {
      const char = text[index];
      if (char === "\n") {
        start = index + 1;
        break;
      }
      if (TERMINATORS.has(char) && isSpace(text[index + 1])) {
        start = index + 1;
        break;
      }
    }
    while (start < end && isSpace(text[start])) start += 1;
    const bullet = BULLET.exec(text.slice(start, end));
    if (bullet) start += bullet[0].length;
    return start < end ? { start, end } : null;
  }

  function trimRange(text, start, end) {
    let from = start;
    let to = end;
    while (from < to && isSpace(text[from])) from += 1;
    while (to > from && isSpace(text[to - 1])) to -= 1;
    return from < to ? { start: from, end: to } : null;
  }

  function addCitation(citations, range, sources) {
    if (!range) return;
    const existing = citations.find((item) => item.start === range.start && item.end === range.end);
    const target = existing || { start: range.start, end: range.end, sources: [] };
    for (const source of sources) if (!target.sources.includes(source)) target.sources.push(source);
    if (!existing) citations.push(target);
  }

  function mergeCitations(citations) {
    const sorted = [...citations].sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const citation of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && citation.start < previous.end) {
        previous.end = Math.max(previous.end, citation.end);
        for (const source of citation.sources) {
          if (!previous.sources.includes(source)) previous.sources.push(source);
        }
      } else {
        merged.push({ start: citation.start, end: citation.end, sources: [...citation.sources] });
      }
    }
    return merged;
  }

  /**
   * 답변 글을 화면용으로 정리한다.
   * annotations: [{ start, end, source }] — 원래 답변 글 기준 위치와 출처 번호.
   * 링크 모양의 출처 표시는 지우고 바로 앞 문장에 출처를 연결하며, 일반 글 범위는 그대로 연결한다.
   * cleanLinks가 true면(검색·화면 답변) 남은 마크다운 링크는 제목만, 맨 URL은 [도메인]으로 줄인다.
   */
  function formatAnswer(raw, annotations = [], { cleanLinks = false } = {}) {
    const source = clean(raw);
    const valid = (Array.isArray(annotations) ? annotations : []).filter(
      (item) =>
        Number.isInteger(item?.start) &&
        Number.isInteger(item?.end) &&
        Number.isInteger(item?.source) &&
        item.source >= 0 &&
        item.start >= 0 &&
        item.end <= source.length &&
        item.start < item.end
    );

    const markers = [];
    const spans = [];
    for (const item of valid) {
      if (MARKER.test(source.slice(item.start, item.end).trim())) {
        let start = item.start;
        let end = item.end;
        if (source[start] !== "(" && source[start - 1] === "(" && source[end] === ")") {
          start -= 1;
          end += 1;
        }
        if (source[start - 1] === " ") start -= 1;
        markers.push({ start, end, source: item.source });
      } else {
        spans.push(item);
      }
    }

    const removals = [];
    for (const marker of [...markers].sort((left, right) => left.start - right.start)) {
      const previous = removals[removals.length - 1];
      if (previous && marker.start <= previous.end) previous.end = Math.max(previous.end, marker.end);
      else removals.push({ start: marker.start, end: marker.end, replacement: "" });
    }
    const linkEdits = [];
    if (cleanLinks) {
      for (const match of source.matchAll(MARKDOWN_LINK)) {
        const start = match.index;
        const end = start + match[0].length;
        if (!overlaps(start, end, removals)) linkEdits.push({ start, end, replacement: match[1] });
      }
      for (const match of source.matchAll(BARE_URL)) {
        const start = match.index;
        const end = start + match[0].length;
        if (!overlaps(start, end, removals) && !overlaps(start, end, linkEdits)) {
          linkEdits.push({ start, end, replacement: hostLabel(match[0]) });
        }
      }
    }
    const firstPass = applyEdits(
      source,
      [...removals, ...linkEdits].sort((left, right) => left.start - right.start)
    );

    const citations = [];
    for (const marker of markers) {
      const anchor = firstPass.map(marker.start, "start");
      addCitation(citations, sentenceBefore(firstPass.text, anchor), [marker.source]);
    }
    for (const span of spans) {
      addCitation(
        citations,
        trimRange(firstPass.text, firstPass.map(span.start, "start"), firstPass.map(span.end, "end")),
        [span.source]
      );
    }

    const styleEdits = [];
    const styleRanges = [];
    for (const match of firstPass.text.matchAll(MARKUP)) {
      const group = [1, 2, 3, 4].find((index) => match[index] !== undefined);
      const [contentStart, contentEnd] = match.indices[group];
      const matchEnd = match.index + match[0].length;
      styleEdits.push({ start: match.index, end: contentStart, replacement: "" });
      if (matchEnd > contentEnd) styleEdits.push({ start: contentEnd, end: matchEnd, replacement: "" });
      styleRanges.push({ start: contentStart, end: contentEnd, kind: group <= 2 ? "code" : "bold" });
    }
    const secondPass = applyEdits(firstPass.text, styleEdits);
    // 지운 표시 때문에 앞뒤에 남은 공백을 덜어 내고 위치도 함께 옮긴다. 저장할 때 다시 잘라도 어긋나지 않는다.
    let lead = 0;
    while (lead < secondPass.text.length && isSpace(secondPass.text[lead])) lead += 1;
    let tail = secondPass.text.length;
    while (tail > lead && isSpace(secondPass.text[tail - 1])) tail -= 1;
    const text = secondPass.text.slice(lead, tail);
    const place = (start, end) => ({
      start: Math.max(0, secondPass.map(start, "start") - lead),
      end: Math.min(text.length, secondPass.map(end, "end") - lead)
    });
    const styles = styleRanges
      .map((range) => ({ ...place(range.start, range.end), kind: range.kind }))
      .filter((range) => range.start < range.end);
    const mappedCitations = mergeCitations(
      citations
        .map((citation) => ({ ...place(citation.start, citation.end), sources: citation.sources }))
        .filter((citation) => citation.start < citation.end)
    );
    return { text, citations: mappedCitations, styles };
  }

  return {
    FENCE,
    finalRole,
    formatAnswer,
    hostOf,
    parseControlBlock,
    roleLabel,
    sentenceBefore,
    visibleStreamText
  };
});
