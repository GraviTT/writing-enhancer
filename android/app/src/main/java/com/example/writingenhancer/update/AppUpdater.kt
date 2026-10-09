package com.example.writingenhancer.update

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/** GitHub 릴리스에서 새 버전을 확인해 알림을 띄우고, 누르면 받아서 설치 화면을 연다. */
object AppUpdater {
    private const val CHANNEL_ID = "writing_enhancer_updates"
    private const val NOTIFICATION_ID = 7402
    private const val PREFS = "app_update"
    private const val KEY_LAST_CHECK = "last_check"
    private const val KEY_NOTIFIED = "notified"
    private const val CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L
    private const val RENOTIFY_MS = 24L * 60L * 60L * 1000L
    private const val TIMEOUT_MS = 20_000

    const val EXTRA_VERSION = "update_version"
    const val EXTRA_APK_URL = "update_apk_url"
    const val EXTRA_APK_SIZE = "update_apk_size"
    const val EXTRA_SUMS_URL = "update_sums_url"
    const val EXTRA_PAGE_URL = "update_page_url"

    fun currentVersion(context: Context): String =
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull().orEmpty()

    /** 6시간에 한 번만 확인한다. 새 버전이면 하루에 한 번까지 알림을 띄운다. */
    fun checkInBackground(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong(KEY_LAST_CHECK, 0L) < CHECK_INTERVAL_MS) return
        prefs.edit().putLong(KEY_LAST_CHECK, now).apply()
        thread(name = "writing-enhancer-update-check", isDaemon = true) {
            val update = runCatching { fetchLatest(app) }.getOrNull() ?: return@thread
            val notified = prefs.getString(KEY_NOTIFIED, "").orEmpty().split("@")
            val sameVersion = notified.firstOrNull() == update.version
            val lastNotified = notified.getOrNull(1)?.toLongOrNull() ?: 0L
            if (sameVersion && now - lastNotified < RENOTIFY_MS) return@thread
            if (notify(app, update)) {
                prefs.edit().putString(KEY_NOTIFIED, "${update.version}@$now").apply()
            }
        }
    }

    fun fetchLatest(context: Context): AvailableUpdate? {
        val connection = open(AppUpdatePolicy.LATEST_RELEASE_URL, context).apply {
            setRequestProperty("Accept", "application/vnd.github+json")
        }
        return try {
            when (connection.responseCode) {
                HttpURLConnection.HTTP_OK -> AppUpdatePolicy.parseRelease(
                    connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() },
                    currentVersion(context),
                )
                else -> null
            }
        } finally {
            connection.disconnect()
        }
    }

    fun intentFor(context: Context, update: AvailableUpdate): Intent =
        Intent(context, UpdateActivity::class.java)
            .putExtra(EXTRA_VERSION, update.version)
            .putExtra(EXTRA_APK_URL, update.apk.url)
            .putExtra(EXTRA_APK_SIZE, update.apk.size)
            .putExtra(EXTRA_SUMS_URL, update.checksums.url)
            .putExtra(EXTRA_PAGE_URL, update.pageUrl)

    fun fromIntent(intent: Intent): AvailableUpdate? {
        val version = intent.getStringExtra(EXTRA_VERSION) ?: return null
        val apkUrl = intent.getStringExtra(EXTRA_APK_URL) ?: return null
        val sumsUrl = intent.getStringExtra(EXTRA_SUMS_URL) ?: return null
        if (!AppUpdatePolicy.isTrustedDownload(apkUrl) || !AppUpdatePolicy.isTrustedDownload(sumsUrl)) {
            return null
        }
        return AvailableUpdate(
            version = version,
            apk = ReleaseAsset(
                AppUpdatePolicy.apkAssetName(version),
                apkUrl,
                intent.getLongExtra(EXTRA_APK_SIZE, -1L),
            ),
            checksums = ReleaseAsset(AppUpdatePolicy.CHECKSUM_ASSET, sumsUrl, -1L),
            pageUrl = intent.getStringExtra(EXTRA_PAGE_URL).orEmpty(),
        )
    }

    private fun notify(context: Context, update: AvailableUpdate): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        if (!manager.areNotificationsEnabled()) return false
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "앱 업데이트", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "새 버전이 나오면 알려 드려요."
            },
        )
        val open = PendingIntent.getActivity(
            context,
            3,
            intentFor(context, update).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(com.example.writingenhancer.R.drawable.ic_launcher)
            .setContentTitle("글 강화기 ${update.version} 업데이트가 있어요")
            .setContentText("눌러서 바로 업데이트하세요.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
        return true
    }

    fun cancelNotification(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    private fun open(url: String, context: Context): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            instanceFollowRedirects = true
            useCaches = false
            setRequestProperty("User-Agent", "WritingEnhancer-Android/${currentVersion(context)}")
        }

    private fun readText(url: String, context: Context): String {
        val connection = open(url, context)
        return try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("업데이트 정보를 받지 못했어요 (${connection.responseCode}).")
            }
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /** 설치 파일을 받고 SHA-256을 릴리스의 SHA256SUMS.txt와 맞춰 본다. */
    fun download(
        context: Context,
        update: AvailableUpdate,
        isCancelled: () -> Boolean,
        onProgress: (Long, Long) -> Unit,
    ): File {
        val expected = AppUpdatePolicy.parseChecksums(readText(update.checksums.url, context))[update.apk.name]
            ?: throw IOException("업데이트 파일의 검사 값을 찾지 못했어요.")
        val directory = File(context.cacheDir, "updates").apply {
            deleteRecursively()
            mkdirs()
        }
        val target = File(directory, update.apk.name)
        val connection = open(update.apk.url, context)
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("업데이트 파일을 받지 못했어요 (${connection.responseCode}).")
            }
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: update.apk.size
            if (total > AppUpdatePolicy.MAX_APK_BYTES) throw IOException("업데이트 파일이 너무 커요.")
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (isCancelled()) throw IOException("업데이트를 취소했어요.")
                        val count = input.read(buffer)
                        if (count < 0) break
                        received += count
                        if (received > AppUpdatePolicy.MAX_APK_BYTES) throw IOException("업데이트 파일이 너무 커요.")
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                        onProgress(received, total)
                    }
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) {
                target.delete()
                throw IOException("받은 파일이 손상됐어요. 다시 시도해 주세요.")
            }
            return target
        } catch (failure: Throwable) {
            target.delete()
            throw failure
        } finally {
            connection.disconnect()
        }
    }

    /** 시스템 설치 확인 화면으로 넘긴다. 결과는 [statusIntent]로 돌아온다. */
    fun install(context: Context, apk: File, statusIntent: PendingIntent) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            session.commit(statusIntent.intentSender)
        }
    }
}
