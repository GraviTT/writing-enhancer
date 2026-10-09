package com.example.writingenhancer

import android.app.Instrumentation
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.content.Context
import android.text.Spanned
import android.text.style.StyleSpan
import com.example.writingenhancer.ai.WebSource
import com.example.writingenhancer.data.DraftState
import com.example.writingenhancer.data.ResultVersion
import com.example.writingenhancer.data.SideChatStore
import com.example.writingenhancer.data.WorkspaceStore
import com.example.writingenhancer.security.SecureStore
import com.example.writingenhancer.ui.ChatTextFormatter
import com.example.writingenhancer.ui.Ui

/** Emulator-only fixtures for reproducible native UI screenshots. Not shipped in the app APK. */
class NativeUiQa : Instrumentation() {
    private var options = Bundle()

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        options = arguments ?: Bundle()
        start()
    }

    override fun onStart() {
        try {
            check(Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish")) {
                "UI fixtures must only run on the dedicated emulator."
            }
            val formatted = ChatTextFormatter.render("핵심은 **가독성**입니다. `a_b`는 코드예요.") as Spanned
            check(formatted.toString() == "핵심은 가독성입니다. a_b는 코드예요.")
            check(formatted.getSpans(0, formatted.length, StyleSpan::class.java).size == 1)
            val selectionStart = formatted.indexOf("가독성")
            check(formatted.subSequence(selectionStart, selectionStart + 3).toString() == "가독성")
            check(ChatTextFormatter.render("```text\n**그대로**\n```").toString() == "**그대로**\n")
            runOnMainSync {
                val field = Ui.primaryButton(targetContext, "완성하기")
                Ui.applySurfaceOpacity(field, 0.55f)
                check(field.alpha == 1f)
            }
            val context = targetContext
            val secure = SecureStore(context)
            val store = WorkspaceStore(secure)
            val chat = SideChatStore(secure)
            store.clearDraft()
            store.listHistory().forEach { store.deleteHistory(it.id) }
            chat.clear()
            val scene = options.getString("scene") ?: "input"
            val original = "자료 확인했어 고생 많았다고 전하고 싶어"
            if (scene == "result" || scene == "chat") {
                val result = store.addVersion(null, "동료에게 보낼 메시지", original, emptyList(),
                    ResultVersion("자료 확인했습니다.\n준비하시느라 고생 많으셨어요.\n\n감사합니다.",
                        "동료에게 보내는 감사 메시지로 이해했어요. 조금 더 따뜻한 말투로 다듬어 볼까요?",
                        "UI 검수 예시", 1_788_000_000_000L))
                store.saveDraft(DraftState(rawInput = original, historyId = result.id))
            }
            if (scene == "chat") {
                chat.appendExchange("짧고 읽기 좋은 글은 어떻게 쓸까?",
                    "**핵심을 먼저 전하고, 문장을 짧게 나눠 보세요.**\n\n" +
                    "- 한 문장에는 한 가지 생각을 담아요.\n- 긴 설명은 짧은 문단으로 나눠요.\n- 가장 중요한 말은 앞에 두세요.\n\n" +
                    "지금 쓰고 있는 글도 이 방향으로 함께 다듬을 수 있어요.",
                    listOf(WebSource("읽기 쉬운 글 · 예시 출처", "https://example.com/writing"),
                        WebSource("문장과 문단 · 예시 출처", "https://example.com/paragraphs")),
                    listOf("더 간결하게 쓰는 방법", "따뜻한 말투로 바꾸기"))
                check(chat.list().size == 2) { "Chat fixture did not persist" }
            }
            val density = context.resources.displayMetrics.density
            val width = ((options.getString("width")?.toInt() ?: 380) * density).toInt()
            val height = ((options.getString("height")?.toInt() ?: 720) * density).toInt()
            context.getSharedPreferences("panel_geometry", Context.MODE_PRIVATE).edit()
                .putInt("width", width).putInt("height", height)
                .putInt("x", ((context.resources.displayMetrics.widthPixels - width) / 2).coerceAtLeast(0))
                .putInt("y", (40 * density).toInt()).commit()
            context.getSharedPreferences("bubble_state", Context.MODE_PRIVATE).edit()
                .putBoolean("running", false)
                .putString("last_panel_surface", if (scene == "chat") "SIDE_CHAT" else "WRITING").commit()
            // Instrumentation finish may kill its process before SharedPreferences.apply flushes.
            context.getSharedPreferences("secure_local_data", Context.MODE_PRIVATE).edit().commit()
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "Native text/opacity checks passed; fixture: $scene\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "FAILED: ${error.message}\n") })
        }
    }
}
