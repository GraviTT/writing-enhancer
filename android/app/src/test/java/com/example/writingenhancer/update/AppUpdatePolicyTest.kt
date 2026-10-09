package com.example.writingenhancer.update

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdatePolicyTest {
    private val base = "https://github.com/GraviTT/writing-enhancer/releases/download/v0.6.2/"

    private fun release(
        tag: String = "v0.6.2",
        draft: Boolean = false,
        prerelease: Boolean = false,
        assets: List<Triple<String, String, Long>> = listOf(
            Triple("WritingEnhancer-0.6.2.apk", base + "WritingEnhancer-0.6.2.apk", 1_300_000L),
            Triple("SHA256SUMS.txt", base + "SHA256SUMS.txt", 300L),
            Triple("Writing-Enhancer-0.6.2-portable.zip", base + "Writing-Enhancer-0.6.2-portable.zip", 9_000_000L),
        ),
    ): String = JSONObject()
        .put("tag_name", tag)
        .put("draft", draft)
        .put("prerelease", prerelease)
        .put("html_url", "https://github.com/GraviTT/writing-enhancer/releases/tag/$tag")
        .put(
            "assets",
            JSONArray(
                assets.map { (name, url, size) ->
                    JSONObject().put("name", name).put("browser_download_url", url).put("size", size)
                },
            ),
        )
        .toString()

    @Test
    fun comparesSemanticVersions() {
        assertTrue(AppUpdatePolicy.isNewer("0.6.1", "0.6.0"))
        assertTrue(AppUpdatePolicy.isNewer("v0.10.0", "0.9.9"))
        assertTrue(AppUpdatePolicy.isNewer("1.0.0", "0.99.99"))
        assertFalse(AppUpdatePolicy.isNewer("0.6.0", "0.6.0"))
        assertFalse(AppUpdatePolicy.isNewer("0.5.9", "0.6.0"))
        assertFalse(AppUpdatePolicy.isNewer("0.6.1-beta", "0.6.0"))
        assertFalse(AppUpdatePolicy.isNewer("0.6.1", "debug"))
    }

    @Test
    fun picksTheApkAndChecksumsFromTheLatestRelease() {
        val update = AppUpdatePolicy.parseRelease(release(), "0.6.1")!!
        assertEquals("0.6.2", update.version)
        assertEquals("WritingEnhancer-0.6.2.apk", update.apk.name)
        assertEquals(base + "SHA256SUMS.txt", update.checksums.url)
        assertNull(AppUpdatePolicy.parseRelease(release(), "0.6.2"))
        assertNull(AppUpdatePolicy.parseRelease(release(draft = true), "0.6.1"))
        assertNull(AppUpdatePolicy.parseRelease(release(prerelease = true), "0.6.1"))
        assertNull(AppUpdatePolicy.parseRelease("not json", "0.6.1"))
    }

    @Test
    fun ignoresAssetsOutsideThisRepositoryOrWithBadSizes() {
        val foreign = release(
            assets = listOf(
                Triple("WritingEnhancer-0.6.2.apk", "https://example.com/WritingEnhancer-0.6.2.apk", 1_000L),
                Triple("SHA256SUMS.txt", base + "SHA256SUMS.txt", 300L),
            ),
        )
        assertNull(AppUpdatePolicy.parseRelease(foreign, "0.6.1"))
        val empty = release(
            assets = listOf(
                Triple("WritingEnhancer-0.6.2.apk", base + "WritingEnhancer-0.6.2.apk", 0L),
                Triple("SHA256SUMS.txt", base + "SHA256SUMS.txt", 300L),
            ),
        )
        assertNull(AppUpdatePolicy.parseRelease(empty, "0.6.1"))
        val missingSums = release(
            assets = listOf(Triple("WritingEnhancer-0.6.2.apk", base + "WritingEnhancer-0.6.2.apk", 1_000L)),
        )
        assertNull(AppUpdatePolicy.parseRelease(missingSums, "0.6.1"))
    }

    @Test
    fun readsChecksumLines() {
        val hash = "a".repeat(64)
        val other = "B".repeat(64)
        val sums = AppUpdatePolicy.parseChecksums(
            "$hash  WritingEnhancer-0.6.2.apk\n$other *Writing-Enhancer-0.6.2-portable.zip\nnot a line\n",
        )
        assertEquals(hash, sums["WritingEnhancer-0.6.2.apk"])
        assertEquals("b".repeat(64), sums["Writing-Enhancer-0.6.2-portable.zip"])
        assertEquals(2, sums.size)
    }
}
