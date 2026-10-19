package com.example.writingenhancer.process

import com.example.writingenhancer.ai.SharedWritingRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Windows의 desktop/tests/situation-presets.test.js와 같은 사례를 확인한다.
class SituationPresetPolicyTest {
    private val defaults = SituationPresetPolicy.defaults()

    @Test
    fun withoutCustomizationTheSharedDefaultsAreUsed() {
        assertEquals(SharedWritingRules.SITUATIONS.map { it.label }, defaults.map { it.label })
        assertEquals(defaults, SituationPresetPolicy.normalize(null))
        assertEquals(emptyList<SituationPresetPolicy.Preset>(), SituationPresetPolicy.normalize(emptyList()))
    }

    @Test
    fun newButtonsCollapseWhitespaceAndShortenTheLabel() {
        val outcome = SituationPresetPolicy.add(defaults, "  친구에게\n보내는   생일 축하 메시지  ")
        assertTrue(outcome.added)
        val last = outcome.list.last()
        assertEquals("친구에게 보내는 생일 축하 메시지", last.text)
        assertEquals("친구에게 보내는…", last.label)
        assertTrue(last.label.length <= SharedWritingRules.MAX_SITUATION_LABEL)
        assertEquals("짧은 상황", SituationPresetPolicy.labelFor("짧은 상황"))
    }

    @Test
    fun emptyDuplicateAndFullListsAreNotSaved() {
        assertEquals("empty", SituationPresetPolicy.add(defaults, "   ").reason)
        assertEquals("duplicate", SituationPresetPolicy.add(defaults, "업무 메일").reason)
        var list = emptyList<SituationPresetPolicy.Preset>()
        repeat(SharedWritingRules.MAX_SITUATIONS) { index ->
            list = SituationPresetPolicy.add(list, "상황 $index").list
        }
        assertEquals(SharedWritingRules.MAX_SITUATIONS, list.size)
        assertEquals("full", SituationPresetPolicy.add(list, "하나 더").reason)
    }

    @Test
    fun removingAndNormalizingStoredButtons() {
        val removed = SituationPresetPolicy.remove(defaults, "업무 메일")
        assertFalse(removed.any { it.text == "업무 메일" })
        assertEquals(defaults.size - 1, removed.size)
        val messy = listOf(
            SituationPresetPolicy.Preset("", "  고객 응대  "),
            SituationPresetPolicy.Preset("중복", "고객 응대"),
            SituationPresetPolicy.Preset("빈 값", "   "),
        ) + (0 until 20).map { SituationPresetPolicy.Preset("L$it", "T$it") }
        val normalized = SituationPresetPolicy.normalize(messy)
        assertEquals("고객 응대", normalized.first().text)
        assertEquals("고객 응대", normalized.first().label)
        assertEquals(1, normalized.count { it.text == "고객 응대" })
        assertEquals(SharedWritingRules.MAX_SITUATIONS, normalized.size)
    }

    @Test
    fun storedListsRoundTripThroughJson() {
        val custom = SituationPresetPolicy.add(SituationPresetPolicy.remove(defaults, "사과"), "동아리 공지").list
        assertEquals(custom, SituationPresetPolicy.decode(SituationPresetPolicy.encode(custom)))
        assertNull(SituationPresetPolicy.decode(null))
        assertNull(SituationPresetPolicy.decode("깨진 값"))
        assertEquals(emptyList<SituationPresetPolicy.Preset>(), SituationPresetPolicy.decode("[]"))
    }

    @Test
    fun foldedSituationButtonShowsTheChosenSituation() {
        assertEquals("＋ 상황 고르기 · 선택", SelectionTextPolicy.situationToggleLabel(open = false, situation = " "))
        assertEquals("상황 접기", SelectionTextPolicy.situationToggleLabel(open = true, situation = "업무 메일"))
        assertEquals("상황 ✓ 업무 메일", SelectionTextPolicy.situationToggleLabel(open = false, situation = "업무 메일"))
        assertEquals("선택한 글 · 34자 · 고쳐 써도 돼요", SelectionTextPolicy.originalLabel(34))
    }
}
