export type SensitiveCategory =
  | "credential"
  | "api_key"
  | "resident_id"
  | "passport_or_license"
  | "payment_card"
  | "bank_account"
  | "phone"
  | "email"
  | "address"
  | "medical"
  | "financial";

export interface SensitiveMatch {
  category: SensitiveCategory;
  value: string;
  index: number;
}

interface PatternDefinition {
  category: SensitiveCategory;
  pattern: RegExp;
}

const PATTERNS: readonly PatternDefinition[] = [
  {
    category: "credential",
    pattern:
      /(?:비밀번호|암호|패스워드|password|passwd|pwd|PIN|OTP|인증번호|일회용\s*코드)\s*[:：=]?\s*[^\s,;]+/i,
  },
  {
    category: "api_key",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|(?:api[_ -]?key|secret)\s*[:=]\s*[A-Za-z0-9_./+-]{12,})\b/i,
  },
  {
    category: "resident_id",
    pattern: /\b\d{6}\s*-\s*[1-4]\d{6}\b/,
  },
  {
    category: "passport_or_license",
    pattern:
      /(?:여권번호|운전면허번호|passport|driver'?s?\s*licen[cs]e)\s*[:：=]?\s*[A-Z0-9-]{6,20}/i,
  },
  {
    category: "bank_account",
    pattern:
      /(?:계좌(?:번호)?|account(?:\s*number)?)\s*[:：=]?\s*\d(?:[\d -]{6,20}\d)/i,
  },
  {
    category: "phone",
    pattern: /(?:\+82[- ]?|0)1[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/,
  },
  {
    category: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    category: "address",
    pattern:
      /(?:주소|거주지)\s*[:：=]?\s*(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n,;]{4,80}/i,
  },
  {
    category: "medical",
    pattern:
      /(?:진단명|병력|복용약|처방|질병|질환|수술\s*이력)\s*[:：=]?\s*[^\n,;]{1,80}/i,
  },
  {
    category: "financial",
    pattern:
      /(?:연봉|소득|자산|부채|신용점수|대출잔액)\s*[:：=]?\s*[^\n,;]{1,80}/i,
  },
] as const;

function findAll(pattern: RegExp, input: string): RegExpMatchArray[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...input.matchAll(new RegExp(pattern.source, flags))];
}

function luhnIsValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function findPaymentCards(input: string): SensitiveMatch[] {
  const matches = input.matchAll(/\b(?:\d[ -]*?){13,19}\b/g);
  const results: SensitiveMatch[] = [];
  for (const match of matches) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnIsValid(digits)) {
      results.push({
        category: "payment_card",
        value: raw,
        index: match.index,
      });
    }
  }
  return results;
}

export function detectSensitiveInfo(input: string): SensitiveMatch[] {
  const matches = PATTERNS.flatMap(({ category, pattern }) =>
    findAll(pattern, input).map((match) => ({
      category,
      value: match[0],
      index: match.index ?? 0,
    })),
  );
  matches.push(...findPaymentCards(input));

  return matches.sort((left, right) => left.index - right.index);
}

export function containsSensitiveInfo(input: string): boolean {
  return detectSensitiveInfo(input).length > 0;
}

export function redactSensitiveInfo(input: string): string {
  const matches = detectSensitiveInfo(input).sort(
    (left, right) => right.index - left.index,
  );
  let redacted = input;
  for (const match of matches) {
    redacted =
      redacted.slice(0, match.index) +
      `[${match.category}:숨김]` +
      redacted.slice(match.index + match.value.length);
  }
  return redacted;
}

export function isMemorySafe(
  value: string,
  scope = "",
  keywords: readonly string[] = [],
): boolean {
  return !containsSensitiveInfo([value, scope, ...keywords].join("\n"));
}
