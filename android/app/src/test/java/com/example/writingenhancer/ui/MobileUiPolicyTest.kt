package com.example.writingenhancer.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileUiPolicyTest {
    @Test
    fun panelLayoutAdaptsWithoutDroppingTouchTargets() {
        val compact = MobileUiPolicy.layoutProfile(widthDp = 300, heightDp = 430)
        val regular = MobileUiPolicy.layoutProfile(widthDp = 380, heightDp = 640)
        val spacious = MobileUiPolicy.layoutProfile(widthDp = 440, heightDp = 780)

        assertEquals(9, compact.horizontalPaddingDp)
        assertEquals(42, compact.actionHeightDp)
        assertTrue(compact.rawMaxRows < regular.rawMaxRows)
        assertTrue(spacious.rawMaxRows > regular.rawMaxRows)
        assertTrue(spacious.resultMinHeightDp > compact.resultMinHeightDp)
        assertEquals("생성 중…", MobileUiPolicy.loadingButtonText())
    }

    @Test
    fun secondaryEditorsHideInlineToolsAndAnswerVoice() {
        assertTrue(MobileUiPolicy.showInlineEditTools(MobileEditorRole.RAW))
        assertFalse(MobileUiPolicy.showInlineEditTools(MobileEditorRole.SITUATION))
        assertFalse(MobileUiPolicy.showInlineEditTools(MobileEditorRole.ANSWER))
        assertTrue(MobileUiPolicy.showVoiceInput(MobileEditorRole.RAW))
        assertFalse(MobileUiPolicy.showVoiceInput(MobileEditorRole.ANSWER))
        assertTrue(MobileUiPolicy.inlineMenuExpandedAfterBack(wasExpanded = true))
        assertFalse(MobileUiPolicy.inlineMenuExpandedAfterBack(wasExpanded = false))
    }

    @Test
    fun collapsedPanelRestoresTheLastTopLevelSurface() {
        assertEquals(
            PanelSurface.SIDE_CHAT,
            MobileUiPolicy.surfaceForCollapse(PanelScreenState.CHAT),
        )
        listOf(
            PanelScreenState.INPUT,
            PanelScreenState.GUESS,
            PanelScreenState.RESULT,
            PanelScreenState.HISTORY,
        ).forEach { screen ->
            assertEquals(
                PanelSurface.WRITING,
                MobileUiPolicy.surfaceForCollapse(screen),
            )
        }
        assertEquals(PanelSurface.SIDE_CHAT, PanelSurface.fromStored("SIDE_CHAT"))
        assertEquals(PanelSurface.WRITING, PanelSurface.fromStored("WRITING"))
        assertEquals(PanelSurface.WRITING, PanelSurface.fromStored("invalid"))
        assertEquals(PanelSurface.WRITING, PanelSurface.fromStored(null))
    }

    @Test
    fun sideChatPlacesEditLeftAndCopyRightOnlyWhenAvailable() {
        assertEquals(
            SideChatMessageAction.EDIT_LEFT,
            MobileUiPolicy.sideChatMessageAction(
                role = "user",
                editable = true,
                busy = false,
                hasMessageId = true,
                hasContent = true,
            ),
        )
        assertEquals(
            SideChatMessageAction.COPY_RIGHT,
            MobileUiPolicy.sideChatMessageAction(
                role = "assistant",
                editable = false,
                busy = true,
                hasMessageId = true,
                hasContent = true,
            ),
        )
        assertEquals(
            SideChatMessageAction.NONE,
            MobileUiPolicy.sideChatMessageAction(
                role = "user",
                editable = true,
                busy = true,
                hasMessageId = true,
                hasContent = true,
            ),
        )
        assertEquals(
            SideChatMessageAction.NONE,
            MobileUiPolicy.sideChatMessageAction(
                role = "assistant",
                editable = false,
                busy = false,
                hasMessageId = true,
                hasContent = false,
            ),
        )
    }

    @Test
    fun rawAndAnswerFieldsGrowOnlyToTheirCaps() {
        assertEquals(
            MobileUiPolicy.RAW_MIN_ROWS,
            MobileUiPolicy.clampedVisibleRows("한 줄", 4, 9),
        )
        assertEquals(
            MobileUiPolicy.RAW_MAX_ROWS,
            MobileUiPolicy.clampedVisibleRows(
                (1..20).joinToString("\n") { "line" },
                MobileUiPolicy.RAW_MIN_ROWS,
                MobileUiPolicy.RAW_MAX_ROWS,
            ),
        )
        assertEquals(
            4,
            MobileUiPolicy.clampedVisibleRows(
                "1\n2\n3\n4",
                MobileUiPolicy.ANSWER_MIN_ROWS,
                MobileUiPolicy.ANSWER_MAX_ROWS,
            ),
        )
    }

    @Test
    fun removeDropZoneIsBottomCentered() {
        assertTrue(MobileUiPolicy.isInRemoveZone(500f, 1900f, 1000, 2000, 120, 180))
        assertFalse(MobileUiPolicy.isInRemoveZone(100f, 1900f, 1000, 2000, 120, 180))
        assertFalse(MobileUiPolicy.isInRemoveZone(500f, 1500f, 1000, 2000, 120, 180))
    }

    @Test
    fun backAlwaysClosesEditorBeforeChangingPanelState() {
        PanelScreenState.entries.forEach { screen ->
            assertEquals(
                PanelNavigationAction.HIDE_IME,
                MobileUiPolicy.backAction(editorActive = true, screen = screen),
            )
        }
        assertEquals(
            PanelNavigationAction.RETURN_FROM_HISTORY,
            MobileUiPolicy.backAction(false, PanelScreenState.HISTORY),
        )
        assertEquals(
            PanelNavigationAction.CANCEL_GUESS,
            MobileUiPolicy.backAction(false, PanelScreenState.GUESS),
        )
        assertEquals(
            PanelNavigationAction.RETURN_FROM_CHAT,
            MobileUiPolicy.backAction(false, PanelScreenState.CHAT),
        )
        assertEquals(
            PanelNavigationAction.COLLAPSE_PANEL,
            MobileUiPolicy.backAction(false, PanelScreenState.INPUT),
        )
        assertEquals(
            PanelNavigationAction.COLLAPSE_PANEL,
            MobileUiPolicy.backAction(false, PanelScreenState.RESULT),
        )
    }

    @Test
    fun outsideTouchProtectsImeAndPasteBeforeCollapsing() {
        assertEquals(
            EditorOutsideAction.KEEP_EDITING,
            MobileUiPolicy.outsideAction(
                editorActive = true,
                contextMenuLikely = false,
                touchInImeArea = true,
            ),
        )
        assertEquals(
            EditorOutsideAction.KEEP_EDITING,
            MobileUiPolicy.outsideAction(
                editorActive = true,
                contextMenuLikely = true,
                touchInImeArea = false,
            ),
        )
        assertEquals(
            EditorOutsideAction.HIDE_EDITOR,
            MobileUiPolicy.outsideAction(
                editorActive = true,
                contextMenuLikely = false,
                touchInImeArea = false,
            ),
        )
        assertEquals(
            EditorOutsideAction.COLLAPSE_PANEL,
            MobileUiPolicy.outsideAction(
                editorActive = false,
                contextMenuLikely = false,
                touchInImeArea = false,
            ),
        )
    }

    @Test
    fun imePaddingIsClampedNonAccumulatingAndSubtractsWindowResize() {
        val first = MobileUiPolicy.imeBottomPadding(
            imeBottom = 620,
            systemBarBottom = 40,
            maximum = 280,
        )
        val repeated = MobileUiPolicy.imeBottomPadding(
            imeBottom = 620,
            systemBarBottom = 40,
            maximum = 280,
        )
        assertEquals(280, first)
        assertEquals(first, repeated)
        assertEquals(
            0,
            MobileUiPolicy.imeBottomPadding(
                imeBottom = 620,
                systemBarBottom = 40,
                maximum = 280,
                alreadyResizedBy = 580,
            ),
        )
        assertEquals(
            80,
            MobileUiPolicy.imeBottomPadding(
                imeBottom = 620,
                systemBarBottom = 40,
                maximum = 280,
                alreadyResizedBy = 500,
            ),
        )
    }

    @Test
    fun onlyMovementInsideTouchSlopCountsAsATap() {
        assertTrue(MobileUiPolicy.isConfirmedTap(4f, -5f, 8))
        assertTrue(MobileUiPolicy.isConfirmedTap(8f, 8f, 8))
        assertFalse(MobileUiPolicy.isConfirmedTap(9f, 0f, 8))
        assertFalse(MobileUiPolicy.isConfirmedTap(0f, -12f, 8))
    }

    @Test
    fun popupMayMovePastEdgesButKeepsARecoverableStripVisible() {
        val range = MobileUiPolicy.popupPositionRange(
            popupSize = 700,
            screenSize = 1080,
            recoverableEdge = 96,
        )
        assertEquals(-604, range.first)
        assertEquals(984, range.last)
        assertTrue(-200 in range)
        assertFalse(-700 in range)
    }
}
