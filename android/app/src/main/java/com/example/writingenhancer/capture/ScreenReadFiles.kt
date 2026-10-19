package com.example.writingenhancer.capture

import android.content.Context
import java.io.File

/**
 * "화면 글 읽기"에 쓰는 캡처 이미지 폴더. 화면 전체 캡처와 잘라 낸 부분이 잠깐 머물고,
 * 글을 읽은 뒤(또는 취소하면) 지운다. 다른 앱이 보낸 경로는 이 폴더 밖이면 쓰지 않는다.
 */
object ScreenReadFiles {
    const val DIRECTORY = "read-captures"

    fun directory(context: Context): File = File(context.filesDir, DIRECTORY)

    fun resolve(context: Context, path: String?): File? {
        val candidate = path?.takeIf { it.isNotBlank() }?.let(::File) ?: return null
        val rootPath = runCatching { directory(context).canonicalPath }.getOrNull() ?: return null
        val candidatePath = runCatching { candidate.canonicalPath }.getOrNull() ?: return null
        return candidate.takeIf { it.isFile && candidatePath.startsWith(rootPath + File.separator) }
    }

    /** 남아 있는 캡처를 모두 지운다(앱이 중간에 끝났을 때 남은 것 포함). */
    fun clear(context: Context) {
        directory(context).listFiles()?.forEach { runCatching { it.delete() } }
    }
}
