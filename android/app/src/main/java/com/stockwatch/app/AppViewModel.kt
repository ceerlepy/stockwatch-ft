package com.stockwatch.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class UiState(
    val config: AppConfig = AppConfig(),
    val snapshot: Map<String, StockSnapshot> = emptyMap(),
    val loading: Boolean = false,
)

class AppViewModel : ViewModel() {

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    fun load() = viewModelScope.launch {
        _state.value = _state.value.copy(loading = true)
        val cfg = Repository.fetchConfig()
        val snap = Repository.fetchSnapshot()
        _state.value = UiState(config = cfg, snapshot = snap, loading = false)
    }

    fun refresh() = viewModelScope.launch {
        _state.value = _state.value.copy(loading = true)
        Repository.triggerScan()
        // Worker'ın taraması bitince snapshot güncellenir; kısa bekleyip çekiyoruz
        kotlinx.coroutines.delay(3000)
        val snap = Repository.fetchSnapshot()
        _state.value = _state.value.copy(snapshot = snap, loading = false)
        // Bekleyen bildirimleri de hemen çek
        Repository.fetchPending().forEach { /* MainActivity context yok; WorkManager gösterir */ }
    }

    fun addTicker(t: TickerConfig) = viewModelScope.launch {
        val cur = _state.value.config
        if (cur.tickers.any { it.symbol == t.symbol }) return@launch
        val updated = cur.copy(tickers = cur.tickers + t)
        saveAndReload(updated)
    }

    fun removeTicker(symbol: String) = viewModelScope.launch {
        val cur = _state.value.config
        val updated = cur.copy(tickers = cur.tickers.filterNot { it.symbol == symbol })
        saveAndReload(updated)
    }

    fun updateTicker(t: TickerConfig) = viewModelScope.launch {
        val cur = _state.value.config
        val updated = cur.copy(
            tickers = cur.tickers.map { if (it.symbol == t.symbol) t else it }
        )
        saveAndReload(updated)
    }

    fun updateSettings(s: AppSettings) = viewModelScope.launch {
        val cur = _state.value.config
        saveAndReload(cur.copy(settings = s))
    }

    private suspend fun saveAndReload(cfg: AppConfig) {
        _state.value = _state.value.copy(config = cfg, loading = true)
        Repository.saveConfig(cfg)
        val snap = Repository.fetchSnapshot()
        _state.value = _state.value.copy(snapshot = snap, loading = false)
    }
}
