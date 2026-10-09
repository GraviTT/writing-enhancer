# Writing Enhancer Shared

## 사이드 채팅 공통 규칙 (`rules/`)

Windows와 Android 앱의 사이드 채팅은 아래 두 파일을 함께 씁니다. 사이드 채팅의
지시문·요청 틀·응답 형식·검색 판단 정규식·화면 문구는 **여기서만 고칩니다.**

| 파일 | 내용 |
|---|---|
| `rules/side-chat-rules.json` | 시스템 지시문, 요청 글 틀, 답변 형식(일반 글 + 끝의 `app-control` 제어 블록), 검색 강제·금지 정규식, 동작 이름·분류, 진행 표시·적용 카드·출처 확인 창 문구, 각종 한도 |
| `rules/side-chat-cases.json` | 두 앱 테스트가 똑같이 통과해야 하는 사례 (검색 판단, 적용 확인, 문구, 요청 글, 스트리밍 표시, 제어 블록 읽기, 요청 분류, 답변 서식·문장 출처 위치) |

고친 뒤에는 이 폴더에서 다음을 실행합니다.

```bash
npm run rules
```

그러면 `scripts/generate-rules.cjs`가 다음 파일을 다시 만듭니다. 이 파일들은 직접 고치지 않습니다.

- `desktop/src/renderer/side-chat-rules.js` — Windows 앱이 읽는 규칙
- `android/app/src/main/java/com/example/writingenhancer/ai/SharedSideChatRules.kt` — Android 앱이 읽는 규칙
- `android/app/src/test/java/com/example/writingenhancer/ai/SharedSideChatCases.kt` — Android 테스트용 사례.
  요청 글 기대값은 Windows 구현으로 만들어, Android가 **글자 단위로 같은 요청**을 보내는지 확인합니다.

답변 처리 규칙의 구현은 Windows `desktop/src/renderer/chat-answer.js`와 Android `ai/ChatAnswer.kt` 두 곳에
있으며, 위 공통 사례로 같은 결과를 내는지 검사합니다. 한쪽을 고치면 다른 쪽도 함께 고칩니다.

`npm test`는 생성 파일이 원본과 같은지도 검사합니다(`npm run rules:check`). 규칙만 고치고
생성을 잊으면 이 검사와 GitHub의 자동 검사가 실패합니다.

글 강화(완성본 만들기) 프롬프트는 두 앱의 결과가 이미 안정적이어서 이번에는 합치지 않았습니다.
합치면 한쪽 앱의 글 강화 결과가 달라지므로, 결과 비교 테스트를 먼저 마련한 뒤 진행합니다.

## TypeScript 공통 계약

데스크톱과 모바일이 같은 행동을 하도록 묶은 TypeScript 공통 계층입니다.

- `EnhancementResult`: `completed_text`를 첫 결과로 강제하는 provider-neutral 계약
- `GuessFirstResult`: `guess_first`에서 추천 답이 포함된 질문 하나만 허용하는 계약
- `SYSTEM_PROMPT`: 완성 먼저·질문 나중·`알아서`·사실 잠금
- `ReferenceAttachment`: 파일/이미지/스크린샷의 메타데이터와 안전하게 정제할 콘텐츠
- `WritingRequestV2`, `HistoryEntry`, `HistoryVersion`, `WritingDraft`,
  `MemoryEditCommand`: 공통 요청·히스토리·재강화/되돌리기·임시 저장·기억 편집 계약
- 기억 정책: 세션/임시/장기 카드, 병합·충돌 대체·감쇠·상위 5개 검색·전체 50개 예산
- 민감정보 필터: 인증정보, API 키, 주요 식별·연락·의료·금융정보 저장 차단
- OpenAI Responses API / Gemini `generateContent` 텍스트·이미지 요청 매퍼
- 실제 API 키가 필요 없는 한국어 fixture 및 mock 응답 테스트

## 사용

```bash
npm install
npm test
```

