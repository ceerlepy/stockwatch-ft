package com.stockwatch.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val askNotif = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            askNotif.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
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
    val scope   = rememberCoroutineScope()
    val state   by vm.state.collectAsState()
    val ctx     = LocalContext.current
    var showAdd      by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var editing      by remember { mutableStateOf<TickerConfig?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    // Polling'i settings'teki aralıkla başlat/güncelle
    LaunchedEffect(state.config.settings.pollIntervalHours) {
        PollWorker.schedule(ctx.applicationContext,
            state.config.settings.pollIntervalHours.toLong())
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("StockWatch") },
                actions = {
                    if (state.loading) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    TextButton(onClick = { scope.launch { vm.refresh() } }) { Text("Yenile") }
                    TextButton(onClick = { showSettings = true }) { Text("⚙") }
                }
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showAdd = true },
                shape = MaterialTheme.shapes.large,
            ) {
                Text("+", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            }
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
                    snap   = state.snapshot[t.symbol],
                    onEdit = { editing = t },
                    onRemove = { scope.launch { vm.removeTicker(t.symbol) } }
                )
            }
            if (state.config.tickers.isEmpty() && !state.loading) {
                item { Text("Henüz hisse yok. Sağ alttan ekle.") }
            }
        }
    }

    if (showAdd) AddTickerDialog(
        onDismiss = { showAdd = false },
        onAdd     = { cfg -> scope.launch { vm.addTicker(cfg); showAdd = false } }
    )

    editing?.let { t ->
        EditTickerDialog(
            ticker    = t,
            onDismiss = { editing = null },
            onSave    = { updated -> scope.launch { vm.updateTicker(updated); editing = null } }
        )
    }

    if (showSettings) SettingsDialog(
        current   = state.config.settings,
        onDismiss = { showSettings = false },
        onSave    = { s -> scope.launch { vm.updateSettings(s); showSettings = false } }
    )
}

