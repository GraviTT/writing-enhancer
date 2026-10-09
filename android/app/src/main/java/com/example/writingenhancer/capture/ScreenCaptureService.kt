package com.example.writingenhancer.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.view.WindowManager
import com.example.writingenhancer.R
import com.example.writingenhancer.data.WorkspacePolicy
import com.example.writingenhancer.overlay.OverlayService
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

class ScreenCaptureService : Service() {
    private val completed = AtomicBoolean(false)
    private lateinit var workerThread: HandlerThread
    private lateinit var worker: Handler
    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: android.hardware.display.VirtualDisplay? = null
    private var captureTarget: String = BridgeActivity.TARGET_RAW
    private var captureReadyAt = 0L
    private var delayedDrain: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        captureTarget = intent?.getStringExtra(EXTRA_TARGET) ?: BridgeActivity.TARGET_RAW
        try {
            startCaptureForeground()
        } catch (failure: Throwable) {
            fail(failure.message ?: "화면 캡처 서비스를 시작하지 못했어요.")
            return START_NOT_STICKY
        }
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        val resultData = parcelableIntent(intent, EXTRA_RESULT_DATA)
        if (resultCode == Int.MIN_VALUE || resultData == null) {
            fail("화면 캡처 권한 정보를 받지 못했어요.")
            return START_NOT_STICKY
        }
        workerThread = HandlerThread("writing-enhancer-capture").also { it.start() }
        worker = Handler(workerThread.looper)
        runCatching { beginProjection(resultCode, resultData) }
            .onFailure { fail(it.message ?: "화면을 캡처하지 못했어요.") }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseResources()
        super.onDestroy()
    }

    private fun startCaptureForeground() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "화면 첨부",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "사용자가 요청한 현재 화면 한 장을 첨부합니다."
                setShowBadge(false)
            },
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("현재 화면을 첨부하는 중")
            .setContentText("한 장을 저장하면 바로 종료됩니다.")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun beginProjection(resultCode: Int, resultData: Intent) {
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val activeProjection = manager.getMediaProjection(resultCode, resultData)
            ?: throw IllegalStateException("화면 공유 세션을 시작할 수 없어요.")
        projection = activeProjection
        activeProjection.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    if (!completed.get()) fail("화면 공유가 중단됐어요.")
                }
            },
            worker,
        )

        val (screenWidth, screenHeight) = screenSize()
        val captureSize = CaptureImagePolicy.fitCapture(screenWidth, screenHeight)
        val width = captureSize.width
        val height = captureSize.height
        val density = resources.displayMetrics.densityDpi
        val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        reader = imageReader
        captureReadyAt = SystemClock.uptimeMillis() + CAPTURE_SETTLE_MS
        imageReader.setOnImageAvailableListener(
            { source -> drainLatestImage(source, width, height) },
            worker,
        )
        display = activeProjection.createVirtualDisplay(
            "WritingEnhancerSingleScreenshot",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.surface,
            null,
            worker,
        )

        // Register before the virtual display starts. A static launcher may emit
        // only its first frame; registering after the consent animation could
        // therefore wait forever even though a usable image was already queued.
        delayedDrain = Runnable { drainLatestImage(imageReader, width, height) }.also {
            worker.postAtTime(it, captureReadyAt)
        }
        worker.postDelayed({ fail("화면을 캡처하는 데 시간이 너무 오래 걸렸어요.") }, TIMEOUT_MS)
    }

    private fun drainLatestImage(source: ImageReader, width: Int, height: Int) {
        if (completed.get()) return
        val remaining = captureReadyAt - SystemClock.uptimeMillis()
        if (remaining > 0L) {
            // Leave the newest frame queued. The scheduled read at
            // captureReadyAt can then capture even when the launcher is static.
            return
        }
        val image = runCatching { source.acquireLatestImage() }.getOrNull() ?: return
        saveImage(image, width, height)
    }

    private fun saveImage(image: Image, width: Int, height: Int) {
        if (!completed.compareAndSet(false, true)) {
            image.close()
            return
        }
        var padded: Bitmap? = null
        var cropped: Bitmap? = null
        var destination: File? = null
        var failureMessage: String? = null
        try {
            val plane = image.planes.first()
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * width
            val paddedWidth = width + rowPadding / pixelStride
            padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
            padded.copyPixelsFromBuffer(buffer)
            cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
            val directoryName = if (captureTarget == BridgeActivity.TARGET_SIDE_CHAT_SCREEN) {
                BridgeActivity.SIDE_CHAT_CAPTURE_DIRECTORY
            } else {
                BridgeActivity.ATTACHMENT_DIRECTORY
            }
            val directory = File(filesDir, directoryName).apply { mkdirs() }
            val outputFile = File(directory, "화면-${System.currentTimeMillis()}.png")
            destination = outputFile
            if (!writeBoundedPng(requireNotNull(cropped), outputFile)) {
                throw IllegalStateException("현재 화면을 8MB 이하로 준비하지 못했어요.")
            }
            val result = Intent(this, OverlayService::class.java)
                .setAction(OverlayService.ACTION_ATTACHMENT_RESULT)
                .putExtra(OverlayService.EXTRA_PATH, outputFile.absolutePath)
                .putExtra(OverlayService.EXTRA_NAME, "현재 화면.png")
                .putExtra(OverlayService.EXTRA_MIME, "image/png")
                .putExtra(OverlayService.EXTRA_SIZE, outputFile.length())
                .putExtra(OverlayService.EXTRA_SOURCE, "screenshot")
                .putExtra(OverlayService.EXTRA_TARGET, captureTarget)
            if (!OverlayService.startIfMarkedRunning(this, result)) {
                outputFile.delete()
            }
        } catch (failure: Throwable) {
            failureMessage = failure.message ?: "화면 이미지를 저장하지 못했어요."
            runCatching { destination?.delete() }
        } finally {
            image.close()
            runCatching { if (cropped !== padded) cropped?.recycle() }
            runCatching { padded?.recycle() }
        }
        if (failureMessage != null) {
            completed.set(false)
            fail(failureMessage)
        } else {
            finishCapture()
        }
    }

    private fun writeBoundedPng(source: Bitmap, outputFile: File): Boolean {
        var current = source
        var ownsCurrent = false
        return try {
            repeat(MAX_PNG_ATTEMPTS) {
                FileOutputStream(outputFile, false).use { output ->
                    check(current.compress(Bitmap.CompressFormat.PNG, 100, output))
                }
                if (outputFile.length() in 1..WorkspacePolicy.MAX_ATTACHMENT_BYTES) return true

                val next = CaptureImagePolicy.nextPngSize(current.width, current.height)
                if (next.width == current.width && next.height == current.height) return false
                val scaled = Bitmap.createScaledBitmap(current, next.width, next.height, true)
                if (ownsCurrent) runCatching { current.recycle() }
                current = scaled
                ownsCurrent = true
            }
            false
        } finally {
            if (ownsCurrent) runCatching { current.recycle() }
            if (outputFile.length() !in 1..WorkspacePolicy.MAX_ATTACHMENT_BYTES) {
                runCatching { outputFile.delete() }
            }
        }
    }

    private fun fail(message: String) {
        if (!completed.compareAndSet(false, true)) return
        try {
            OverlayService.startIfMarkedRunning(
                this,
                Intent(this, OverlayService::class.java)
                    .setAction(OverlayService.ACTION_BRIDGE_ERROR)
                    .putExtra(OverlayService.EXTRA_MESSAGE, message)
                    .putExtra(OverlayService.EXTRA_TARGET, captureTarget),
            )
        } finally {
            finishCapture()
        }
    }

    private fun finishCapture() {
        releaseResources()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun releaseResources() {
        if (::worker.isInitialized) {
            delayedDrain?.let(worker::removeCallbacks)
        }
        delayedDrain = null
        runCatching { display?.release() }
        display = null
        runCatching { reader?.close() }
        reader = null
        runCatching { projection?.stop() }
        projection = null
        if (::workerThread.isInitialized) {
            workerThread.quitSafely()
        }
    }

    private fun screenSize(): Pair<Int, Int> {
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = manager.maximumWindowMetrics.bounds
            bounds.width() to bounds.height()
        } else {
            @Suppress("DEPRECATION")
            val point = Point().also { manager.defaultDisplay.getRealSize(it) }
            point.x to point.y
        }
    }

    @Suppress("DEPRECATION")
    private fun parcelableIntent(container: Intent?, key: String): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            container?.getParcelableExtra(key, Intent::class.java)
        } else {
            container?.getParcelableExtra(key)
        }

    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        const val EXTRA_TARGET = "target"

        private const val CHANNEL_ID = "writing_enhancer_screen_capture"
        private const val NOTIFICATION_ID = 7402
        private const val CAPTURE_SETTLE_MS = 500L
        private const val TIMEOUT_MS = 10_000L
        private const val MAX_PNG_ATTEMPTS = 12
    }
}
