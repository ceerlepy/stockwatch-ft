package com.stockwatch.app

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

object Repository {

    private val appJson = Json { ignoreUnknownKeys = true; isLenient = true }

    private val client = HttpClient(OkHttp) {
        install(ContentNegotiation) { json(appJson) }
    }

    suspend fun fetchPending(): List<RemoteNotification> = try {
        client.get("${Backend.BASE_URL}/pending") {
            header("x-device-token", Backend.DEVICE_TOKEN)
        }.body<PendingResponse>().notifications
    } catch (e: Exception) {
        emptyList()
    }

    suspend fun fetchSnapshot(): Map<String, StockSnapshot> = try {
        val raw = client.get("${Backend.BASE_URL}/snapshot") {
            header("x-device-token", Backend.DEVICE_TOKEN)
        }.body<JsonObject>()

        raw.entries
            .filter { it.value is JsonObject }
            .mapNotNull { (k, v) ->
                try {
                    k to appJson.decodeFromJsonElement(StockSnapshot.serializer(), v)
                } catch (e: Exception) {
                    null
                }
            }
            .toMap()
    } catch (e: Exception) {
        emptyMap()
    }

    suspend fun fetchConfig(): AppConfig = try {
        client.get("${Backend.BASE_URL}/config") {
            header("x-device-token", Backend.DEVICE_TOKEN)
        }.body()
    } catch (e: Exception) {
        AppConfig()
    }

    suspend fun saveConfig(cfg: AppConfig): Boolean = try {
        client.post("${Backend.BASE_URL}/config") {
            header("x-device-token", Backend.DEVICE_TOKEN)
            contentType(ContentType.Application.Json)
            setBody(cfg)
        }
        true
    } catch (e: Exception) {
        false
    }

    suspend fun triggerScan(): Boolean = try {
        client.post("${Backend.BASE_URL}/scan") {
            header("x-device-token", Backend.DEVICE_TOKEN)
        }
        true
    } catch (e: Exception) {
        false
    }
}