// ── Hisse kartı ───────────────────────────────────────────────────────────
@Composable
fun StockCard(
    ticker: TickerConfig,
    snap: StockSnapshot?,
    onEdit: () -> Unit,
    onRemove: () -> Unit,
) {
    val ratingColor = when (snap?.rating) {
        "Buy"  -> Color(0xFF2ECC71)
        "Sell" -> Color(0xFFE74C3C)
        "Hold" -> Color(0xFFF1C40F)
        else   -> MaterialTheme.colorScheme.outline
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 3.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)
    ) {
        Row(Modifier.fillMaxWidth()) {
            // Sol renk şeridi — rating durumunu anında gösterir
            Box(
                Modifier
                    .width(5.dp)
                    .fillMaxHeight()
                    .background(ratingColor)
            )

            Column(
                Modifier
                    .padding(horizontal = 18.dp, vertical = 16.dp)
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {

                // Başlık satırı: sembol + fiyat
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment     = Alignment.CenterVertically
                ) {
                    Text(ticker.symbol,
                        style      = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.ExtraBold)
                    snap?.price?.let {
                        Text("$${fmt(it)}",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.SemiBold)
                    }
                }

                // ── Uyarı / hata durumları ────────────────────────────────
                if (snap?.invalid == true) {
                    StatusChip(
                        text  = snap.note ?: "\"${ticker.symbol}\" bulunamadı — sembolü kontrol et",
                        color = MaterialTheme.colorScheme.error
                    )
                }
                if (snap?.rateLimitError == true) {
                    StatusChip(
                        text  = snap.rateLimitNote ?: "⚠️ Servis istek limiti aşıldı — sonraki saatte yenilenir",
                        color = MaterialTheme.colorScheme.error
                    )
                }
                snap?.note?.let { n ->
                    if (snap.invalid != true) {
                        StatusChip(text = n, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                // ── Normal veri ───────────────────────────────────────────
                if (snap?.invalid != true) {

                    snap?.rating?.let { r ->
                        val emoji = when (r) { "Buy" -> "🟢"; "Sell" -> "🔴"; else -> "🟡" }
                        Surface(
                            color = ratingColor.copy(alpha = 0.15f),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("$emoji  $r",
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.SemiBold)
                        }
                    }

                    snap?.fairValue?.let { fv ->
                        Spacer(Modifier.height(2.dp))
                        if (fv.analystFV != null) {
                            FairValueRow("Analist hedefi", fv.analystFV, snap.price)
                        }
                        if (fv.peFV != null) {
                            val label = if (fv.peSource == "auto")
                                "Fair value (P/E ${fv.targetPe?.toInt()}x, otomatik)"
                            else "Fair value (P/E ${fv.targetPe?.toInt()}x)"
                            FairValueRow(label, fv.peFV, snap.price)
                        }
                        fv.note?.let { n ->
                            StatusChip(text = "ℹ️ $n", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        // Kendi güncel P/E'si — sadece bilgi amaçlı, fair value hesabında kullanılmıyor
                        fv.currentPE?.let { cpe ->
                            Text("Güncel P/E: ${fmt(cpe)}x",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }

                    if (ticker.notify.priceAlert) {
                        val parts = listOfNotNull(
                            ticker.priceAbove?.let { "↑$${fmt(it)}" },
                            ticker.priceBelow?.let { "↓$${fmt(it)}" }
                        )
                        if (parts.isNotEmpty()) {
                            Text("🔔 ${parts.joinToString("  ")}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }

                    if (snap?.price == null && snap?.invalid != true) {
                        Text("Veri bekleniyor… (saat başı güncellenir)",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                Spacer(Modifier.height(6.dp))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                Spacer(Modifier.height(2.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onEdit) { Text("Ayarlar") }
                    TextButton(
                        onClick = onRemove,
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                    ) { Text("Kaldır") }
                }
            }
        }
    }
}

@Composable
fun FairValueRow(label: String, value: Double, price: Double?) {
    Column {
        Text("$label: $${fmt(value)}", style = MaterialTheme.typography.bodyMedium)
        price?.let { p ->
            val diff  = (p - value) / value * 100
            val over  = diff > 0
            Text(
                "  → fiyat %${fmt(kotlin.math.abs(diff))} ${if (over) "üzerinde" else "altında"}",
                style = MaterialTheme.typography.bodySmall,
                color = if (over) Color(0xFFE74C3C) else Color(0xFF2ECC71)
            )
        }
    }
}

@Composable
fun StatusChip(text: String, color: androidx.compose.ui.graphics.Color) {
    Surface(
        color        = color.copy(alpha = 0.12f),
        shape        = MaterialTheme.shapes.small,
        modifier     = Modifier.fillMaxWidth()
    ) {
        Text(
            text     = text,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            style    = MaterialTheme.typography.bodySmall,
            color    = color,
        )
    }
}

// ── Hisse ekle dialog ─────────────────────────────────────────────────────
@Composable
fun AddTickerDialog(onDismiss: () -> Unit, onAdd: (TickerConfig) -> Unit) {
    var symbol by remember { mutableStateOf("") }
    var isEtf  by remember { mutableStateOf(false) }
    var pe     by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Hisse Ekle") },
        text  = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = symbol, onValueChange = { symbol = it.uppercase().trim() },
                    label = { Text("Sembol (ör. NVDA, AVGO, SGLN.L)") }, singleLine = true
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = isEtf, onCheckedChange = { isEtf = it })
                    Text("ETF / ETC (rating takibi yok)")
                }
                if (!isEtf) {
                    OutlinedTextField(
                        value = pe, onValueChange = { pe = it },
                        label = { Text("Hedef P/E (opsiyonel)") },
                        placeholder = { Text("Boş bırak, otomatik hesaplansın") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true
                    )
                    Text(
                        "Boş bırakırsan sektör benzerlerinin ortalama çarpanı otomatik kullanılır.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    "İlk taramada sembol Finnhub'da doğrulanır. Geçersizse kart uyarı gösterir.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = symbol.isNotBlank(),
                onClick = {
                    onAdd(TickerConfig(
                        symbol    = symbol,
                        isEtf     = isEtf,
                        targetPe  = pe.toDoubleOrNull(),
                        notify    = if (isEtf)
                            NotifyPrefs(rating = false, fairValue = false)
                        else NotifyPrefs()
                    ))
                }
            ) { Text("Ekle") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("İptal") } }
    )
}

// ── Ticker ayarlar dialog ─────────────────────────────────────────────────
@Composable
fun EditTickerDialog(ticker: TickerConfig, onDismiss: () -> Unit, onSave: (TickerConfig) -> Unit) {
    var n     by remember { mutableStateOf(ticker.notify) }
    var pe    by remember { mutableStateOf(ticker.targetPe?.toInt()?.toString() ?: "") }
    var above by remember { mutableStateOf(ticker.priceAbove?.toString() ?: "") }
    var below by remember { mutableStateOf(ticker.priceBelow?.toString() ?: "") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${ticker.symbol} Ayarları") },
        text  = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text("Bildirimler", fontWeight = FontWeight.Bold)
                if (!ticker.isEtf) {
                    Toggle("Rating değişimi (Buy/Hold/Sell)", n.rating)    { n = n.copy(rating = it) }
                    Toggle("Fair value değişimi",             n.fairValue) { n = n.copy(fairValue = it) }
                }
                Toggle("Kritik haber",   n.criticalNews) { n = n.copy(criticalNews = it) }
                Toggle("Genel haber",    n.generalNews)  { n = n.copy(generalNews = it) }
                Toggle("Fiyat alarmı",   n.priceAlert)   { n = n.copy(priceAlert = it) }

                if (n.priceAlert) {
                    Spacer(Modifier.height(4.dp))
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
                    Text("Fair Value Modeli", fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = pe, onValueChange = { pe = it },
                        label = { Text("Hedef P/E (opsiyonel)") }, singleLine = true,
                        placeholder = { Text("Boş = otomatik (sektör ortalaması)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(ticker.copy(
                    notify     = n,
                    targetPe   = pe.toDoubleOrNull() ?: ticker.targetPe,
                    priceAbove = above.toDoubleOrNull(),
                    priceBelow = below.toDoubleOrNull(),
                ))
            }) { Text("Kaydet") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("İptal") } }
    )
}

// ── Global ayarlar dialog ─────────────────────────────────────────────────
@Composable
fun SettingsDialog(current: AppSettings, onDismiss: () -> Unit, onSave: (AppSettings) -> Unit) {
    var criticalFreq   by remember { mutableStateOf(current.criticalNewsFreqHours) }
    var generalFreq    by remember { mutableStateOf(current.generalNewsFreqHours) }
    var pollFreq       by remember { mutableStateOf(current.pollIntervalHours) }
    var correlationOn  by remember { mutableStateOf(current.correlationEnabled) }
    var moveExplainOn  by remember { mutableStateOf(current.moveExplanationEnabled) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ayarlar") },
        text  = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Text("Kritik haber tarama sıklığı", fontWeight = FontWeight.Bold)
                FreqSelector(criticalFreq) { criticalFreq = it }

                Text("Genel haber tarama sıklığı", fontWeight = FontWeight.Bold)
                FreqSelector(generalFreq) { generalFreq = it }

                Text("Telefon kontrol sıklığı", fontWeight = FontWeight.Bold)
                FreqSelector(pollFreq) { pollFreq = it }

                Spacer(Modifier.height(4.dp))
                Toggle("📊 Otomatik korelasyon uyarıları (deneysel)", correlationOn) { correlationOn = it }
                if (correlationOn) {
                    Text(
                        "Sistem hisseler arası ilişkiyi (ör. TSM→MRVL) kendi keşfeder ve " +
                        "biri büyük hareket edince diğeri için tahmini uyarı gönderir. " +
                        "Anlamlı sonuç için birkaç günlük veri birikmesi gerekir.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Spacer(Modifier.height(4.dp))
                Toggle("❓ \"Neden hareket etti\" açıklaması (deneysel)", moveExplainOn) { moveExplainOn = it }
                if (moveExplainOn) {
                    Text(
                        "Bir hisse %3+ hareket ettiğinde o günün haberlerine bakıp " +
                        "muhtemel sebebi açıklar. Korelasyondan bağımsız çalışır. " +
                        "Belirgin haber yoksa sebep uydurmaz, bunu açıkça söyler.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Spacer(Modifier.height(4.dp))
                Text(
                    "Fiyat & rating taraması Cloudflare'de saat başı sabit çalışır.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(AppSettings(criticalFreq, generalFreq, pollFreq, correlationOn, moveExplainOn))
            }) { Text("Kaydet") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("İptal") } }
    )
}

// ── Küçük yardımcı composable'lar ────────────────────────────────────────
@Composable
fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment     = Alignment.CenterVertically
    ) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
fun FreqSelector(selected: Int, onSelect: (Int) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(1, 2).forEach { h ->
            FilterChip(
                selected = selected == h,
                onClick  = { onSelect(h) },
                label    = { Text("$h saat") }
            )
        }
    }
}

fun fmt(d: Double): String = "%.2f".format(d)
