package com.stockwatch.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Telefon tarafı: saatte bir Worker'a "bekleyen bildirim var mı?" diye sorar.
 * Firebase YOK. Saatlik HTTPS isteği = ihmal edilebilir pil tüketimi.
 * Asıl ağır tarama işini Cloudflare Worker cron ile yapar.
 */
class PollWorker(
    private val ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val pending = Repository.fetchPending()
        pending.forEach { showNotification(ctx, it) }
        return Result.success()
    }

    companion object {
        private const val CHANNEL_CRITICAL = "critical"
        private const val CHANNEL_NORMAL = "normal"
        private const val WORK_NAME = "stockwatch_poll"

        fun schedule(ctx: Context, intervalHours: Long = 1) {
            createChannels(ctx)
            // Minimum periyot 15 dk; varsayılan saatlik.
            val req = PeriodicWorkRequestBuilder<PollWorker>(
                intervalHours.coerceAtLeast(1), TimeUnit.HOURS
            ).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                req
            )
        }

        private fun createChannels(ctx: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val mgr = ctx.getSystemService(NotificationManager::class.java)
                mgr.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_CRITICAL, "Kritik Uyarılar",
                        NotificationManager.IMPORTANCE_HIGH
                    )
                )
                mgr.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_NORMAL, "Genel Bildirimler",
                        NotificationManager.IMPORTANCE_DEFAULT
                    )
                )
            }
        }

        fun showNotification(ctx: Context, n: RemoteNotification) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ContextCompat.checkSelfPermission(
                        ctx, Manifest.permission.POST_NOTIFICATIONS
                    ) != PackageManager.PERMISSION_GRANTED
                ) return
            }
            val channel =
                if (n.type == "criticalNews" || n.type == "rating" || n.type == "priceAlert")
                    CHANNEL_CRITICAL else CHANNEL_NORMAL

            val builder = NotificationCompat.Builder(ctx, channel)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(n.title)
                .setContentText(n.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(n.body))
                .setAutoCancel(true)

            NotificationManagerCompat.from(ctx)
                .notify(n.id.hashCode(), builder.build())
        }
    }
}
