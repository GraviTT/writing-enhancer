package com.example.writingenhancer.capture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.example.writingenhancer.data.WorkspacePolicy
import com.example.writingenhancer.overlay.OverlayService
import com.example.writingenhancer.process.EnhanceSelectionActivity
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * User-visible preview and drag selection for a one-shot side-chat visual search.
 * In read mode ("화면 글 읽기") the chosen part is handed to the 글 강화 dialog, which reads its text.
 */
class ImageCropActivity : Activity() {
    private var completionDispatched = false
    private var readMode = false
    // 미리보기는 줄여서 열 수 있으므로, 읽기용으로 자를 때는 원래 크기를 기준으로 한다.
    private var originalWidth = 0
    private var originalHeight = 0
    private var sourceBitmap: Bitmap? = null
    private lateinit var cropView: CropSelectionView
    private lateinit var originalFile: File

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readMode = intent.getStringExtra(EXTRA_MODE) == MODE_READ
        val source = resolveSourceFile(intent.getStringExtra(EXTRA_PATH))
        if (source == null) {
            cancelAndFinish("이미지 파일을 찾지 못했어요.")
            return
        }
        originalFile = source
        sourceBitmap = decodeBounded(source)
        val bitmap = sourceBitmap
        if (bitmap == null) {
            cancelAndFinish("이미지를 미리보기로 열지 못했어요.")
            return
        }
        cropView = CropSelectionView(this).apply { setBitmap(bitmap) }
        setContentView(buildContent())
    }

    override fun onDestroy() {
        if (!completionDispatched) notifyCancelled()
        sourceBitmap?.recycle()
        sourceBitmap = null
        super.onDestroy()
    }

    @Deprecated("Uses the platform back callback for the translucent preview activity.")
    override fun onBackPressed() {
        finishKeepingOriginal()
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(18), dp(14), dp(14))
            background = rounded(0xF21B1922.toInt(), 24f)
        }
        root.addView(
            TextView(this).apply {
                text = if (readMode) "읽을 부분 고르기" else "검색 전 이미지 확인"
                textSize = 20f
                setTextColor(Color.WHITE)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
        )
        root.addView(
            TextView(this).apply {
                text = if (readMode) {
                    "글자가 있는 부분을 드래그하세요. 화면 전체를 읽으려면 ‘전체 읽기’를 누르세요."
                } else {
                    "필요한 부분을 드래그하세요. 전체 이미지를 쓰려면 ‘전체 사용’을 누르세요."
                }
                textSize = 13f
                setTextColor(0xFFCCC7D5.toInt())
                setPadding(0, dp(5), 0, dp(10))
            },
        )
        root.addView(
            cropView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setPadding(0, dp(10), 0, 0)
        }
        actions.addView(actionButton("취소", 0xFF34313D.toInt()) { finishKeepingOriginal() })
        actions.addView(
            actionButton(if (readMode) "전체 읽기" else "전체 사용", 0xFF484353.toInt()) {
                if (readMode) readImage(originalFile) else finishKeepingOriginal()
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply {
                marginStart = dp(7)
            },
        )
        actions.addView(
            actionButton(if (readMode) "선택 읽기" else "선택 사용", 0xFF6E56CF.toInt()) { saveSelection() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply {
                marginStart = dp(7)
            },
        )
        root.addView(
            actions,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(58)),
        )
        return FrameLayout(this).apply {
            val edgePadding = dp(8)
            setPadding(edgePadding, edgePadding, edgePadding, edgePadding)
            setOnApplyWindowInsetsListener { view, insets ->
                val navigationBottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    insets.getInsets(WindowInsets.Type.navigationBars()).bottom
                } else {
                    @Suppress("DEPRECATION")
                    insets.stableInsetBottom
                }
                view.setPadding(
                    edgePadding,
                    edgePadding,
                    edgePadding,
                    edgePadding + navigationBottom.coerceAtLeast(0),
                )
                insets
            }
            setBackgroundColor(0x66000000)
            addView(
                root,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
    }

    private fun saveSelection() {
        val selected = if (readMode) {
            cropView.selectedFraction()?.let { runCatching { decodeOriginalRegion(it) }.getOrNull() }
                ?: cropView.selectedBitmap()
        } else {
            cropView.selectedBitmap()
        }
        if (selected == null) {
            Toast.makeText(
                this,
                if (readMode) "읽을 부분을 조금 더 크게 선택해 주세요." else "검색할 영역을 조금 더 크게 선택해 주세요.",
                Toast.LENGTH_SHORT,
            ).show()
            return
        }
        val directory = if (readMode) {
            ScreenReadFiles.directory(this)
        } else {
            File(filesDir, BridgeActivity.SIDE_CHAT_CAPTURE_DIRECTORY)
        }.apply { mkdirs() }
        val output = File(directory, "선택-${UUID.randomUUID()}.png")
        val saved = runCatching { writeBoundedPng(selected, output) }.getOrDefault(false)
        selected.recycle()
        if (!saved) {
            output.delete()
            Toast.makeText(this, "선택 영역을 8MB 이하로 준비하지 못했어요.", Toast.LENGTH_SHORT).show()
            return
        }
        if (readMode) {
            runCatching { originalFile.delete() }
            readImage(output)
            return
        }
        val result = Intent(this, OverlayService::class.java)
            .setAction(OverlayService.ACTION_ATTACHMENT_RESULT)
            .putExtra(OverlayService.EXTRA_PATH, output.absolutePath)
            .putExtra(OverlayService.EXTRA_NAME, "선택 영역.png")
            .putExtra(OverlayService.EXTRA_MIME, "image/png")
            .putExtra(OverlayService.EXTRA_SIZE, output.length())
            .putExtra(OverlayService.EXTRA_SOURCE, intent.getStringExtra(EXTRA_SOURCE) ?: "image")
            .putExtra(OverlayService.EXTRA_TARGET, BridgeActivity.TARGET_SIDE_CHAT_VISUAL)
        if (!OverlayService.startIfMarkedRunning(this, result)) output.delete()
        completionDispatched = true
        finishWithoutAnimation()
    }

    private fun finishKeepingOriginal() {
        notifyCancelled()
        finishWithoutAnimation()
    }

    // 고른 이미지(또는 화면 전체)를 글 강화 창에 넘긴다. 그 창이 글을 읽은 뒤 이미지를 지운다.
    private fun readImage(image: File) {
        val reader = Intent(this, EnhanceSelectionActivity::class.java)
            .putExtra(EnhanceSelectionActivity.EXTRA_IMAGE_PATH, image.absolutePath)
        val opened = runCatching { startActivity(reader) }.isSuccess
        if (!opened) {
            runCatching { image.delete() }
            Toast.makeText(this, "글 강화 창을 열지 못했어요.", Toast.LENGTH_SHORT).show()
            notifyCancelled()
        }
        completionDispatched = true
        finishWithoutAnimation()
    }

    private fun cancelAndFinish(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        notifyCancelled()
        finishWithoutAnimation()
    }

    private fun notifyCancelled() {
        if (completionDispatched) return
        // 읽기를 취소하면 찍어 둔 화면을 남기지 않는다.
        if (readMode && ::originalFile.isInitialized) runCatching { originalFile.delete() }
        OverlayService.startIfMarkedRunning(
            this,
            Intent(this, OverlayService::class.java)
                .setAction(OverlayService.ACTION_CAPTURE_CANCELLED)
                .putExtra(
                    OverlayService.EXTRA_TARGET,
                    if (readMode) BridgeActivity.TARGET_READ_TEXT else BridgeActivity.TARGET_SIDE_CHAT_VISUAL,
                ),
        )
        completionDispatched = true
    }

    private fun finishWithoutAnimation() {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private fun resolveSourceFile(path: String?): File? {
        if (readMode) return ScreenReadFiles.resolve(this, path)
        val root = File(filesDir, BridgeActivity.SIDE_CHAT_CAPTURE_DIRECTORY)
        val candidate = path?.let(::File) ?: return null
        val rootPath = runCatching { root.canonicalPath }.getOrNull() ?: return null
        val candidatePath = runCatching { candidate.canonicalPath }.getOrNull() ?: return null
        return candidate.takeIf {
            it.isFile && candidatePath.startsWith(rootPath + File.separator)
        }
    }

    // 고른 부분(이미지 대비 비율)을 원래 파일에서 원래 해상도로 잘라 낸다.
    private fun decodeOriginalRegion(fraction: RectF): Bitmap? {
        if (originalWidth <= 0 || originalHeight <= 0) return null
        val left = (fraction.left * originalWidth).roundToInt().coerceIn(0, originalWidth - 1)
        val top = (fraction.top * originalHeight).roundToInt().coerceIn(0, originalHeight - 1)
        val right = (fraction.right * originalWidth).roundToInt().coerceIn(left + 1, originalWidth)
        val bottom = (fraction.bottom * originalHeight).roundToInt().coerceIn(top + 1, originalHeight)
        val decoder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            BitmapRegionDecoder.newInstance(originalFile.absolutePath)
        } else {
            @Suppress("DEPRECATION")
            BitmapRegionDecoder.newInstance(originalFile.absolutePath, false)
        } ?: return null
        return try {
            decoder.decodeRegion(Rect(left, top, right, bottom), null)
        } finally {
            decoder.recycle()
        }
    }

    private fun decodeBounded(file: File): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        originalWidth = bounds.outWidth
        originalHeight = bounds.outHeight
        var sample = 1
        while (bounds.outWidth / sample > 2_048 || bounds.outHeight / sample > 2_048) sample *= 2
        return BitmapFactory.decodeFile(
            file.absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sample },
        )
    }

    private fun writeBoundedPng(bitmap: Bitmap, output: File): Boolean {
        var current = bitmap
        var ownsCurrent = false
        return try {
            repeat(12) {
                FileOutputStream(output, false).use { stream ->
                    if (!current.compress(Bitmap.CompressFormat.PNG, 100, stream)) return false
                }
                if (output.length() in 1..WorkspacePolicy.MAX_ATTACHMENT_BYTES) return true
                val next = CaptureImagePolicy.nextPngSize(current.width, current.height)
                if (next.width == current.width && next.height == current.height) return false
                val scaled = Bitmap.createScaledBitmap(current, next.width, next.height, true)
                if (ownsCurrent) current.recycle()
                current = scaled
                ownsCurrent = true
            }
            false
        } finally {
            if (ownsCurrent) current.recycle()
            if (output.length() !in 1..WorkspacePolicy.MAX_ATTACHMENT_BYTES) output.delete()
        }
    }

    private fun actionButton(label: String, color: Int, action: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        textSize = 13f
        setPadding(dp(12), 0, dp(12), 0)
        minHeight = 0
        minimumHeight = 0
        minWidth = 0
        minimumWidth = 0
        background = rounded(color, 12f)
        setOnClickListener { action() }
    }

    private fun rounded(color: Int, radiusDp: Float) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()
    private fun dp(value: Float): Int = (value * resources.displayMetrics.density).roundToInt()

    companion object {
        const val EXTRA_PATH = "crop_path"
        const val EXTRA_NAME = "crop_name"
        const val EXTRA_SOURCE = "crop_source"
        const val EXTRA_MODE = "crop_mode"
        const val MODE_READ = "read"
    }
}

