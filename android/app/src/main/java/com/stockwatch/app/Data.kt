package com.stockwatch.app

import kotlinx.serialization.Serializable

// ---- Worker'a bağlanma ayarları ----
object Backend {
    // Kendi Worker adresin (wrangler deploy sonrası çıkar)
    const val BASE_URL = "https://stockwatch.veyseltosun-vt.workers.dev"
    // wrangler secret put DEVICE_TOKEN ile koyduğun değerin AYNISI
    const val DEVICE_TOKEN = "vt-mrvl-9f3kQ7xP2z"
}

// ---- Bildirim modeli (Worker /pending döndürür) ----
@Serializable
data class RemoteNotification(
    val id: String,
    val symbol: String,
    val type: String,       // rating | fairValue | criticalNews | news
    val title: String,
    val body: String,
    val url: String? = null,
    val ts: Long,
)

@Serializable
data class PendingResponse(val notifications: List<RemoteNotification> = emptyList())

// ---- Anlık durum (ana ekran için) ----
@Serializable
data class FairValue(
    val analystFV: Double? = null,
    val peFV: Double? = null,
    val targetPe: Double? = null,
)

@Serializable
data class StockSnapshot(
    val price: Double? = null,
    val rating: String? = null,
    val fairValue: FairValue? = null,
    val priceTime: Long? = null,
)

// ---- Config (ticker listesi + bildirim tercihleri) ----
@Serializable
data class NotifyPrefs(
    val rating: Boolean = true,
    val fairValue: Boolean = true,
    val criticalNews: Boolean = true,
    val generalNews: Boolean = false,
    val priceAlert: Boolean = false,
)

@Serializable
data class TickerConfig(
    val symbol: String,
    val isEtf: Boolean = false,
    val targetPe: Double? = null,
    val priceAbove: Double? = null,
    val priceBelow: Double? = null,
    val notify: NotifyPrefs = NotifyPrefs(),
)

@Serializable
data class AppSettings(
    val criticalNewsFreqHours: Int = 1,   // 1 veya 2
    val generalNewsFreqHours: Int = 2,    // 1 veya 2
    val pollIntervalHours: Int = 1,       // telefon kaç saatte bir kontrol etsin
)

@Serializable
data class AppConfig(
    val defaultTargetPe: Double = 40.0,
    val settings: AppSettings = AppSettings(),
    val tickers: List<TickerConfig> = emptyList(),
)
