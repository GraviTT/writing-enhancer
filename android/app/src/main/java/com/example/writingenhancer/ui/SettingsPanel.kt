package com.example.writingenhancer.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Space
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.example.writingenhancer.memory.MemoryItem
import com.example.writingenhancer.memory.MemoryStore
import com.example.writingenhancer.preferences.AppPreferences
import com.example.writingenhancer.security.SecureStore
import com.example.writingenhancer.ui.Ui.dp

@Suppress("DEPRECATION")
object SettingsPanel {

    fun showDialog(
        activity: Activity,
        secureStore: SecureStore,
        memoryStore: MemoryStore,
        onStopBubble: () -> Unit,
        onChanged: () -> Unit = {},
        onBubbleSizeChanged: (() -> Unit)? = null,
    ) {
        lateinit var dialog: AlertDialog
        var moveBy: (Int, Int) -> Unit = { _, _ -> }
        var resizeBy: (Int, Int) -> Unit = { _, _ -> }
        var applyOpacity: (Float) -> Unit = {}
        lateinit var content: View
        content = buildContent(
            context = activity,
            dark = true,
            secureStore = secureStore,
            memoryStore = memoryStore,
            onClose = { dialog.dismiss() },
            onStopBubble = onStopBubble,
            onChanged = onChanged,
            onBubbleSizeChanged = onBubbleSizeChanged,
            onMoveBy = { x, y -> moveBy(x, y) },
            onResizeBy = { width, height -> resizeBy(width, height) },
            onPopupOpacityChanged = { opacity -> applyOpacity(opacity) },
        )
        dialog = AlertDialog.Builder(activity)
            .setView(content)
            .create()
        dialog.setOnShowListener {
            val window = dialog.window ?: return@setOnShowListener
            val metrics = activity.resources.displayMetrics
            val minWidth = activity.dp(280)
            val minHeight = activity.dp(360)
            val recoverable = activity.dp(72)
            window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            window.setDimAmount(0.16f)
            window.setGravity(Gravity.TOP or Gravity.START)
            window.setSoftInputMode(
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                    WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN,
            )
            val attributes = window.attributes
            attributes.width = (metrics.widthPixels * 0.9f).toInt()
            attributes.height = (metrics.heightPixels * 0.8f).toInt()
            attributes.x = (metrics.widthPixels - attributes.width) / 2
            attributes.y = activity.dp(42)
            window.attributes = attributes
            Ui.applySurfaceOpacity(content, AppPreferences(activity).popupOpacityPercent / 100f)
            moveBy = { deltaX, deltaY ->
                val current = window.attributes
                current.x = (current.x + deltaX).coerceIn(
                    MobileUiPolicy.popupPositionRange(
                        current.width,
                        metrics.widthPixels,
                        recoverable,
                    ),
                )
                current.y = (current.y + deltaY).coerceIn(
                    MobileUiPolicy.popupPositionRange(
                        current.height,
                        metrics.heightPixels,
                        recoverable,
                    ),
                )
                window.attributes = current
            }
            resizeBy = { deltaWidth, deltaHeight ->
                val current = window.attributes
                current.width = (current.width + deltaWidth)
                    .coerceIn(minWidth, metrics.widthPixels)
                current.height = (current.height + deltaHeight)
                    .coerceIn(minHeight, metrics.heightPixels)
                window.attributes = current
            }
            applyOpacity = { opacity -> Ui.applySurfaceOpacity(content, opacity) }
            content.requestFocus()
        }
        dialog.show()
    }

