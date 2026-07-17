package com.stockwatch.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val askNotif = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 13+ bildirim izni
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            askNotif.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        // Polling, config yüklenince AppScreen içinde ayarlanır (settings'e göre)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) { AppScreen() }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppScreen(vm: AppViewModel = viewModel()) {
    val scope = rememberCoroutineScope()
    val state by vm.state.collectAsState()
    var showAdd by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<TickerConfig?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    // Settings'teki polling aralığı değişince WorkManager'ı yeniden ayarla
    val ctx = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(state.config.settings.pollIntervalHours) {
        PollWorker.schedule(
            ctx.applicationContext,
            state.config.settings.pollIntervalHours.toLong()
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("StockWatch") },
                actions = {
                    if (state.loading) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(12.dp))
                    }
                    TextButton(onClick = { scope.launch { vm.refresh() } }) {
                        Text("Yenile")
                    }
                    TextButton(onClick = { showSettings = true }) {
                        Text("⚙")
                    }
                }
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showAdd = true },
                text = { Text("Hisse Ekle") },
                icon = { Text("+") }
            )
        }
    ) { pad ->
        LazyColumn(
            Modifier.padding(pad).fillMaxSize(),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(state.config.tickers, key = { it.symbol }) { t ->
                StockCard(
                    ticker = t,
                    snap = state.snapshot[t.symbol],
                    onEdit = { editing = t },
                    onRemove = { scope.launch { vm.removeTicker(t.symbol) } }
                )
            }
            if (state.config.tickers.isEmpty() && !state.loading) {
                item { Text("Henüz hisse yok. Sağ alttan ekle.") }
            }
        }
    }

    if (showAdd) {
        AddTickerDialog(
            onDismiss = { showAdd = false },
            onAdd = { cfg -> scope.launch { vm.addTicker(cfg); showAdd = false } }
        )
    }
    editing?.let { t ->
        EditNotifyDialog(
            ticker = t,
            onDismiss = { editing = null },
            onSave = { updated -> scope.launch { vm.updateTicker(updated); editing = null } }
        )
    }
    if (showSettings) {
        SettingsDialog(
            current = state.config.settings,
            onDismiss = { showSettings = false },
            onSave = { s -> scope.launch { vm.updateSettings(s); showSettings = false } }
        )
    }
}

@Composable
fun SettingsDialog(
    current: AppSettings,
    onDismiss: () -> Unit,
    onSave: (AppSettings) -> Unit,
) {
    var criticalFreq by remember { mutableStateOf(current.criticalNewsFreqHours) }
    var generalFreq by remember { mutableStateOf(current.generalNewsFreqHours) }
    var pollFreq by remember { mutableStateOf(current.pollIntervalHours) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ayarlar") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Kritik haber tarama sıklığı", fontWeight = FontWeight.Bold)
                FreqSelector(selected = criticalFreq) { criticalFreq = it }

                Text("Genel haber tarama sıklığı", fontWeight = FontWeight.Bold)
                FreqSelector(selected = generalFreq) { generalFreq = it }

                Text("Telefon kontrol sıklığı (bildirim çekme)", fontWeight = FontWeight.Bold)
                FreqSelector(selected = pollFreq) { pollFreq = it }

                Text(
                    "Not: Fiyat, rating ve fair value taraması Cloudflare'de saat başı " +
                    "sabittir. Telefon kontrol sıklığını düşürmek pili biraz daha korur.",
                    style = MaterialTheme.typography.bodySmall
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(
                    AppSettings(
                        criticalNewsFreqHours = criticalFreq,
                        generalNewsFreqHours = generalFreq,
                        pollIntervalHours = pollFreq,
                    )
                )
            }) { Text("Kaydet") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("İptal") } }
    )
}

@Composable
fun FreqSelector(selected: Int, onSelect: (Int) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(1, 2).forEach { hours ->
            FilterChip(
                selected = selected == hours,
                onClick = { onSelect(hours) },
                label = { Text("$hours saat") }
            )
        }
    }
}