앱에서는 먼저 `retrieveMemories()`로 관련 카드만 최대 5개 가져온 뒤
`mapOpenAIRequest()` 또는 `mapGeminiRequest()`에 넘깁니다. 응답의
`memory_candidates`는 반드시 `saveMemory()`를 거쳐야 하며, 모델 결과를
직접 영구 저장하면 안 됩니다.

`mode`를 생략하면 기존처럼 `enhance`가 적용됩니다. 사용자가 명시적으로
‘알아맞춰 봐’를 시작할 때만 `mode: "guess_first"`를 넘기고,
`extractOpenAIWritingResult()` 또는 `extractGeminiWritingResult()`에도 같은
mode를 전달합니다.

플랫폼의 snake_case 요청은 `writingRequestToPromptContext()` 하나로만
provider 옵션에 변환합니다. 첫 질문의 답을 받은 뒤에는
`buildGuessFirstContinuation()`으로 `enhance` 요청을 만들며, “알아서”,
“몰라”, 빈 답은 계약의 `recommended_answer`로 해석됩니다. 질문 대기 중인
초안은 `pending_guess`에 저장합니다.

## 첨부 정책

- 요청당 최대 5개, 그중 이미지/스크린샷은 최대 4개
- 파일 최대 10 MiB, 이미지 최대 5 MiB, 요청 전체 최대 20 MiB
- 추출문은 항목당 20,000자, 요청 전체 50,000자
- 문서는 원본 binary 대신 `extracted_text`만 전달
- 이미지는 JPEG/PNG/WebP base64만 허용하며 URL, SVG, 크기 불일치를 거부
- MIME과 실제 JPEG/PNG/WebP magic byte가 다르면 거부
- `prepareAttachments()`가 제어·bidi 문자를 제거하고, 두 제공자 매퍼가
  콘텐츠를 `UNTRUSTED_REFERENCE_DATA` 경계 안에 넣음
- Gemini inline image decoded 합계는 13 MiB, 직렬화된 전체 body는
  19 MiB 미만으로 제한

대용량 base64는 반복 정규식 없이 선형 검사합니다. OpenAI에는 원래의 엄격한
JSON Schema를 전달하고, Gemini에는 지원되지 않는 `minLength`,
`maxLength`, `pattern`을 제거한 사본을 전달한 뒤 같은 runtime validator를
적용합니다. 현재 공식 `generateContent` 계약이 지원하는 `store: false`를
두 provider 모두에 적용해 요청 단위 저장/로깅을 끕니다.

플랫폼은 요청 전에 `validateWritingRequestV2()`를, 저장 전후에는
`validateHistoryEntry()`, `validateWritingDraft()`,
`validateMemoryEditCommand()`를 사용할 수 있습니다. 초안과 히스토리에는
큰 이미지 payload를 복제하지 않고 첨부 메타데이터만 저장하며, 실제 payload는
첨부 id로 별도 보관합니다.

히스토리 전체 계약은 `HistoryStore`이며 최대 100개입니다.
`createHistoryEntry()`, `readHistoryEntry()`, `updateHistoryEntry()`,
`deleteHistoryEntry()`, `selectHistoryEntry()`, `pruneHistoryEntries()`가
불변 방식으로 목록을 다룹니다. 항목 안의 version sequence는 1부터 빈틈없이
연속이어야 합니다.

기억 후보 저장 시 모델의 `source` 값만 믿지 않습니다. `saveMemory()`에 앱이
실제 채널에서 확인한 `provenance`를 넘겨야 하며, 생략하거나
`attachment`/`model_inference`이면 세션 기억으로 제한되고 반복 호출만으로
영구 승격되지 않습니다. 사용자 편집은 `applyMemoryEditCommand()`가 최종
병합 카드 전체의 민감정보를 검사한 뒤 원자적으로 반영합니다. 프롬프트에 넣는
기억도 `UNTRUSTED_MEMORY_DATA` 경계와 1,200자/추정 600토큰 예산을 적용합니다.
