package com.example.writingenhancer.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.TextView

object Ui {
    const val ACCENT = 0xFF7962DB.toInt()
    const val ACCENT_TEXT = 0xFFC7BAFF.toInt()
    const val ACCENT_SURFACE = 0xFF302942.toInt()
    const val INK = 0xFF202027.toInt()
    const val MUTED = 0xFF6F6D78.toInt()
    // The overlay intentionally stays opaque enough that text from the app
    // underneath cannot visually collide with editable/result text.
    const val PANEL = 0xFF18191F.toInt()
    const val PANEL_FIELD = 0xFF24262F.toInt()
    const val PANEL_RAISED = 0xFF20222A.toInt()
    const val PANEL_STROKE = 0xFF383B47.toInt()
    const val PANEL_TEXT = 0xFFF1F0F7.toInt()
    const val PANEL_MUTED = 0xFFACADBE.toInt()
    const val LIGHT_SURFACE = 0xFFF5F4F8.toInt()

    fun Context.dp(value: Int): Int =
        (value * resources.displayMetrics.density + 0.5f).toInt()

    fun rounded(
        color: Int,
        radiusDp: Int,
        context: Context,
        strokeColor: Int? = null,
        strokeDp: Int = 1,
    ): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(color)
        cornerRadius = context.dp(radiusDp).toFloat()
        if (strokeColor != null) {
            setStroke(context.dp(strokeDp), strokeColor)
        }
    }

    fun interactive(context: Context, color: Int, radiusDp: Int = 12): Drawable =
        RippleDrawable(
            ColorStateList.valueOf(0x28FFFFFF),
            StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_focused), rounded(color, radiusDp, context, ACCENT_TEXT))
                addState(intArrayOf(), rounded(color, radiusDp, context))
            },
            rounded(Color.WHITE, radiusDp, context),
        )

    fun inputBackground(context: Context, dark: Boolean = true): Drawable =
        StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), rounded(
                if (dark) PANEL_FIELD else Color.WHITE, 16, context, ACCENT,
            ))
            addState(intArrayOf(), rounded(
                if (dark) PANEL_FIELD else Color.WHITE, 16, context,
                if (dark) PANEL_STROKE else 0xFFE0DDE8.toInt(),
            ))
        }

    // Transparency belongs to the window surface; glyphs and editing surfaces stay legible.
    fun applySurfaceOpacity(view: View, opacity: Float, dark: Boolean = true) {
        view.alpha = 1f
        val base = if (dark) PANEL else LIGHT_SURFACE
        val color = (base and 0x00FFFFFF) or ((opacity.coerceIn(0.55f, 1f) * 255).toInt() shl 24)
        view.background = rounded(color, 24, view.context,
            if (dark) PANEL_STROKE else 0xFFE0DDE8.toInt())
    }

    fun iconButton(context: Context, icon: UiIcon, description: String,
        onClick: ((View) -> Unit)? = null): Button = quietButton(context, "", onClick).apply {
        contentDescription = description
        tooltipText = description
        setPadding(context.dp(12), context.dp(12), context.dp(12), context.dp(12))
        minHeight = context.dp(44)
        minWidth = context.dp(44)
        setCompoundDrawables(UiIconDrawable(icon, PANEL_MUTED).apply {
            setBounds(0, 0, context.dp(20), context.dp(20))
        }, null, null, null)
        background = interactive(context, Color.TRANSPARENT)
    }

    fun styleSeekBar(seek: android.widget.SeekBar) {
        seek.minimumHeight = seek.context.dp(44)
        seek.progressTintList = ColorStateList.valueOf(ACCENT)
        seek.thumbTintList = ColorStateList.valueOf(ACCENT_TEXT)
        seek.progressBackgroundTintList = ColorStateList.valueOf(PANEL_STROKE)
        seek.splitTrack = false
    }

    fun label(
        context: Context,
        text: String,
        sizeSp: Float = 15f,
        color: Int = INK,
        bold: Boolean = false,
    ) = TextView(context).apply {
        this.text = text
        textSize = sizeSp
        setTextColor(color)
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        includeFontPadding = false
    }

    fun primaryButton(context: Context, text: String) = Button(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 16f
        setTextColor(Color.WHITE)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
        background = interactive(context, ACCENT, 16)
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
            intArrayOf(0xFFCBC3EA.toInt(), Color.WHITE)))
        minWidth = 0
        minimumWidth = 0
        setPadding(context.dp(16), context.dp(10), context.dp(16), context.dp(10))
        minHeight = context.dp(52)
        stateListAnimator = null
    }

    fun quietButton(
        context: Context,
        text: String,
        onClick: ((View) -> Unit)? = null,
    ) = Button(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        minWidth = 0
        minimumWidth = 0
        minHeight = 0
        minimumHeight = 0
        setPadding(context.dp(10), context.dp(7), context.dp(10), context.dp(7))
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        background = interactive(context, PANEL_FIELD, 12)
        setTextColor(PANEL_TEXT)
        stateListAnimator = null
        if (onClick != null) setOnClickListener(onClick)
    }
}
