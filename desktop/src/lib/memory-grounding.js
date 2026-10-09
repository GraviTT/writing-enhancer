"use strict";

const { tokenize } = require("./memory-store");

const PERSISTENCE_CUE =
  /(?:앞으로|다음부터|항상|평소|기억해|기억해\s*줘|선호|원하(?:는|고|니|면)?|말투|스타일|작성\s*규칙|반드시)/iu;

function hasGrounding(candidate, evidence) {
  const cleanEvidence = String(evidence || "").trim();
  if (!cleanEvidence || !PERSISTENCE_CUE.test(cleanEvidence)) return false;
  const evidenceTokens = new Set(tokenize(cleanEvidence));
  const candidateTokens = tokenize(`${candidate?.value || ""} ${candidate?.scope || ""}`);
  const overlap = candidateTokens.filter((token) =>
    [...evidenceTokens].some(
      (evidenceToken) => evidenceToken.includes(token) || token.includes(evidenceToken)
    )
  );
  return overlap.length >= 2;
}

function groundMemoryCandidates(candidates, evidence) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, 3).map((candidate) => {
    if (!candidate || !["explicit", "repeated"].includes(candidate.source)) return candidate;
    if (hasGrounding(candidate, evidence)) {
      return { ...candidate, source: "explicit" };
    }
    return { ...candidate, source: "inferred" };
  });
}

module.exports = { PERSISTENCE_CUE, groundMemoryCandidates, hasGrounding };