    fun showPopup(
        context: Context,
        anchor: View,
        secureStore: SecureStore,
        memoryStore: MemoryStore,
        onStopBubble: () -> Unit,
        onChanged: () -> Unit = {},
        onBubbleSizeChanged: (() -> Unit)? = null,
        onPopupOpacityChanged: ((Float) -> Unit)? = null,
    ): PopupWindow {
        lateinit var popup: PopupWindow
        val metrics = context.resources.displayMetrics
        val geometry = context.getSharedPreferences(POPUP_GEOMETRY_PREFS, Context.MODE_PRIVATE)
        val recoverable = context.dp(72)
        val minWidth = context.dp(280)
        val minHeight = context.dp(360)
        var popupWidth = geometry.getInt(
            KEY_POPUP_WIDTH,
            minOf(context.dp(360), (metrics.widthPixels * 0.9f).toInt()),
        ).coerceIn(minWidth, metrics.widthPixels)
        var popupHeight = geometry.getInt(
            KEY_POPUP_HEIGHT,
            minOf(context.dp(680), (metrics.heightPixels * 0.82f).toInt()),
        ).coerceIn(minHeight, metrics.heightPixels)
        var popupX = geometry.getInt(
            KEY_POPUP_X,
            (metrics.widthPixels - popupWidth) / 2,
        )
        var popupY = geometry.getInt(KEY_POPUP_Y, context.dp(52))
        fun persistGeometry() {
            geometry.edit()
                .putInt(KEY_POPUP_X, popupX)
                .putInt(KEY_POPUP_Y, popupY)
                .putInt(KEY_POPUP_WIDTH, popupWidth)
                .putInt(KEY_POPUP_HEIGHT, popupHeight)
                .apply()
        }
        lateinit var content: View
        content = buildContent(
            context = context,
            dark = true,
            secureStore = secureStore,
            memoryStore = memoryStore,
            onClose = { popup.dismiss() },
            onStopBubble = onStopBubble,
            onChanged = onChanged,
            onBubbleSizeChanged = onBubbleSizeChanged,
            onMoveBy = { deltaX, deltaY ->
                popupX = (popupX + deltaX).coerceIn(
                    MobileUiPolicy.popupPositionRange(
                        popupWidth,
                        metrics.widthPixels,
                        recoverable,
                    ),
                )
                popupY = (popupY + deltaY).coerceIn(
                    MobileUiPolicy.popupPositionRange(
                        popupHeight,
                        metrics.heightPixels,
                        recoverable,
                    ),
                )
                popup.update(popupX, popupY, popupWidth, popupHeight)
                persistGeometry()
            },
            onResizeBy = { deltaWidth, deltaHeight ->
                popupWidth = (popupWidth + deltaWidth).coerceIn(minWidth, metrics.widthPixels)
                popupHeight = (popupHeight + deltaHeight).coerceIn(minHeight, metrics.heightPixels)
                popup.update(popupX, popupY, popupWidth, popupHeight)
                persistGeometry()
            },
            onPopupOpacityChanged = { opacity ->
                Ui.applySurfaceOpacity(content, opacity)
                onPopupOpacityChanged?.invoke(opacity)
            },
        )
        popup = PopupWindow(
            content,
            popupWidth,
            popupHeight,
            true,
        ).apply {
            isOutsideTouchable = true
            isClippingEnabled = false
            elevation = context.dp(18).toFloat()
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            inputMethodMode = PopupWindow.INPUT_METHOD_NEEDED
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
        }
        Ui.applySurfaceOpacity(content, AppPreferences(context).popupOpacityPercent / 100f)
        content.requestFocus()
        popup.showAtLocation(anchor.rootView, Gravity.TOP or Gravity.START, popupX, popupY)
        content.post { content.requestFocus() }
        return popup
    }

    @android.annotation.SuppressLint(
        "ClickableViewAccessibility",
        "SetTextI18n",
    )
    private fun buildContent(
        context: Context,
        dark: Boolean,
        secureStore: SecureStore,
        memoryStore: MemoryStore,
        onClose: () -> Unit,
        onStopBubble: () -> Unit,
        onChanged: () -> Unit,
        onBubbleSizeChanged: (() -> Unit)?,
        onMoveBy: (Int, Int) -> Unit,
        onResizeBy: (Int, Int) -> Unit,
        onPopupOpacityChanged: (Float) -> Unit,
    ): View {
        val foreground = if (dark) Color.WHITE else Ui.INK
        val muted = if (dark) Ui.PANEL_MUTED else Ui.MUTED
        val fieldColor = if (dark) Ui.PANEL_FIELD else 0xFFF1EFF5.toInt()
        val preferences = AppPreferences(context)
        val editMenuController = InlineEditMenuController(context, dark)
        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(context.dp(18), context.dp(6), context.dp(18), context.dp(32))
        }

