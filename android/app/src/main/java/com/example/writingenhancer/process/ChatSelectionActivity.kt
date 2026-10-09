package com.example.writingenhancer.process

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import com.example.writingenhancer.MainActivity
import com.example.writingenhancer.overlay.OverlayService

/**
 * 다른 앱의 텍스트 선택 메뉴에서 `글 강화기 채팅`을 고르면 열린다.
 * 선택한 글을 사이드 채팅 입력칸에 넣고 버블 창의 사이드 채팅을 연다. 화면은 따로 없다.
 */
class ChatSelectionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val draft = SelectionTextPolicy.chatDraft(intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT))
        when {
            draft == null -> Toast.makeText(this, "선택한 글이 없어요.", Toast.LENGTH_SHORT).show()
            !Settings.canDrawOverlays(this) -> {
                Toast.makeText(this, "먼저 글 강화기에서 화면 위 표시를 허용해 주세요.", Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            else -> startForegroundService(
                Intent(this, OverlayService::class.java)
                    .setAction(OverlayService.ACTION_OPEN_CHAT_TEXT)
                    .putExtra(OverlayService.EXTRA_TEXT, draft),
            )
        }
        finish()
    }
}
