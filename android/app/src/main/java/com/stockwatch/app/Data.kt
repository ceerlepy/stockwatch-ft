package com.stockwatch.app

import kotlinx.serialization.Serializable

object Backend {
    const val BASE_URL    = "https://stockwatch.veyseltosun-vt.workers.dev"
    const val DEVICE_TOKEN = "vt-mrvl-9f3kQ7xP2z"
}

@Serializable
data class RemoteNotification(
    val id: String,
    val symbol: String,
    val type: String,
    val title: String,
    val body: String,
    val url: String? = null,
    val ts: Long,
)

@Serializable
data class PendingResponse(val notifications: List<RemoteNotification> = emptyList())

@Serializable
data class FairValue(
    val analystFV: Double? = null,
    val peFV: Double? = null,
    val targetPe: Double? = null,
    val note: String? = null,      // "Finnhub premium gerekli" gibi notlar
)

@Serializable
data class StockSnapshot(
    val price: Double? = null,
    val rating: String? = null,
    val ratingDetail: kotlinx.serialization.json.JsonObject? = null,
    val fairValue: FairValue? = null,
    val priceTime: Long? = null,
    // Durum / uyarı alanları
    val invalid: Boolean? = null,        // geçersiz sembol
    val unsupported: Boolean? = null,    // Finnhub desteklemiyor
    val rateLimitError: Boolean? = null, // 429 rate limit
    val rateLimitNote: String? = null,
    val note: String? = null,            // genel not (ETF notu, sembol uyarısı vs)
)

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
    val criticalNewsFreqHours: Int = 1,
    val generalNewsFreqHours: Int = 2,
    val pollIntervalHours: Int = 1,
)

@Serializable
data class AppConfig(
    val defaultTargetPe: Double = 40.0,
    val finnhubUrl: String = "https://finnhub.io/api/v1",
    val settings: AppSettings = AppSettings(),
    val tickers: List<TickerConfig> = emptyList(),
)