        val header = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            contentDescription = "설정 창 이동"
            setPadding(context.dp(18), context.dp(10), context.dp(8), context.dp(6))
        }
        header.addView(
            Ui.label(context, "설정", 18f, foreground, true),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        header.addView(Ui.iconButton(context, UiIcon.CLOSE, "설정 닫기") { onClose() },
            LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
        header.setOnTouchListener(
            WindowDragTouchListener(
                view = header,
                onDelta = { deltaX, deltaY -> onMoveBy(deltaX, deltaY) },
            ),
        )
        val connectionReady = secureStore.contains(SecureStore.OPENAI_KEY) || secureStore.contains(SecureStore.GEMINI_KEY)
        val connectionToggle = textAction(context,
            if (connectionReady) "AI 연결 · 설정 보기  ▾" else "AI 연결 · 키 등록  ▴",
            foreground, fieldColor)
        container.addView(connectionToggle, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, context.dp(48)))
        val connectionFields = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, context.dp(14), 0, context.dp(12))
            visibility = if (connectionReady) View.GONE else View.VISIBLE
        }
        container.addView(connectionFields)
        connectionToggle.setOnClickListener {
            val opening = connectionFields.visibility != View.VISIBLE
            connectionFields.visibility = if (opening) View.VISIBLE else View.GONE
            connectionToggle.text = if (opening) "AI 연결 · 접기  ▴" else "AI 연결 · 설정 보기  ▾"
        }

        val openAiInput = keyInput(
            context,
            "OpenAI API 키",
            secureStore.contains(SecureStore.OPENAI_KEY),
            dark,
            foreground,
            muted,
            fieldColor,
            editMenuController,
        )
        val geminiInput = keyInput(
            context,
            "Gemini API 키 · 선택",
            secureStore.contains(SecureStore.GEMINI_KEY),
            dark,
            foreground,
            muted,
            fieldColor,
            editMenuController,
        )
        connectionFields.addView(openAiInput.first)
        connectionFields.addView(geminiInput.first)
        val saveKeys = Ui.primaryButton(context, "키 안전하게 저장")
        connectionFields.addView(
            saveKeys,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(50)),
        )

        container.addView(Ui.label(context, "화면", 13f, muted, true).apply {
            setPadding(0, context.dp(24), 0, context.dp(2))
        })
        val sizeLabel = Ui.label(
            context,
            context.getString(
                com.example.writingenhancer.R.string.bubble_size_format,
                preferences.bubbleSizeDp,
            ),
            12f,
            foreground,
            true,
        ).apply { setPadding(0, context.dp(18), 0, context.dp(3)) }
        container.addView(sizeLabel)
        container.addView(
            Ui.label(context, "원하는 크기로 옮겨도 화면 가장자리에 붙지 않아요.", 11f, muted),
        )
        val sizeSeek = SeekBar(context).apply {
            Ui.styleSeekBar(this)
            max = AppPreferences.MAX_BUBBLE_SIZE - AppPreferences.MIN_BUBBLE_SIZE
            progress = preferences.bubbleSizeDp - AppPreferences.MIN_BUBBLE_SIZE
            setOnSeekBarChangeListener(
                object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(
                        seekBar: SeekBar?,
                        progress: Int,
                        fromUser: Boolean,
                    ) {
                        if (!fromUser) return
                        val size = AppPreferences.MIN_BUBBLE_SIZE + progress
                        preferences.bubbleSizeDp = size
                        sizeLabel.text = context.getString(
                            com.example.writingenhancer.R.string.bubble_size_format,
                            size,
                        )
                        onBubbleSizeChanged?.invoke()
                    }

                    override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                    override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
                },
            )
        }
        container.addView(sizeSeek)

        val opacityLabel = Ui.label(
            context,
            "배경 불투명도 · ${preferences.popupOpacityPercent}%",
            12f,
            foreground,
            true,
        ).apply { setPadding(0, context.dp(12), 0, context.dp(3)) }
        container.addView(opacityLabel)
        container.addView(
            SeekBar(context).apply {
                Ui.styleSeekBar(this)
                max = AppPreferences.MAX_POPUP_OPACITY - AppPreferences.MIN_POPUP_OPACITY
                progress =
                    preferences.popupOpacityPercent - AppPreferences.MIN_POPUP_OPACITY
                setOnSeekBarChangeListener(
                    object : SeekBar.OnSeekBarChangeListener {
                        override fun onProgressChanged(
                            seekBar: SeekBar?,
                            progress: Int,
                            fromUser: Boolean,
                        ) {
                            if (!fromUser) return
                            val percent = AppPreferences.MIN_POPUP_OPACITY + progress
                            preferences.popupOpacityPercent = percent
                            opacityLabel.text = "배경 불투명도 · $percent%"
                            onPopupOpacityChanged(percent / 100f)
                        }

                        override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                        override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
                    },
                )
            },
        )

        container.addView(Ui.label(context, "글자와 입력 영역은 선명하게 유지해요.", 12f, muted))
        container.addView(Ui.label(context, "기억", 13f, muted, true).apply {
            setPadding(0, context.dp(24), 0, context.dp(8))
        })
        val disableMemory = Switch(context).apply {
            text = "기억 추가 비활성화"
            textSize = 14f
            minHeight = context.dp(48)
            trackTintList = android.content.res.ColorStateList(
                arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
                intArrayOf(Ui.ACCENT, if (dark) 0xFF737789.toInt() else Ui.MUTED),
            )
            thumbTintList = android.content.res.ColorStateList.valueOf(if (dark) Ui.PANEL_TEXT else Ui.INK)
            setTextColor(foreground)
            isChecked = !preferences.memoryAdditionsEnabled
            setPadding(0, context.dp(8), 0, context.dp(4))
            setOnCheckedChangeListener { _, disabled ->
                preferences.memoryAdditionsEnabled = !disabled
                Toast.makeText(
                    context,
                    if (disabled) {
                        "새 기억을 추가하지 않아요."
                    } else {
                        "승인한 기억만 추가해요."
                    },
                    Toast.LENGTH_SHORT,
                ).show()
                onChanged()
            }
        }
        container.addView(disableMemory)

        val memoryHeader = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, context.dp(12), 0, context.dp(7))
        }
        val memoryStatus = Ui.label(
            context,
            context.getString(
                com.example.writingenhancer.R.string.memory_count_format,
                memoryStore.count(),
            ),
            13f,
            foreground,
            true,
        )
        memoryHeader.addView(
            memoryStatus,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        val toggleMemory = textAction(context, "보기·수정", foreground, fieldColor)
        memoryHeader.addView(toggleMemory, LinearLayout.LayoutParams(context.dp(88), context.dp(38)))
        container.addView(memoryHeader)

        val memoryList = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        container.addView(memoryList)

        fun renderMemories() {
            editMenuController.hide()
            memoryList.removeAllViews()
            val memories = memoryStore.all()
            memoryStatus.text = context.getString(
                com.example.writingenhancer.R.string.memory_count_format,
                memories.size,
            )
            if (memories.isEmpty()) {
                memoryList.addView(
                    Ui.label(context, "아직 저장된 기억이 없어요.", 12f, muted).apply {
                        setPadding(0, context.dp(5), 0, context.dp(10))
                    },
                )
            } else {
                memories.forEach { memory ->
                    memoryList.addView(
                        memoryEditor(
                            context,
                            memory,
                            foreground,
                            muted,
                            fieldColor,
                            editMenuController,
                            onSave = { value, scope ->
                                if (memoryStore.update(memory.id, value, scope)) {
                                    Toast.makeText(context, "기억을 수정했어요.", Toast.LENGTH_SHORT)
                                        .show()
                                    renderMemories()
                                    onChanged()
                                } else {
                                    Toast.makeText(
                                        context,
                                        "민감정보 없이 3자 이상으로 적어 주세요.",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            },
                            onDelete = {
                                memoryStore.delete(memory.id)
                                renderMemories()
                                onChanged()
                            },
                        ),
                    )
                }
            }
        }
        toggleMemory.setOnClickListener {
            memoryList.visibility = if (memoryList.visibility == View.VISIBLE) {
                View.GONE
            } else {
                renderMemories()
                View.VISIBLE
            }
            toggleMemory.text = if (memoryList.visibility == View.VISIBLE) "접기" else "보기·수정"
        }

        val actions = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, context.dp(10), 0, 0)
        }
        val clearMemory = textAction(context, "기억 전체 삭제", foreground, fieldColor)
        val clearKeys = textAction(context, "키 지우기", foreground, fieldColor)
        val stop = textAction(context, "버블 끄기", 0xFFFF8B8B.toInt(), fieldColor)
        actions.addView(clearMemory, LinearLayout.LayoutParams(0, context.dp(42), 1f))
        actions.addView(
            clearKeys,
            LinearLayout.LayoutParams(0, context.dp(42), 1f).apply {
                marginStart = context.dp(6)
            },
        )
        actions.addView(
            stop,
            LinearLayout.LayoutParams(0, context.dp(42), 1f).apply {
                marginStart = context.dp(6)
            },
        )
        container.addView(actions)
        container.addView(
            Ui.label(
                context,
                "키와 작성 내용은 이 기기에 안전하게 보관돼요.",
                11f,
                muted,
            ).apply {
                setPadding(0, context.dp(12), 0, 0)
                setLineSpacing(0f, 1.15f)
            },
        )

        saveKeys.setOnClickListener {
            val openAi = openAiInput.second.text.toString().trim()
            val gemini = geminiInput.second.text.toString().trim()
            if (openAi.isNotEmpty()) secureStore.putString(SecureStore.OPENAI_KEY, openAi)
            if (gemini.isNotEmpty()) secureStore.putString(SecureStore.GEMINI_KEY, gemini)
            openAiInput.second.text?.clear()
            geminiInput.second.text?.clear()
            openAiInput.second.hint = "저장됨 · 바꾸려면 새 키 입력"
            geminiInput.second.hint = if (secureStore.contains(SecureStore.GEMINI_KEY)) {
                "저장됨 · 바꾸려면 새 키 입력"
            } else {
                "선택 사항"
            }
            Toast.makeText(context, "기기에 안전하게 저장했어요.", Toast.LENGTH_SHORT).show()
            onChanged()
        }
        clearMemory.setOnClickListener {
            memoryStore.clear()
            renderMemories()
            Toast.makeText(context, "저장된 기억을 모두 지웠어요.", Toast.LENGTH_SHORT).show()
            onChanged()
        }
        clearKeys.setOnClickListener {
            secureStore.remove(SecureStore.OPENAI_KEY)
            secureStore.remove(SecureStore.GEMINI_KEY)
            openAiInput.second.hint = "필수 또는 Gemini만 입력"
            geminiInput.second.hint = "선택 사항"
            Toast.makeText(context, "저장된 API 키를 지웠어요.", Toast.LENGTH_SHORT).show()
            onChanged()
        }
        stop.setOnClickListener {
            onClose()
            onStopBubble()
        }

        val scroll = ScrollView(context).apply {
            isFillViewport = true
            isFocusableInTouchMode = true
            descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
            addView(container)
            requestFocus()
        }
        val resizeHandle = TextView(context).apply {
            text = ""
            textSize = 18f
            gravity = Gravity.CENTER
            setTextColor(muted)
            contentDescription = "설정 창 크기 조절"
            background = android.graphics.drawable.InsetDrawable(
                UiIconDrawable(UiIcon.RESIZE, muted), context.dp(10),
            )
        }
        resizeHandle.setOnTouchListener(
            WindowDragTouchListener(
                view = resizeHandle,
                onDelta = { deltaX, deltaY -> onResizeBy(deltaX, deltaY) },
            ),
        )
        return FrameLayout(context).apply {
            clipToOutline = true
            addView(
                LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(header)
                    addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
                },
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ).apply { bottomMargin = context.dp(18) },
            )
            addView(
                resizeHandle,
                FrameLayout.LayoutParams(
                    context.dp(44),
                    context.dp(44),
                    Gravity.END or Gravity.BOTTOM,
                ).apply {
                    rightMargin = 0
                    bottomMargin = 0
                },
            )
        }
    }

    private fun memoryEditor(
        context: Context,
        memory: MemoryItem,
        foreground: Int,
        muted: Int,
        fieldColor: Int,
        editMenuController: InlineEditMenuController,
        onSave: (String, String) -> Unit,
        onDelete: () -> Unit,
    ): View {
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(context.dp(10), context.dp(10), context.dp(10), context.dp(10))
            background = Ui.rounded(fieldColor, 13, context)
        }
        block.addView(Ui.label(context, memory.type, 10f, muted, true))
        val value = PasteFriendlyEditText(
            context = context,
            minRows = 2,
            maxRows = 4,
            onBack = null,
            onEditMenuRequested = { editMenuController.show(it) },
        ).apply {
            setInitialText(memory.value)
            setTextColor(foreground)
            textSize = 12f
            background = null
            setPadding(0, context.dp(4), 0, context.dp(4))
            setOnFocusChangeListener { _, hasFocus ->
                if (!hasFocus && editMenuController.editor === this) {
                    editMenuController.hide()
                }
            }
        }
        val scope = PasteFriendlyEditText(
            context = context,
            minRows = 1,
            maxRows = 1,
            onBack = null,
            onEditMenuRequested = { editMenuController.show(it) },
        ).apply {
            setInitialText(memory.scope)
            hint = "적용 상황"
            setHintTextColor(muted)
            setTextColor(foreground)
            textSize = 11f
            setSingleLine(true)
            background = null
            setPadding(0, context.dp(3), 0, context.dp(4))
            setOnFocusChangeListener { _, hasFocus ->
                if (!hasFocus && editMenuController.editor === this) {
                    editMenuController.hide()
                }
            }
        }
        block.addView(value)
        block.addView(
            editMenuController.menuButton(value),
            LinearLayout.LayoutParams(context.dp(38), context.dp(30)).apply {
                gravity = Gravity.END
            },
        )
        block.addView(scope)
        block.addView(
            editMenuController.menuButton(scope),
            LinearLayout.LayoutParams(context.dp(38), context.dp(30)).apply {
                gravity = Gravity.END
            },
        )
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        val save = textAction(context, "저장", foreground, 0x226E56CF)
        val delete = textAction(context, "삭제", 0xFFFF8B8B.toInt(), 0x18FFFFFF)
        row.addView(save, LinearLayout.LayoutParams(context.dp(72), context.dp(36)))
        row.addView(Space(context), LinearLayout.LayoutParams(context.dp(6), 1))
        row.addView(delete, LinearLayout.LayoutParams(context.dp(72), context.dp(36)))
        block.addView(row)
        save.setOnClickListener { onSave(value.text.toString(), scope.text.toString()) }
        delete.setOnClickListener { onDelete() }
        return block.apply {
            (layoutParams as? LinearLayout.LayoutParams)?.bottomMargin = context.dp(8)
            setTag(memory.id)
        }
    }

    private fun keyInput(
        context: Context,
        label: String,
        saved: Boolean,
        dark: Boolean,
        foreground: Int,
        muted: Int,
        fieldColor: Int,
        editMenuController: InlineEditMenuController,
    ): Pair<View, PasteFriendlyEditText> {
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, context.dp(10))
        }
        block.addView(
            Ui.label(context, label, 12f, muted, true).apply {
                setPadding(context.dp(2), 0, 0, context.dp(5))
            },
        )
        val input = PasteFriendlyEditText(
            context = context,
            minRows = 1,
            maxRows = 1,
            onBack = null,
            onEditMenuRequested = { editMenuController.show(it) },
        ).apply {
            hint = if (saved) "저장됨 · 바꾸려면 새 키 입력" else "키 붙여넣기"
            setHintTextColor(if (dark) 0xFF817E8A.toInt() else 0xFF96929E.toInt())
            setTextColor(foreground)
            textSize = 13f
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setPadding(context.dp(13), context.dp(11), context.dp(13), context.dp(11))
            background = Ui.inputBackground(context, dark)
            setOnFocusChangeListener { _, hasFocus ->
                if (!hasFocus && editMenuController.editor === this) {
                    editMenuController.hide()
                }
            }
        }
        block.addView(
            input,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(46)),
        )
        block.addView(
            editMenuController.menuButton(input),
            LinearLayout.LayoutParams(context.dp(38), context.dp(30)).apply {
                gravity = Gravity.END
                topMargin = context.dp(4)
            },
        )
        return block to input
    }

    private fun textAction(
        context: Context,
        text: String,
        color: Int,
        backgroundColor: Int,
    ) = Button(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 12f
        typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
        setTextColor(color)
        minWidth = 0
        minimumWidth = 0
        minHeight = 0
        minimumHeight = 0
        setPadding(context.dp(4), 0, context.dp(4), 0)
        background = Ui.interactive(context, backgroundColor, 12)
        stateListAnimator = null
    }

    private const val POPUP_GEOMETRY_PREFS = "settings_popup_geometry"
    private const val KEY_POPUP_X = "x"
    private const val KEY_POPUP_Y = "y"
    private const val KEY_POPUP_WIDTH = "width"
    private const val KEY_POPUP_HEIGHT = "height"
}