@android.annotation.SuppressLint("ViewConstructor")
private class CropSelectionView(context: Context) : View(context) {
    private var bitmap: Bitmap? = null
    private val imageRect = RectF()
    private val selection = RectF()
    private var dragStartX = 0f
    private var dragStartY = 0f
    private val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val shadePaint = Paint().apply { color = 0x99000000.toInt() }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = dp(2f).toFloat()
    }

    fun setBitmap(value: Bitmap) {
        bitmap = value
        selection.setEmpty()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val source = bitmap ?: return
        val scale = min(width.toFloat() / source.width, height.toFloat() / source.height)
        val drawnWidth = source.width * scale
        val drawnHeight = source.height * scale
        imageRect.set(
            (width - drawnWidth) / 2f,
            (height - drawnHeight) / 2f,
            (width + drawnWidth) / 2f,
            (height + drawnHeight) / 2f,
        )
        if (selection.isEmpty) {
            val insetX = imageRect.width() * 0.08f
            val insetY = imageRect.height() * 0.08f
            selection.set(imageRect.left + insetX, imageRect.top + insetY, imageRect.right - insetX, imageRect.bottom - insetY)
        }
        canvas.drawColor(0xFF111017.toInt())
        canvas.drawBitmap(source, null, imageRect, imagePaint)
        canvas.save()
        canvas.clipOutRect(selection)
        canvas.drawRect(imageRect, shadePaint)
        canvas.restore()
        canvas.drawRect(selection, borderPaint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (bitmap == null || imageRect.isEmpty) return false
        val x = event.x.coerceIn(imageRect.left, imageRect.right)
        val y = event.y.coerceIn(imageRect.top, imageRect.bottom)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                dragStartX = x
                dragStartY = y
                selection.set(x, y, x, y)
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP -> {
                selection.set(min(dragStartX, x), min(dragStartY, y), max(dragStartX, x), max(dragStartY, y))
                invalidate()
                if (event.actionMasked == MotionEvent.ACTION_UP) {
                    parent?.requestDisallowInterceptTouchEvent(false)
                    performClick()
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> parent?.requestDisallowInterceptTouchEvent(false)
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean = super.performClick()

    /** 고른 부분을 이미지 대비 비율(0~1)로 돌려준다. 너무 작으면 null. */
    fun selectedFraction(): RectF? {
        if (bitmap == null) return null
        if (selection.width() < dp(24f) || selection.height() < dp(24f)) return null
        return RectF(
            ((selection.left - imageRect.left) / imageRect.width()).coerceIn(0f, 1f),
            ((selection.top - imageRect.top) / imageRect.height()).coerceIn(0f, 1f),
            ((selection.right - imageRect.left) / imageRect.width()).coerceIn(0f, 1f),
            ((selection.bottom - imageRect.top) / imageRect.height()).coerceIn(0f, 1f),
        )
    }

    fun selectedBitmap(): Bitmap? {
        val source = bitmap ?: return null
        if (selection.width() < dp(24f) || selection.height() < dp(24f)) return null
        val left = ((selection.left - imageRect.left) / imageRect.width() * source.width)
            .roundToInt().coerceIn(0, source.width - 1)
        val top = ((selection.top - imageRect.top) / imageRect.height() * source.height)
            .roundToInt().coerceIn(0, source.height - 1)
        val right = ((selection.right - imageRect.left) / imageRect.width() * source.width)
            .roundToInt().coerceIn(left + 1, source.width)
        val bottom = ((selection.bottom - imageRect.top) / imageRect.height() * source.height)
            .roundToInt().coerceIn(top + 1, source.height)
        return Bitmap.createBitmap(source, left, top, right - left, bottom - top)
    }

    private fun dp(value: Float): Int = (value * resources.displayMetrics.density).roundToInt()
}