@Composable
fun StockCard(
    ticker: TickerConfig,
    snap: StockSnapshot?,
    onEdit: () -> Unit,
    onRemove: () -> Unit,
) {
    Card {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(ticker.symbol, style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold)
                snap?.price?.let {
                    Text("$${fmt(it)}", style = MaterialTheme.typography.titleMedium)
                }
            }
            Spacer(Modifier.height(6.dp))

            if (!ticker.isEtf) {
                snap?.rating?.let {
                    val color = when (it) {
                        "Buy" -> "🟢"; "Sell" -> "🔴"; else -> "🟡"
                    }
                    Text("Rating: $color $it")
                }
                snap?.fairValue?.let { fv ->
                    fv.analystFV?.let { Text("Fair value (analist): $${fmt(it)}") }
                    fv.peFV?.let {
                        Text("Fair value (P/E ${fv.targetPe?.toInt()}x): $${fmt(it)}")
                    }
                    // Fiyat vs fair value farkı
                    val price = snap.price
                    val ref = fv.analystFV ?: fv.peFV
                    if (price != null && ref != null && ref > 0) {
                        val diff = (price - ref) / ref * 100
                        val label = if (diff > 0) "üzerinde" else "altında"
                        Text("Fiyat, adil değerin %${fmt(kotlin.math.abs(diff))} $label")
                    }
                }
            } else {
                Text("ETC — sadece fiyat & haber takibi")
            }

            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onEdit) { Text("Ayarlar") }
                TextButton(onClick = onRemove) { Text("Kaldır") }
            }
        }
    }
}

@Composable
fun AddTickerDialog(onDismiss: () -> Unit, onAdd: (TickerConfig) -> Unit) {
    var symbol by remember { mutableStateOf("") }
    var isEtf by remember { mutableStateOf(false) }
    var pe by remember { mutableStateOf("40") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Hisse Ekle") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = symbol, onValueChange = { symbol = it.uppercase() },
                    label = { Text("Sembol (ör. AVGO, NVDA, SGLN.L)") }, singleLine = true
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = isEtf, onCheckedChange = { isEtf = it })
                    Text("ETF / ETC (rating yok)")
                }
                if (!isEtf) {
                    OutlinedTextField(
                        value = pe, onValueChange = { pe = it },
                        label = { Text("Hedef P/E (kendi modelin)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = symbol.isNotBlank(),
                onClick = {
                    onAdd(
                        TickerConfig(
                            symbol = symbol.trim(),
                            isEtf = isEtf,
                            targetPe = pe.toDoubleOrNull(),
                            notify = if (isEtf)
                                NotifyPrefs(rating = false, fairValue = false)
                            else NotifyPrefs()
                        )
                    )
                }
            ) { Text("Ekle") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("İptal") } }
    )
}

@Composable
fun EditNotifyDialog(
    ticker: TickerConfig,
    onDismiss: () -> Unit,
    onSave: (TickerConfig) -> Unit,
) {
    var n by remember { mutableStateOf(ticker.notify) }
    var pe by remember { mutableStateOf(ticker.targetPe?.toInt()?.toString() ?: "") }
    var above by remember { mutableStateOf(ticker.priceAbove?.toString() ?: "") }
    var below by remember { mutableStateOf(ticker.priceBelow?.toString() ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${ticker.symbol} ayarları") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text("Bildirimler", fontWeight = FontWeight.Bold)
                if (!ticker.isEtf) {
                    Toggle("Rating değişimi", n.rating) { n = n.copy(rating = it) }
                    Toggle("Fair value değişimi", n.fairValue) { n = n.copy(fairValue = it) }
                }
                Toggle("Kritik haber", n.criticalNews) { n = n.copy(criticalNews = it) }
                Toggle("Genel haber", n.generalNews) { n = n.copy(generalNews = it) }
                Toggle("Fiyat alarmı", n.priceAlert) { n = n.copy(priceAlert = it) }

                if (n.priceAlert) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = above, onValueChange = { above = it },
                            label = { Text("Üst $") }, singleLine = true,
                            modifier = Modifier.weight(1f),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                        )
                        OutlinedTextField(
                            value = below, onValueChange = { below = it },
                            label = { Text("Alt $") }, singleLine = true,
                            modifier = Modifier.weight(1f),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                        )
                    }
                }

                if (!ticker.isEtf) {
                    Spacer(Modifier.height(8.dp))
                    Text("Fair value modeli", fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = pe, onValueChange = { pe = it },
                        label = { Text("Hedef P/E (kendi modelin)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(
                    ticker.copy(
                        notify = n,
                        targetPe = pe.toDoubleOrNull() ?: ticker.targetPe,
                        priceAbove = above.toDoubleOrNull(),
                        priceBelow = below.toDoubleOrNull(),
                    )
                )
            }) { Text("Kaydet") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("İptal") } }
    )
}

@Composable
fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

fun fmt(d: Double): String = "%.2f".format(d)
