package com.example.writingenhancer.update

import org.json.JSONObject

data class ReleaseAsset(val name: String, val url: String, val size: Long)

/** GitHub 최신 릴리스에서 찾은, 지금보다 새 버전의 Android 설치 파일. */
data class AvailableUpdate(
    val version: String,
    val apk: ReleaseAsset,
    val checksums: ReleaseAsset,
    val pageUrl: String,
)

/**
 * 업데이트 판단 규칙. 공개 GitHub 저장소의 최신 릴리스(초안·사전 배포 제외)에서
 * `WritingEnhancer-<버전>.apk`와 `SHA256SUMS.txt`를 찾는다. Windows 앱(desktop/src/lib/updater.js)도
 * 같은 릴리스·같은 이름 규칙을 쓴다.
 */
object AppUpdatePolicy {
    const val REPOSITORY = "GraviTT/writing-enhancer"
    const val LATEST_RELEASE_URL = "https://api.github.com/repos/$REPOSITORY/releases/latest"
    const val CHECKSUM_ASSET = "SHA256SUMS.txt"
    const val MAX_APK_BYTES = 100L * 1024 * 1024
    private const val DOWNLOAD_PREFIX = "https://github.com/$REPOSITORY/releases/download/"
    private val VERSION = Regex("""^v?(\d+)\.(\d+)\.(\d+)$""")
    private val CHECKSUM_LINE = Regex("""^([0-9a-fA-F]{64})\s+\*?(\S+)$""")

    fun apkAssetName(version: String): String = "WritingEnhancer-$version.apk"

    fun parseVersion(value: String?): List<Int>? =
        VERSION.matchEntire(value.orEmpty().trim())?.groupValues?.drop(1)?.map(String::toInt)

    /** [candidate]가 [current]보다 새 버전인지. 버전 형식이 아니면 false. */
    fun isNewer(candidate: String, current: String): Boolean {
        val next = parseVersion(candidate) ?: return false
        val now = parseVersion(current) ?: return false
        for (index in 0 until 3) {
            if (next[index] != now[index]) return next[index] > now[index]
        }
        return false
    }

    /** 이 저장소의 릴리스 다운로드 주소만 받는다. GitHub가 실제 파일 서버로 넘겨 준다. */
    fun isTrustedDownload(url: String): Boolean = url.startsWith(DOWNLOAD_PREFIX)

    fun parseChecksums(text: String): Map<String, String> =
        text.lineSequence()
            .mapNotNull { CHECKSUM_LINE.matchEntire(it.trim()) }
            .associate { it.groupValues[2] to it.groupValues[1].lowercase() }

    /** GitHub `releases/latest` 응답에서 지금보다 새 버전의 설치 파일을 고른다. */
    fun parseRelease(json: String, currentVersion: String): AvailableUpdate? {
        val release = runCatching { JSONObject(json) }.getOrNull() ?: return null
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null
        val version = release.optString("tag_name").removePrefix("v")
        if (!isNewer(version, currentVersion)) return null
        val assets = release.optJSONArray("assets") ?: return null
        val found = (0 until assets.length()).mapNotNull { index ->
            val asset = assets.optJSONObject(index) ?: return@mapNotNull null
            ReleaseAsset(
                name = asset.optString("name"),
                url = asset.optString("browser_download_url"),
                size = asset.optLong("size", -1L),
            ).takeIf { isTrustedDownload(it.url) }
        }
        val apk = found.firstOrNull { it.name == apkAssetName(version) } ?: return null
        val checksums = found.firstOrNull { it.name == CHECKSUM_ASSET } ?: return null
        if (apk.size !in 1..MAX_APK_BYTES) return null
        return AvailableUpdate(version, apk, checksums, release.optString("html_url"))
    }
}
