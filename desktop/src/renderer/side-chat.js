// 한 창 안의 사이드 채팅 화면. 글 강화기 화면(renderer.js)과 같은 페이지에서 동작하므로
// 전역 이름이 겹치지 않도록 하나의 범위 안에 둔다.
(function sideChatSurface() {
  "use strict";

  const api = window.writingEnhancer;
  const cropPolicy = window.visualCrop;
  // 진행 표시·적용 카드 문구는 shared/rules에서 Android와 함께 쓴다.
  const chatText = window.sideChatText;
  const elements = Object.fromEntries(
    [
      "openWritingButton",
      "newChatButton",
      "writingContextBar",
      "writingContextText",
      "messageList",
      "emptyChat",
      "chatInput",
      "sendChatButton",
      "screenCaptureButton",
      "imagePickButton",
      "searchModeButton",
      "visualPreview",
      "visualPreviewOpenButton",
      "visualPreviewImage",
      "visualPreviewTitle",
      "cropVisualButton",
      "clearScreenContextButton",
      "clearConfirm",
      "clearCancelButton",
      "clearConfirmButton",
      "chatToast",
      "chatToastText",
      "chatToastAction",
      "cropDialog",
      "cropCanvas",
      "cropCancelButton",
      "cropFullButton",
      "cropApplyButton",
      "chatSurface"
    ].map((id) => [id, document.querySelector(`#${id}`)])
  );

  const state = {
    messages: [],
    busy: false,
    // AI 답변을 기다리는 중이면 보내기 버튼이 중단 버튼이 된다.
    replying: false,
    // 다음 질문 한 번만 웹 검색을 강제한다.
    searchMode: false,
    progress: null,
    progressTimer: undefined,
    pendingAction: null,
    capturingScreen: false,
    screenCaptureAttempt: 0,
    screenAttachment: null,
    editingMessageId: "",
    writingContext: {},
    toastTimer: undefined,
    cropImage: null,
    cropRect: null,
    cropStart: null
  };

  function visualAttachmentUrl(attachment) {
    if (!attachment?.data || !attachment?.mimeType) return "";
    return `data:${attachment.mimeType};base64,${attachment.data}`;
  }

  function updateScreenContextUi() {
    const hasScreen = Boolean(state.screenAttachment);
    elements.screenCaptureButton.classList.toggle("is-active", hasScreen);
    elements.screenCaptureButton.classList.toggle("is-capturing", state.capturingScreen);
    elements.screenCaptureButton.disabled = state.busy || state.capturingScreen;
    elements.imagePickButton.disabled = state.busy || state.capturingScreen;
    elements.searchModeButton.disabled = state.busy || state.capturingScreen;
    elements.searchModeButton.classList.toggle("is-active", state.searchMode);
    elements.searchModeButton.setAttribute("aria-pressed", state.searchMode ? "true" : "false");
    elements.sendChatButton.disabled = state.capturingScreen || (state.busy && !state.replying);
    elements.sendChatButton.dataset.mode = state.replying ? "stop" : "send";
    elements.sendChatButton.setAttribute(
      "aria-label",
      state.replying ? "답변 중단" : "메시지 보내기"
    );
    elements.sendChatButton.title = state.replying ? "답변 중단" : "";
    elements.screenCaptureButton.setAttribute("aria-pressed", hasScreen ? "true" : "false");
    elements.visualPreview.classList.toggle("is-hidden", !hasScreen);
    if (hasScreen) {
      elements.visualPreviewImage.src = visualAttachmentUrl(state.screenAttachment);
      elements.visualPreviewTitle.textContent =
        state.screenAttachment.source === "screen" ? "화면 캡처 준비됨" : "첨부 이미지 준비됨";
    } else {
      elements.visualPreviewImage.removeAttribute("src");
    }
    elements.clearScreenContextButton.disabled = state.capturingScreen;
    elements.cropVisualButton.disabled = state.capturingScreen;
  }

  function clearScreenContext({ silent = false } = {}) {
    const hadScreen = Boolean(state.screenAttachment);
    state.screenCaptureAttempt += 1;
    state.screenAttachment = null;
    closeCropDialog();
    updateScreenContextUi();
    if (hadScreen && !silent) showToast("검색할 이미지 사용을 취소했어요.");
  }

  async function captureScreenContext() {
    if (state.busy || state.capturingScreen) return;
    const attempt = ++state.screenCaptureAttempt;
    state.capturingScreen = true;
    state.screenAttachment = null;
    updateScreenContextUi();
    let response;
    try {
      response = await api.captureSideChatScreen();
    } catch {
      response = {
        ok: false,
        error: { message: "현재 화면을 촬영하지 못했어요." }
      };
    }
    if (attempt !== state.screenCaptureAttempt) {
      state.capturingScreen = false;
      state.screenAttachment = null;
      updateScreenContextUi();
      return;
    }
    state.capturingScreen = false;
    if (response?.ok && response.attachment) {
      state.screenAttachment = response.attachment;
      showToast("화면을 확인했어요. 필요하면 물어볼 영역을 선택하세요.");
    } else {
      state.screenAttachment = null;
      showToast(response?.error?.message || "현재 화면을 촬영하지 못했어요.");
    }
    updateScreenContextUi();
    focusChatInput();
  }

  async function pickImageContext() {
    if (state.busy || state.capturingScreen) return;
    let response;
    try {
      response = await api.pickSideChatImage();
    } catch {
      response = { ok: false, error: { message: "이미지를 불러오지 못했어요." } };
    }
    if (!response?.ok) {
      showToast(response?.error?.message || "이미지를 불러오지 못했어요.");
    } else if (response.attachment) {
      state.screenAttachment = response.attachment;
      updateScreenContextUi();
      showToast("이미지를 확인했어요. 필요하면 물어볼 영역을 선택하세요.");
    }
    focusChatInput();
  }

  function closeCropDialog() {
    elements.cropDialog.classList.add("is-hidden");
    state.cropImage = null;
    state.cropRect = null;
    state.cropStart = null;
  }

  function drawCropCanvas() {
    const image = state.cropImage;
    if (!image) return;
    const canvas = elements.cropCanvas;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const rect = state.cropRect;
    if (!rect) return;
    context.fillStyle = "rgba(12, 9, 22, 0.54)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.restore();
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(2, canvas.width / 420);
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }

  function openCropDialog() {
    const attachment = state.screenAttachment;
    if (!attachment) return;
    const image = new Image();
    image.onload = () => {
      const fitted = cropPolicy.fitWithin(image.naturalWidth, image.naturalHeight, 1200, 900);
      elements.cropCanvas.width = fitted.width;
      elements.cropCanvas.height = fitted.height;
      state.cropImage = image;
      state.cropRect = {
        x: Math.round(fitted.width * 0.08),
        y: Math.round(fitted.height * 0.08),
        width: Math.round(fitted.width * 0.84),
        height: Math.round(fitted.height * 0.84)
      };
      elements.cropDialog.classList.remove("is-hidden");
      drawCropCanvas();
    };
    image.onerror = () => showToast("이미지 미리보기를 열지 못했어요.");
    image.src = visualAttachmentUrl(attachment);
  }

  function cropCanvasPoint(event) {
    const bounds = elements.cropCanvas.getBoundingClientRect();
    return {
      x: cropPolicy.clamp((event.clientX - bounds.left) * elements.cropCanvas.width / bounds.width, 0, elements.cropCanvas.width),
      y: cropPolicy.clamp((event.clientY - bounds.top) * elements.cropCanvas.height / bounds.height, 0, elements.cropCanvas.height)
    };
  }

  function applyCropSelection() {
    const image = state.cropImage;
    const rect = state.cropRect;
    const attachment = state.screenAttachment;
    if (!image || !rect || !attachment) return;
    const scaleX = image.naturalWidth / elements.cropCanvas.width;
    const scaleY = image.naturalHeight / elements.cropCanvas.height;
    const source = {
      x: Math.round(rect.x * scaleX),
      y: Math.round(rect.y * scaleY),
      width: Math.max(1, Math.round(rect.width * scaleX)),
      height: Math.max(1, Math.round(rect.height * scaleY))
    };
    let fitted = cropPolicy.fitWithin(source.width, source.height);
    const output = document.createElement("canvas");
    const context = output.getContext("2d");
    let dataUrl = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      output.width = fitted.width;
      output.height = fitted.height;
      context.drawImage(
        image,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        fitted.width,
        fitted.height
      );
      dataUrl = output.toDataURL("image/png");
      if (cropPolicy.dataUrlBytes(dataUrl) <= 8 * 1024 * 1024) break;
      fitted = cropPolicy.fitWithin(fitted.width, fitted.height, Math.round(fitted.width * 0.8), Math.round(fitted.height * 0.8));
    }
    const data = dataUrl.split(",", 2)[1] || "";
    const size = cropPolicy.dataUrlBytes(dataUrl);
    if (!data || size <= 0 || size > 8 * 1024 * 1024) {
      showToast("선택 영역을 8MB 이하로 준비하지 못했어요.");
      return;
    }
    state.screenAttachment = {
      ...attachment,
      name: "선택 영역.png",
      mimeType: "image/png",
      kind: "image",
      size,
      data
    };
    closeCropDialog();
    updateScreenContextUi();
    showToast("선택한 영역을 다음 질문에 함께 보내요.");
  }

  function autoGrow() {
    elements.chatInput.style.height = "auto";
    elements.chatInput.style.height = `${Math.min(elements.chatInput.scrollHeight, 132)}px`;
  }

  function focusChatInput() {
    elements.chatInput.removeAttribute("disabled");
    elements.chatInput.removeAttribute("readonly");
    elements.chatInput.disabled = false;
    elements.chatInput.readOnly = false;
    elements.chatInput.tabIndex = 0;
    const focus = () => {
      if (!elements.clearConfirm.classList.contains("is-hidden")) return;
      window.focus();
      elements.chatInput.focus({ preventScroll: true });
      const end = elements.chatInput.value.length;
      elements.chatInput.setSelectionRange(end, end);
    };
    focus();
    window.requestAnimationFrame(focus);
    window.setTimeout(focus, 60);
    window.setTimeout(focus, 180);
  }

  function scrollToLatest() {
    window.requestAnimationFrame(() => {
      elements.messageList.scrollTop = elements.messageList.scrollHeight;
    });
  }

  function beginEdit(message) {
    if (state.busy || message?.role !== "user") return;
    state.editingMessageId = message.id;
    renderMessages();
    window.requestAnimationFrame(() => {
      const editor = elements.messageList.querySelector(
        `[data-editing-id="${CSS.escape(message.id)}"] textarea`
      );
      editor?.focus();
      editor?.setSelectionRange(editor.value.length, editor.value.length);
    });
  }

  function cancelEdit() {
    state.editingMessageId = "";
    renderMessages();
    focusChatInput();
  }

  async function submitEdit(messageId, editor) {
    if (state.busy) return;
    const input = editor.value.trim();
    if (!input) {
      editor.focus();
      return;
    }
    const index = state.messages.findIndex(
      (message) => message.id === messageId && message.role === "user"
    );
    if (index < 0) {
      showToast("수정할 메시지를 찾지 못했어요.");
      cancelEdit();
      return;
    }
    state.editingMessageId = "";
    state.pendingAction = null;
    elements.newChatButton.disabled = true;
    beginReply();
    state.messages = state.messages.slice(0, index);
    renderMessages({ pendingUser: input, typing: true });
    let response;
    try {
      response = await api.editSideChat(messageId, input);
    } catch {
      response = { ok: false, error: { message: "수정한 메시지로 다시 답하지 못했어요." } };
    }
    endReply();
    elements.newChatButton.disabled = false;
    state.messages = response?.messages || state.messages;
    state.pendingAction = response?.ok ? response.pendingAction || null : null;
    renderMessages();
    if (!response?.ok) {
      const needsKey = response?.error?.code === "NO_API_KEY";
      showToast(response?.error?.message || "수정한 메시지로 다시 답하지 못했어요.", {
        settings: needsKey
      });
    }
    if (!response?.action || response.action.name === "none") focusChatInput();
  }

  // 답변 대기 중에는 보내기 버튼을 중단 버튼으로 바꾸고 경과 시간을 보여 준다.
  function beginReply() {
    state.busy = true;
    state.replying = true;
    window.clearInterval(state.progressTimer);
    state.progress = { startedAt: Date.now(), stage: "requesting", searchPolicy: "" };
    state.progressTimer = window.setInterval(updateProgressLabel, 1_000);
    updateScreenContextUi();
  }

  function endReply() {
    state.busy = false;
    state.replying = false;
    window.clearInterval(state.progressTimer);
    state.progressTimer = undefined;
    state.progress = null;
    updateScreenContextUi();
  }

  async function cancelReply() {
    if (!state.replying) return;
    elements.sendChatButton.disabled = true;
    try {
      await api.cancelSideChat();
    } catch {
      // 요청이 이미 끝났으면 응답 처리 쪽에서 상태를 정리한다.
    }
  }

  function progressLabelText() {
    const progress = state.progress;
    if (!progress) return "AI가 답변 중";
    return chatText.progressLabel(
      { stage: progress.stage, searchRequired: progress.searchPolicy === "required" },
      Date.now() - progress.startedAt
    );
  }

  function updateProgressLabel() {
    const label = elements.messageList.querySelector(".typing-label");
    if (label) label.textContent = progressLabelText();
  }

  function createPendingActionCard(action) {
    const card = document.createElement("div");
    card.className = "pending-action";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "제안 적용 확인");
    const title = document.createElement("strong");
    title.textContent = chatText.labels.pendingTitle;
    const label = document.createElement("span");
    label.className = "pending-action-label";
    label.textContent = chatText.pendingActionLabel(action);
    card.append(title, label);
    const previewText = chatText.pendingActionPreview(action);
    if (previewText) {
      const preview = document.createElement("div");
      preview.className = "pending-action-preview";
      preview.textContent = previewText;
      card.append(preview);
    }
    const note = document.createElement("p");
    note.textContent = chatText.labels.pendingNote;
    const buttons = document.createElement("div");
    buttons.className = "pending-action-buttons";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "취소";
    dismiss.addEventListener("click", dismissPendingAction);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    apply.textContent = "적용";
    apply.addEventListener("click", applyPendingAction);
    buttons.append(dismiss, apply);
    card.append(note, buttons);
    return card;
  }

  async function applyPendingAction() {
    const action = state.pendingAction;
    if (!action || state.busy) return;
    state.pendingAction = null;
    renderMessages();
    let response;
    try {
      response = await api.applySideChatAction(action.token);
    } catch {
      response = null;
    }
    if (!response?.ok) {
      showToast(response?.error?.message || "제안을 적용하지 못했어요.");
      focusChatInput();
    }
  }

  async function dismissPendingAction() {
    const action = state.pendingAction;
    if (!action) return;
    state.pendingAction = null;
    renderMessages();
    try {
      await api.dismissSideChatAction(action.token);
    } catch {
      // 보관된 제안은 다음 요청에서 어차피 폐기된다.
    }
    showToast(chatText.labels.pendingDismissed);
    focusChatInput();
  }

  function createMessageEditor(message) {
    const editor = document.createElement("div");
    editor.className = "message-editor";
    editor.dataset.editingId = message.id;
    const textarea = document.createElement("textarea");
    textarea.value = message.content;
    textarea.maxLength = 6000;
    textarea.rows = 3;
    textarea.setAttribute("aria-label", "사용자 메시지 수정");
    const actions = document.createElement("div");
    actions.className = "message-edit-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "취소";
    cancel.addEventListener("click", cancelEdit);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "save";
    save.textContent = "수정 완료";
    save.addEventListener("click", () => submitEdit(message.id, textarea));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        submitEdit(message.id, textarea);
      }
    });
    actions.append(cancel, save);
    editor.append(textarea, actions);
    return editor;
  }

  function visibleAssistantContent(message) {
    const content = String(message?.content || "").trim();
    const externallyGrounded =
      (Array.isArray(message?.sources) && message.sources.length > 0) ||
      message?.externalGrounding === true;
    if (!externallyGrounded) return content;
    const withoutMarkdownTargets = content.replace(
      /\[([^\]\n]{1,180})\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/giu,
      "$1"
    );
    return withoutMarkdownTargets.replace(/https?:\/\/[^\s<>\[\]{}]+/giu, (raw) => {
      try {
        return `[${new URL(raw.replace(/[.,;:!?)]+$/u, "")).hostname.replace(/^www\./u, "")}]`;
      } catch {
        return "[출처]";
      }
    });
  }

  async function copyAssistantMessage(message) {
    const response = await api.copyText(visibleAssistantContent(message));
    showToast(response?.ok ? "AI 답변을 복사했어요." : "복사할 답변이 없어요.");
  }

  function createSourceList(message) {
    const sources = Array.isArray(message?.sources) ? message.sources.slice(0, 6) : [];
    if (sources.length === 0) return null;
    const list = document.createElement("div");
    list.className = "message-sources";
    const label = document.createElement("span");
    label.className = "message-sources-label";
    label.textContent = "웹에서 확인";
    list.append(label);
    sources.forEach((source, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-source-link";
      button.textContent = `${index + 1}. ${source.title || "출처"}`;
      button.title = source.url || "";
      button.setAttribute("aria-label", `출처 ${index + 1} 열기: ${source.title || "웹 문서"}`);
      button.addEventListener("click", async () => {
        const response = await api.openExternalLink(source.url || "");
        if (!response?.ok) showToast("출처 링크를 열지 못했어요.");
      });
      list.append(button);
    });
    return list;
  }

  function createRelatedQueries(message) {
    const queries = Array.isArray(message?.relatedQueries)
      ? message.relatedQueries.slice(0, 3)
      : [];
    if (queries.length === 0) return null;
    const group = document.createElement("div");
    group.className = "message-related-queries";
    const label = document.createElement("span");
    label.className = "message-related-label";
    label.textContent = "이어서 살펴보기";
    group.append(label);
    queries.forEach((query) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-related-button";
      button.textContent = query;
      button.title = query;
      button.addEventListener("click", () => {
        if (state.busy) return;
        elements.chatInput.value = query;
        autoGrow();
        sendMessage({ forceSearch: true });
      });
      group.append(button);
    });
    return group;
  }

  function renderMessages({ pendingUser = "", typing = false } = {}) {
    elements.messageList.replaceChildren();
    const visible = [...state.messages];
    if (pendingUser) {
      visible.push({ role: "user", content: pendingUser, pending: true });
    }
    elements.emptyChat.classList.toggle("is-hidden", visible.length > 0 || typing);
    if (visible.length === 0 && !typing) {
      elements.messageList.append(elements.emptyChat);
    }
    for (const message of visible) {
      const row = document.createElement("div");
      row.className = `message-row ${message.role}`;
      if (message.id && state.editingMessageId === message.id) {
        row.append(createMessageEditor(message));
        elements.messageList.append(row);
        continue;
      }
      const bubble = document.createElement("div");
      bubble.className = `message ${message.role}${message.pending ? " pending" : ""}`;
      const messageText = document.createElement("div");
      messageText.className = "message-text";
      messageText.textContent =
        message.role === "assistant" ? visibleAssistantContent(message) : message.content;
      bubble.append(messageText);
      if (message.role === "assistant" && message.sourcesMissing === true) {
        const note = document.createElement("p");
        note.className = "message-note";
        note.textContent = chatText.labels.sourcesMissingNote;
        bubble.append(note);
      }
      const sourceList = message.role === "assistant" ? createSourceList(message) : null;
      if (sourceList) bubble.append(sourceList);
      const relatedQueries =
        message.role === "assistant" ? createRelatedQueries(message) : null;
      if (relatedQueries) bubble.append(relatedQueries);
      if (message.role === "user" && message.id && !message.pending) {
        row.classList.add("has-side-action");
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "message-side-button message-edit-button";
        edit.textContent = "수정";
        edit.setAttribute("aria-label", "이 메시지 수정");
        edit.addEventListener("click", () => beginEdit(message));
        row.append(edit);
      }
      row.append(bubble);
      if (message.role === "assistant" && message.content?.trim()) {
        row.classList.add("has-side-action");
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "message-side-button message-copy-button";
        copy.textContent = "복사";
        copy.setAttribute("aria-label", "AI 답변 복사");
        copy.addEventListener("click", () => copyAssistantMessage(message));
        row.append(copy);
      }
      elements.messageList.append(row);
    }
    if (state.pendingAction && !typing) {
      const row = document.createElement("div");
      row.className = "message-row assistant pending-action-row";
      row.append(createPendingActionCard(state.pendingAction));
      elements.messageList.append(row);
    }
    if (typing) {
      const indicator = document.createElement("div");
      indicator.className = "typing";
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-label", "AI가 답변 중");
      const dots = document.createElement("span");
      dots.className = "typing-dots";
      dots.append(
        document.createElement("span"),
        document.createElement("span"),
        document.createElement("span")
      );
      const label = document.createElement("span");
      label.className = "typing-label";
      label.textContent = progressLabelText();
      indicator.append(dots, label);
      elements.messageList.append(indicator);
    }
    scrollToLatest();
  }

  function renderWritingContext(context = {}) {
    state.writingContext = context;
    const hasInput = Boolean(String(context.input || "").trim());
    const hasResult = Boolean(String(context.completedText || "").trim());
    const versionCount = Number(context.versionCount) || 0;
    elements.writingContextBar.classList.toggle("has-context", hasInput || hasResult);
    elements.writingContextText.textContent = hasResult
      ? `현재 강화 결과 연동 · ${versionCount || 1}개 버전`
      : hasInput
        ? "현재 작성 중인 원문 연동"
        : "글 강화기 기능 연동 · 작성 중인 글 없음";
  }

  function showToast(message, { settings = false } = {}) {
    window.clearTimeout(state.toastTimer);
    elements.chatToastText.textContent = message;
    elements.chatToastAction.classList.toggle("is-hidden", !settings);
    elements.chatToast.classList.remove("is-hidden");
    state.toastTimer = window.setTimeout(
      () => elements.chatToast.classList.add("is-hidden"),
      7_000
    );
  }

  async function sendMessage(options = {}) {
    const requestedForceSearch = options?.forceSearch === true;
    if (state.busy || state.capturingScreen) return;
    const input = elements.chatInput.value.trim();
    if (!input) {
      focusChatInput();
      return;
    }
    const screenAttachment = state.screenAttachment;
    const forceSearch = requestedForceSearch || state.searchMode;
    state.screenAttachment = null;
    state.searchMode = false;
    state.pendingAction = null;
    beginReply();
    elements.chatInput.value = "";
    autoGrow();
    renderMessages({ pendingUser: input, typing: true });
    let response;
    try {
      response = await api.sendSideChat(input, screenAttachment, forceSearch);
    } catch {
      response = {
        ok: false,
        error: { message: "답변을 가져오지 못했어요." }
      };
    }
    endReply();
    if (!response?.ok) {
      elements.chatInput.value = input;
      // 같은 질문을 다시 보낼 수 있도록 검색 강제 여부도 되돌린다.
      state.searchMode = forceSearch;
      updateScreenContextUi();
      autoGrow();
      renderMessages();
      const needsKey = response?.error?.code === "NO_API_KEY";
      const failureMessage = screenAttachment
        ? `${response?.error?.message || "답변을 가져오지 못했어요."} 사용한 이미지는 저장하지 않고 폐기했어요.`
        : response?.error?.message || "답변을 가져오지 못했어요.";
      showToast(failureMessage, {
        settings: needsKey
      });
      focusChatInput();
      return;
    }
    state.messages = response.messages || [];
    state.pendingAction = response.pendingAction || null;
    renderMessages();
    if (screenAttachment) {
      showToast(
        response?.result?.webSearchUsed
          ? "선택한 이미지와 웹 검색을 함께 확인했어요."
          : "선택한 이미지를 확인했어요."
      );
    }
    if (!response?.action || response.action.name === "none") focusChatInput();
  }

  function closeClearConfirmation({ focusInput = true } = {}) {
    elements.clearConfirm.classList.add("is-hidden");
    if (focusInput) focusChatInput();
  }

  function requestClearChat() {
    if (state.busy) return;
    if (state.messages.length === 0) {
      performClearChat();
      return;
    }
    elements.clearConfirm.classList.remove("is-hidden");
    window.requestAnimationFrame(() => elements.clearCancelButton.focus());
  }

  async function performClearChat() {
    if (state.busy) return;
    closeClearConfirmation({ focusInput: false });
    state.editingMessageId = "";
    clearScreenContext({ silent: true });
    state.busy = true;
    elements.newChatButton.disabled = true;
    elements.sendChatButton.disabled = true;
    updateScreenContextUi();
    try {
      const response = await api.clearSideChat();
      if (!response || !Array.isArray(response.messages)) {
        throw new Error("초기화 응답이 올바르지 않습니다.");
      }
      state.messages = [];
      state.pendingAction = null;
      elements.chatInput.value = "";
      autoGrow();
      renderMessages();
    } catch {
      showToast("대화를 초기화하지 못했어요.");
    } finally {
      state.busy = false;
      elements.newChatButton.disabled = false;
      elements.sendChatButton.disabled = false;
      updateScreenContextUi();
      await api.focusSideChatInput();
      focusChatInput();
    }
  }

  elements.chatInput.addEventListener("input", autoGrow);
  elements.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  elements.sendChatButton.addEventListener("click", () => {
    if (state.replying) cancelReply();
    else sendMessage();
  });
  elements.screenCaptureButton.addEventListener("click", captureScreenContext);
  elements.imagePickButton.addEventListener("click", pickImageContext);
  elements.searchModeButton.addEventListener("click", () => {
    if (state.busy || state.capturingScreen) return;
    state.searchMode = !state.searchMode;
    updateScreenContextUi();
    showToast(state.searchMode ? chatText.labels.searchModeOn : chatText.labels.searchModeOff);
    focusChatInput();
  });
  elements.visualPreviewOpenButton.addEventListener("click", openCropDialog);
  elements.cropVisualButton.addEventListener("click", openCropDialog);
  elements.clearScreenContextButton.addEventListener("click", () => clearScreenContext());
  elements.openWritingButton.addEventListener("click", () => {
    clearScreenContext({ silent: true });
    window.writingPanel?.showSurface("writing");
  });
  elements.newChatButton.addEventListener("click", requestClearChat);
  elements.clearCancelButton.addEventListener("click", () => closeClearConfirmation());
  elements.clearConfirmButton.addEventListener("click", performClearChat);
  elements.chatToastAction.addEventListener("click", () => api.openMainSettings());
  elements.cropCancelButton.addEventListener("click", closeCropDialog);
  elements.cropFullButton.addEventListener("click", closeCropDialog);
  elements.cropApplyButton.addEventListener("click", applyCropSelection);
  elements.cropCanvas.addEventListener("pointerdown", (event) => {
    if (!state.cropImage || event.button !== 0) return;
    event.preventDefault();
    elements.cropCanvas.setPointerCapture(event.pointerId);
    state.cropStart = cropCanvasPoint(event);
    state.cropRect = null;
    drawCropCanvas();
  });
  elements.cropCanvas.addEventListener("pointermove", (event) => {
    if (!state.cropStart || !elements.cropCanvas.hasPointerCapture(event.pointerId)) return;
    state.cropRect = cropPolicy.normalizeRect(
      state.cropStart,
      cropCanvasPoint(event),
      elements.cropCanvas.width,
      elements.cropCanvas.height
    );
    drawCropCanvas();
  });
  const finishCropPointer = (event) => {
    if (!state.cropStart) return;
    const next = cropPolicy.normalizeRect(
      state.cropStart,
      cropCanvasPoint(event),
      elements.cropCanvas.width,
      elements.cropCanvas.height
    );
    if (next) state.cropRect = next;
    state.cropStart = null;
    drawCropCanvas();
  };
  elements.cropCanvas.addEventListener("pointerup", finishCropPointer);
  elements.cropCanvas.addEventListener("pointercancel", finishCropPointer);
  api.onSideChatFocus(() => {
    if (isSurfaceVisible()) focusChatInput();
  });
  api.onSideChatDiscardScreenContext(() => clearScreenContext({ silent: true }));
  api.onSideChatWritingContext(renderWritingContext);
  api.onSideChatProgress((progress) => {
    if (!state.progress) return;
    state.progress.stage = progress?.stage || state.progress.stage;
    state.progress.searchPolicy = progress?.searchPolicy || state.progress.searchPolicy;
    updateProgressLabel();
  });
  // 채팅 화면의 대화 상자를 Escape로 닫았으면 true. 글 강화기 화면의 Escape 처리보다 먼저 부른다.
  function handleEscape() {
    if (!isSurfaceVisible()) return false;
    if (!elements.cropDialog.classList.contains("is-hidden")) {
      closeCropDialog();
      return true;
    }
    if (!elements.clearConfirm.classList.contains("is-hidden")) {
      closeClearConfirmation();
      return true;
    }
    if (state.editingMessageId) {
      cancelEdit();
      return true;
    }
    return false;
  }

  function isSurfaceVisible() {
    return !elements.chatSurface.classList.contains("is-hidden");
  }

  window.sideChatSurface = {
    focus: focusChatInput,
    handleEscape,
    isVisible: isSurfaceVisible
  };

  window.__sideChatQa = {
    showDemo() {
      state.pendingAction = null;
      state.messages = [
        {
          id: "qa-user-1",
          role: "user",
          content: "이번 주 회의 준비에서 가장 먼저 확인할 것만 짧게 정리해 줘."
        },
        {
          id: "qa-assistant-1",
          role: "assistant",
          content:
            "먼저 회의의 결정 목표, 참석자, 반드시 확인할 자료 세 가지만 점검하세요. 그다음 안건별로 필요한 결정과 담당자를 한 줄씩 적으면 준비가 빠릅니다.",
          sources: [
            { title: "공식 회의 준비 안내", url: "https://example.com/meeting-guide" },
            { title: "업무 회의 체크리스트", url: "https://example.org/checklist" }
          ],
          relatedQueries: [
            "회의 목적별 준비 순서를 비교해 줘",
            "30분 회의용 체크리스트를 만들어 줘"
          ]
        },
        {
          id: "qa-user-2",
          role: "user",
          content: "좋아. 체크리스트 형태로 바꿔 줘."
        }
      ];
      renderWritingContext({
        input: "프로젝트 일정 변경을 팀장에게 보고하려고 함",
        completedText: "검수 일정 조정을 요청드립니다.",
        versionCount: 2
      });
      renderMessages({ typing: true });
    },
    showEditDemo() {
      this.showDemo();
      state.editingMessageId = "qa-user-1";
      renderMessages();
    },
    showSearchDemo() {
      state.editingMessageId = "";
      state.messages = [
        { id: "qa-search-user-1", role: "user", content: "올해 바뀐 회의실 예약 규정도 검색해 줘" },
        {
          id: "qa-search-assistant-1",
          role: "assistant",
          content: "올해 변경 사항은 공개된 자료에서 확인하지 못했어요. 사내 공지에서 직접 확인하는 것이 가장 정확해요.",
          externalGrounding: true,
          sourcesMissing: true
        },
        { id: "qa-search-user-2", role: "user", content: "그럼 기존 규정만 상황에 넣어 줘" },
        {
          id: "qa-search-assistant-2",
          role: "assistant",
          content: "앞에서 찾은 기존 규정을 상황 안내로 정리했어요. 아래에서 확인하고 [적용]을 누르면 반영돼요.",
          externalGrounding: true,
          sources: [{ title: "회의실 이용 안내", url: "https://example.com/rooms" }]
        }
      ];
      state.pendingAction = {
        token: "qa-pending-action",
        name: "set_situation",
        value: "회의실은 2시간 단위로 예약하고, 외부 손님이 있으면 하루 전에 신청한다."
      };
      renderMessages();
      updateScreenContextUi();
    },
    showProgressDemo() {
      state.pendingAction = null;
      state.messages = [
        { id: "qa-progress-user", role: "user", content: "회의 안내 메일 초안 고마워." },
        { id: "qa-progress-assistant", role: "assistant", content: "필요하면 언제든 더 다듬어 드릴게요." }
      ];
      state.busy = true;
      state.replying = true;
      state.progress = {
        startedAt: Date.now() - 14_000,
        stage: "requesting",
        searchPolicy: "required"
      };
      renderMessages({ pendingUser: "다음 주 공휴일 일정 찾아줘", typing: true });
      updateScreenContextUi();
    },
    async resetAndProbe() {
      state.messages = [
        { id: "qa-reset-user", role: "user", content: "초기화 확인용 메시지" }
      ];
      requestClearChat();
      const confirmShown = !elements.clearConfirm.classList.contains("is-hidden");
      await performClearChat();
      await new Promise((resolve) => window.setTimeout(resolve, 90));
      return {
        confirmShown,
        value: elements.chatInput.value,
        disabled: elements.chatInput.disabled,
        readOnly: elements.chatInput.readOnly,
        focused: document.activeElement === elements.chatInput
      };
    }
  };

  api.loadSideChat().then((response) => {
    state.messages = response?.messages || [];
    renderWritingContext(response?.writingContext || {});
    renderMessages();
    autoGrow();
    updateScreenContextUi();
    if (isSurfaceVisible()) focusChatInput();
  });
})();
