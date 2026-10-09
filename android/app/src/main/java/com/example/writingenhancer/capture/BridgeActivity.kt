package com.example.writingenhancer.capture

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.speech.RecognizerIntent
import android.widget.Toast
import com.example.writingenhancer.ai.AttachmentPolicy
import com.example.writingenhancer.data.WorkspacePolicy
import com.example.writingenhancer.overlay.OverlayService
import java.io.File
import java.util.Locale
import java.util.UUID

/**
 * A short-lived, translucent activity is required for Android system result
 * contracts. It never displays app UI; file, speech and screen-capture consent
 * are all initiated by an explicit user tap in the overlay.
 */
class BridgeActivity : Activity() {
    private var operation: String = ""
    private var target: String = TARGET_RAW
    private var completionDispatched = false
    private var externalLaunched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        operation = intent.action.orEmpty()
        target = intent.getStringExtra(EXTRA_TARGET) ?: TARGET_RAW
        externalLaunched = savedInstanceState?.getBoolean(STATE_EXTERNAL_LAUNCHED) == true
        if (externalLaunched) return
        runCatching {
            when (operation) {
                ACTION_PICK_ATTACHMENT -> launchPicker()
                ACTION_CAPTURE_SCREEN -> launchScreenConsent()
                ACTION_SPEECH -> ensureAudioPermissionAndLaunch()
                else -> {
                    notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
                    finishWithoutAnimation()
                }
            }
        }.onFailure { failure ->
            notifyOverlay(
                OverlayService.ACTION_BRIDGE_ERROR,
                mapOf(
                    OverlayService.EXTRA_MESSAGE to
                        (failure.message ?: "시스템 기능을 열지 못했어요."),
                ),
            )
            finishWithoutAnimation()
        }
    }

    override fun onDestroy() {
        if (!completionDispatched && !isChangingConfigurations) {
            notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
        }
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(STATE_EXTERNAL_LAUNCHED, externalLaunched)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Uses platform result APIs to keep the app dependency-free.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQUEST_FILE -> {
                if (resultCode == RESULT_OK && data?.data != null) {
                    importAttachment(data.data!!)
                } else {
                    notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
                }
                finishWithoutAnimation()
            }

            REQUEST_SCREEN -> {
                if (resultCode == RESULT_OK && data != null) {
                    val capture = Intent(this, ScreenCaptureService::class.java)
                        .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                        .putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
                        .putExtra(ScreenCaptureService.EXTRA_TARGET, target)
                    runCatching { startForegroundService(capture) }
                        .onSuccess { completionDispatched = true }
                        .onFailure {
                            notifyOverlay(
                                OverlayService.ACTION_BRIDGE_ERROR,
                                mapOf(
                                    OverlayService.EXTRA_MESSAGE to
                                        "화면 캡처 서비스를 시작하지 못했어요.",
                                ),
                            )
                        }
                } else {
                    notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
                }
                finishWithoutAnimation()
            }

            REQUEST_SPEECH -> {
                if (resultCode == RESULT_OK) {
                    val spoken = data
                        ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                        ?.firstOrNull()
                        .orEmpty()
                    if (spoken.isNotBlank()) {
                        notifyOverlay(
                            OverlayService.ACTION_SPEECH_RESULT,
                            mapOf(
                                OverlayService.EXTRA_TEXT to spoken,
                                OverlayService.EXTRA_TARGET to target,
                            ),
                        )
                    } else {
                        notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
                    }
                } else {
                    notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
                }
                finishWithoutAnimation()
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_AUDIO) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            launchSpeech()
        } else {
            Toast.makeText(this, "음성 입력을 사용하려면 마이크 권한이 필요해요.", Toast.LENGTH_SHORT)
                .show()
            notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
            finishWithoutAnimation()
        }
    }

    private fun launchPicker() {
        externalLaunched = true
        @Suppress("DEPRECATION")
        startActivityForResult(
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                if (target == TARGET_SIDE_CHAT_VISUAL) {
                    type = "image/*"
                } else {
                    type = "*/*"
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf(
                            "image/*",
                            "text/*",
                            "application/pdf",
                            "application/json",
                        ),
                    )
                }
            },
            REQUEST_FILE,
        )
    }

    private fun launchScreenConsent() {
        externalLaunched = true
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_SCREEN)
    }

    private fun ensureAudioPermissionAndLaunch() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            launchSpeech()
        } else {
            externalLaunched = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
        }
    }

    private fun launchSpeech() {
        val speechIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.KOREAN.toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PROMPT, "편하게 말씀하세요")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        if (speechIntent.resolveActivity(packageManager) == null) {
            Toast.makeText(this, "이 기기에서 음성 인식을 사용할 수 없어요.", Toast.LENGTH_SHORT).show()
            notifyOverlay(OverlayService.ACTION_CAPTURE_CANCELLED)
            finishWithoutAnimation()
            return
        }
        externalLaunched = true
        @Suppress("DEPRECATION")
        startActivityForResult(speechIntent, REQUEST_SPEECH)
    }

    private fun importAttachment(uri: Uri) {
        val resolver = contentResolver
        val displayName = AttachmentPolicy.sanitizeDisplayName(queryDisplayName(uri))
        val mimeType = AttachmentPolicy.normalizeMime(resolver.getType(uri), displayName)
        if (target == TARGET_SIDE_CHAT_VISUAL && !mimeType.startsWith("image/")) {
            notifyOverlay(
                OverlayService.ACTION_BRIDGE_ERROR,
                mapOf(OverlayService.EXTRA_MESSAGE to "검색에는 이미지 파일만 첨부할 수 있어요."),
            )
            return
        }
        if (!AttachmentPolicy.isSupportedMime(mimeType)) {
            notifyOverlay(
                OverlayService.ACTION_BRIDGE_ERROR,
                mapOf(
                    OverlayService.EXTRA_MESSAGE to
                        "PNG·JPG·WEBP·GIF·PDF·TXT·MD·CSV·JSON 파일을 첨부할 수 있어요.",
                ),
            )
            return
        }
        val directoryName = if (target == TARGET_SIDE_CHAT_VISUAL) {
            SIDE_CHAT_CAPTURE_DIRECTORY
        } else {
            ATTACHMENT_DIRECTORY
        }
        val directory = File(filesDir, directoryName).apply { mkdirs() }
        val safeName = displayName.replace(Regex("""[^\p{L}\p{N}._ -]"""), "_").take(80)
        val destination = File(directory, "${UUID.randomUUID()}-${safeName.ifBlank { "첨부" }}")
        var total = 0L
        try {
            resolver.openInputStream(uri)?.use { input ->
                destination.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > WorkspacePolicy.MAX_ATTACHMENT_BYTES) {
                            throw IllegalArgumentException("파일은 8MB까지 첨부할 수 있어요.")
                        }
                        output.write(buffer, 0, count)
                    }
                }
            } ?: throw IllegalArgumentException("파일을 읽을 수 없어요.")
            if (AttachmentPolicy.isBinaryMultimodal(mimeType)) {
                val header = destination.inputStream().use { input ->
                    val buffer = ByteArray(1029)
                    val count = input.read(buffer)
                    if (count <= 0) byteArrayOf() else buffer.copyOf(count)
                }
                if (!AttachmentPolicy.magicMatches(mimeType, header)) {
                    throw IllegalArgumentException("파일 형식과 실제 내용이 일치하지 않아요.")
                }
            }
            notifyOverlay(
                OverlayService.ACTION_ATTACHMENT_RESULT,
                mapOf(
                    OverlayService.EXTRA_PATH to destination.absolutePath,
                    OverlayService.EXTRA_NAME to displayName,
                    OverlayService.EXTRA_MIME to mimeType,
                    OverlayService.EXTRA_SIZE to total,
                    OverlayService.EXTRA_SOURCE to "file",
                ),
            )
        } catch (failure: Throwable) {
            destination.delete()
            notifyOverlay(
                OverlayService.ACTION_BRIDGE_ERROR,
                mapOf(OverlayService.EXTRA_MESSAGE to (failure.message ?: "파일을 첨부하지 못했어요.")),
            )
        }
    }

    private fun queryDisplayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    return cursor.getString(0) ?: "첨부 파일"
                }
            }
        return uri.lastPathSegment ?: "첨부 파일"
    }

    private fun notifyOverlay(action: String, values: Map<String, Any> = emptyMap()) {
        if (completionDispatched) return
        val service = Intent(this, OverlayService::class.java)
            .setAction(action)
            .putExtra(OverlayService.EXTRA_TARGET, target)
        values.forEach { (key, value) ->
            when (value) {
                is String -> service.putExtra(key, value)
                is Long -> service.putExtra(key, value)
                is Int -> service.putExtra(key, value)
            }
        }
        if (OverlayService.startIfMarkedRunning(this, service)) {
            completionDispatched = true
        }
    }

    private fun finishWithoutAnimation() {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    companion object {
        const val ACTION_PICK_ATTACHMENT =
            "com.example.writingenhancer.action.PICK_ATTACHMENT"
        const val ACTION_CAPTURE_SCREEN =
            "com.example.writingenhancer.action.CAPTURE_SCREEN"
        const val ACTION_SPEECH =
            "com.example.writingenhancer.action.SPEECH"
        const val EXTRA_TARGET = "target"
        const val TARGET_RAW = "raw"
        const val TARGET_SITUATION = "situation"
        const val TARGET_ANSWER = "answer"
        const val TARGET_SIDE_CHAT_SCREEN = "side_chat_screen"
        const val TARGET_SIDE_CHAT_VISUAL = "side_chat_visual"
        const val ATTACHMENT_DIRECTORY = "attachments"
        const val SIDE_CHAT_CAPTURE_DIRECTORY = "side-chat-captures"

        private const val REQUEST_FILE = 301
        private const val REQUEST_SCREEN = 302
        private const val REQUEST_SPEECH = 303
        private const val REQUEST_AUDIO = 304
        private const val STATE_EXTERNAL_LAUNCHED = "external_launched"
    }
}
