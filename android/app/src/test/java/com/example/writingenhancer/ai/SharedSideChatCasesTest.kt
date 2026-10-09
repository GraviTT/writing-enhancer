package com.example.writingenhancer.ai

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * shared/rules/side-chat-cases.json의 공통 사례를 Android 구현으로 확인한다.
 * 프롬프트 기대값은 Windows 구현으로 생성되므로 두 앱이 같은 요청을 보내는지 검사한다.
 */
class SharedSideChatCasesTest {
    @Test
    fun searchModeMatchesSharedCases() {
        SharedSideChatCases.SEARCH_MODE.forEach { case ->
            assertEquals(
                case.input,
                case.expected,
                SideChatSearchPolicy.mode(case.input, case.forceSearch).name.lowercase(),
            )
        }
    }

    @Test
    fun confirmationMatchesSharedCases() {
        SharedSideChatCases.CONFIRMATION.forEach { case ->
            assertEquals(
                "${case.action} / grounded=${case.grounded}",
                case.expected,
                SideChatSearchPolicy.requiresConfirmation(SideChatAction(case.action, ""), case.grounded),
            )
        }
    }

    @Test
    fun progressAndPendingActionTextMatchSharedCases() {
        SharedSideChatCases.PROGRESS_LABEL.forEach { case ->
            val stage = when (case.stage) {
                "fallback" -> SideChatProgress.Stage.FALLBACK
                "searching" -> SideChatProgress.Stage.SEARCHING
                else -> SideChatProgress.Stage.REQUESTING
            }
            assertEquals(
                case.expected,
                SideChatDisplayPolicy.progressLabel(
                    SideChatProgress(stage, "GPT", case.searchRequired),
                    case.elapsedMillis,
                ),
            )
        }
        SharedSideChatCases.PENDING_ACTION.forEach { case ->
            val action = SideChatAction(case.action, case.value)
            assertEquals(case.action, case.label, SideChatDisplayPolicy.pendingActionLabel(action))
            assertEquals(case.action, case.preview, SideChatDisplayPolicy.pendingActionPreview(action))
        }
    }

    @Test
    fun streamingHidesControlBlockLikeWindows() {
        SharedSideChatCases.STREAM_VISIBLE.forEach { case ->
            assertEquals(case.input, case.expected, ChatAnswer.visibleStreamText(case.input))
        }
    }

    @Test
    fun controlBlockMatchesSharedCases() {
        SharedSideChatCases.CONTROL_BLOCK.forEach { case ->
            val parsed = ChatAnswer.parseControlBlock(case.full)
            assertEquals(case.name, case.answer, parsed.answer)
            assertEquals(case.name, case.answerOffset, parsed.answerOffset)
            assertEquals(case.name, case.role, parsed.role)
            assertEquals(case.name, SideChatAction(case.actionName, case.actionValue), parsed.action)
            assertEquals(case.name, case.relatedQueries, parsed.relatedQueries)
        }
    }

    @Test
    fun categoryMatchesSharedCases() {
        SharedSideChatCases.CATEGORY.forEach { case ->
            val category = ChatAnswer.finalCategory(case.role, case.action, case.hasSources)
            assertEquals(case.toString(), case.expected, category)
            assertEquals(case.toString(), case.label, ChatAnswer.categoryLabel(category, case.hasSources))
        }
    }

    @Test
    fun answerFormattingMatchesSharedCases() {
        SharedSideChatCases.FORMAT_ANSWER.forEach { case ->
            val annotations = case.annotations.map { annotation ->
                val match = annotation.match ?: return@map AnswerAnnotation(
                    annotation.start,
                    annotation.end,
                    annotation.source,
                )
                val start = case.raw.indexOf(match)
                AnswerAnnotation(start, start + match.length, annotation.source)
            }
            val formatted = ChatAnswer.formatAnswer(case.raw, annotations, case.cleanLinks)
            assertEquals(case.name, case.text, formatted.text)
            assertEquals(
                case.name,
                case.citations,
                formatted.citations.map {
                    SharedSideChatCases.CitationText(formatted.text.substring(it.start, it.end), it.sources)
                },
            )
            assertEquals(
                case.name,
                case.styles,
                formatted.styles.map {
                    SharedSideChatCases.StyleText(formatted.text.substring(it.start, it.end), it.kind)
                },
            )
        }
    }

    @Test
    fun sideChatPromptIsIdenticalToWindows() {
        SharedSideChatCases.PROMPT.forEach { case ->
            val screen = when (case.screen) {
                "capture" -> AttachmentRef("screen.png", "현재 화면.png", "image/png", 10, "screenshot")
                "image" -> AttachmentRef("image.png", "첨부 이미지.png", "image/png", 10, "file")
                else -> null
            }
            val request = SideChatRequest(
                input = case.input,
                messages = case.messages.mapIndexed { index, message ->
                    SideChatMessage(
                        id = "m$index",
                        role = message.role,
                        content = message.content,
                        createdAt = index.toLong(),
                        untrustedExternalContext = message.external,
                        searchQueries = message.searchQueries,
                        sources = message.sources.map { WebSource(it.title, it.url) },
                    )
                },
                writingContext = SideChatWritingContext(
                    view = case.view,
                    situation = case.situation,
                    rawInput = case.rawInput,
                    completedText = case.completedText,
                    followUp = case.followUp,
                    reply = case.reply,
                    enhancementLevel = case.enhancementLevel,
                    versionIndex = case.versionIndex,
                    versionCount = case.versionCount,
                    attachmentNames = case.attachmentNames,
                ),
                screenContext = screen,
                forceSearch = case.forceSearch,
            )
            assertEquals(case.name, case.expectedPrompt, SideChatPromptBuilder.build(request))
        }
    }
}
