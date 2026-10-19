// 자동 생성 파일입니다. 직접 고치지 마세요.
// 원본: shared/rules/ — 고친 뒤 shared 폴더에서 `npm run rules`를 실행하세요.
(function exposeWritingRules(root, rules) {
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
  if (root) root.writingRules = api;
})(typeof globalThis === "object" ? globalThis : this, {
  "version": 2,
  "speechLevel": {
    "enhance": "말투 맞추기:\n- 완성본의 높임 정도는 사용자 원문을 따른다. 원문이 반말이면 반말로, 존댓말이면 존댓말로 쓰고 해요체·합쇼체 같은 높임 수준도 그대로 둔다.\n- 상황 안내나 사용자의 답에서 말투나 받는 사람(예: 상사, 고객, 친구)을 정했으면 그것을 따른다.\n- 원문이 '팀장님', '고객님', '교수님'처럼 높여야 할 상대에게 직접 하는 말이면 존댓말로 쓴다.\n- 원문이 '-함', '-음', '-듯'으로 끝나는 메모라 말투가 분명하지 않으면 글의 목적과 받는 사람에 맞는 말투를 고른다.\n- follow_up과 assumption은 앱이 사용자에게 하는 말이다. 사용자가 원문이나 답을 반말로 썼으면 반말로, 그 밖에는 해요체로 쓴다.",
    "guess": "질문과 추론 설명은 사용자가 반말로 썼으면 반말로, 그 밖에는 해요체로 쓴다."
  },
  "selection": {
    "levelShortLabels": [
      "요약",
      "간결",
      "충실",
      "보완",
      "확장"
    ],
    "limits": {
      "maxSituations": 12,
      "maxSituationLabel": 10,
      "maxSituationText": 200
    },
    "situations": [
      {
        "label": "메신저 답장",
        "text": "메신저로 보내는 답장"
      },
      {
        "label": "업무 메일",
        "text": "업무 메일"
      },
      {
        "label": "상사 보고",
        "text": "상사에게 하는 보고"
      },
      {
        "label": "고객 응대",
        "text": "고객에게 보내는 안내"
      },
      {
        "label": "공지·안내",
        "text": "여러 사람에게 알리는 공지"
      },
      {
        "label": "SNS 글",
        "text": "SNS에 올리는 글"
      },
      {
        "label": "부탁·요청",
        "text": "정중하게 부탁하는 글"
      },
      {
        "label": "사과",
        "text": "진심이 전해지는 사과"
      }
    ]
  }
});
