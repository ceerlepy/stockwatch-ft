/**
 * StockWatch Backend — Cloudflare Worker
 * Best-practice, production-ready versiyon
 *
 * - Yeni ticker → ayrı KV'de validation queue, race condition yok
 * - Finnhub URL config'den (API değişimi tek satır)
 * - notify eksikse varsayılan doldur
 * - price-target/metric 403 → "premium" notu, devam et
 * - 429 → snapshot'a yaz + retry bilgisi
 * - ETF/ETC → sadece fiyat + haber, rating/fairvalue atla
 * - Geçersiz sembol → snapshot'a invalid + note yaz
 * - Ticker'lar arası 1sn bekleme
 */

const DEFAULT_FINNHUB = "https://finnhub.io/api/v1";

const CRITICAL_KEYWORDS = [
  "earnings","guidance","acquisition","acquire","merger",
  "ceo","cfo","resign","appoint","downgrade","upgrade",
  "lawsuit","sec","dividend","buyback","layoff","restructur",
  "profit warning","outlook","forecast",
];

const DEFAULT_NOTIFY = {
  rating: true, fairValue: true, criticalNews: true,
  generalNews: false, priceAlert: false,
};

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const auth = request.headers.get("x-device-token");
    if (auth !== env.DEVICE_TOKEN) return resp({ error: "unauthorized" }, 401);

    switch (`${request.method} ${url.pathname}`) {
      case "GET /pending":  return handlePending(env);
      case "GET /snapshot": return resp(await env.STOCKWATCH_KV.get("snapshot","json") || {});
      case "GET /config":   return resp(await env.STOCKWATCH_KV.get("config","json")   || defaultConfig());
      case "POST /config":  return handleConfigSave(request, env);
      case "POST /scan":    await runScan(env, "manual"); return resp({ ok: true });
      default:              return resp({ error: "not found" }, 404);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env, event.cron));
    // Günde bir kez (00:00 civarı 2 saatlik cron'a denk gelen ilk tetiklemede)
    // korelasyon tablosunu yeniden hesapla — özellik açıksa
    if (event.cron === "0 */2 * * *") {
      const hour = new Date().getUTCHours();
      if (hour === 0) ctx.waitUntil(recomputeCorrelations(env));
    }
  },
};

// ── Config kaydet ──────────────────────────────────────────────────────────
async function handleConfigSave(request, env) {
  const body     = await request.json();
  const existing = await env.STOCKWATCH_KV.get("config","json") || defaultConfig();
  const existingSymbols = new Set(existing.tickers.map(t => t.symbol));

  // Yeni sembolleri validation kuyruğuna ekle (config'e _new yazmıyoruz)
  const newSymbols = body.tickers
    .map(t => t.symbol)
    .filter(s => !existingSymbols.has(s));

  if (newSymbols.length > 0) {
    const pending = JSON.parse(await env.STOCKWATCH_KV.get("validation_queue") || "[]");
    const merged  = [...new Set([...pending, ...newSymbols])];
    await env.STOCKWATCH_KV.put("validation_queue", JSON.stringify(merged));
  }

  // notify alanlarını her zaman tamamla
  body.tickers = body.tickers.map(t => ({
    ...t,
    notify: { ...DEFAULT_NOTIFY, ...(t.notify || {}) },
  }));

  await env.STOCKWATCH_KV.put("config", JSON.stringify(body));
  return resp({ ok: true });
}

// ── Bekleyen bildirimleri döndür ve temizle ───────────────────────────────
async function handlePending(env) {
  const pending = await env.STOCKWATCH_KV.get("pending","json") || [];
  if (pending.length > 0) await env.STOCKWATCH_KV.put("pending", "[]");
  return resp({ notifications: pending });
}

// ── Ana tarama ────────────────────────────────────────────────────────────
async function runScan(env, cronTag) {
  const config   = await env.STOCKWATCH_KV.get("config","json") || defaultConfig();
  const FINNHUB  = config.finnhubUrl || DEFAULT_FINNHUB;
  const key      = env.FINNHUB_KEY;
  const settings = config.settings   || defaultSettings();

  const isHourly  = cronTag === "0 * * * *";
  const is2Hourly = cronTag === "0 */2 * * *";
  const isManual  = cronTag === "manual";

  const doPriceRating  = isHourly || isManual;
  const doGeneralNews  = isManual
    || (settings.generalNewsFreqHours  === 1 && isHourly)
    || (settings.generalNewsFreqHours  === 2 && is2Hourly);
  const doCriticalNews = isManual
    || (settings.criticalNewsFreqHours === 1 && isHourly)
    || (settings.criticalNewsFreqHours === 2 && (isHourly || is2Hourly));

  const snapshot  = await env.STOCKWATCH_KV.get("snapshot","json") || {};
  const notes     = [];
  const validationQueue = new Set(
    JSON.parse(await env.STOCKWATCH_KV.get("validation_queue") || "[]")
  );

  for (const t of config.tickers) {
    const sym = t.symbol;
    snapshot[sym] = snapshot[sym] || {};
    t.notify = { ...DEFAULT_NOTIFY, ...(t.notify || {}) };

    // ── Yeni sembol validasyonu ───────────────────────────────────────────
    if (validationQueue.has(sym)) {
      const valid = await validateSymbol(FINNHUB, key, sym);
      validationQueue.delete(sym);
      if (!valid) {
        snapshot[sym] = {
          invalid: true,
          note: `"${sym}" Finnhub'da bulunamadı. Sembolü kontrol et.`,
          _updated: Date.now(),
        };
        console.log(`[INVALID] ${sym}`);
        continue;
      }
      console.log(`[VALID] ${sym}`);
    }

    // Daha önce geçersiz işaretlendiyse atla
    if (snapshot[sym].invalid) continue;

    const isEtf       = t.isEtf === true;
    const doRating    = !isEtf && t.notify.rating    !== false;
    const doFairValue = !isEtf && t.notify.fairValue !== false;

    // Rate limit koruması
    await sleep(1000);

    try {
      // ── 1. Fiyat ─────────────────────────────────────────────────────
      if (doPriceRating) {
        const quote = await get(FINNHUB, `/quote?symbol=${sym}&token=${key}`);
        if (quote?.c > 0) {
          snapshot[sym].price         = quote.c;
          snapshot[sym].priceTime     = Date.now();
          snapshot[sym].rateLimitError = false;
          if (isEtf) snapshot[sym].note = "ETF/ETC — fiyat & haber takibi";

          // Fiyat alarmı
          if (t.notify.priceAlert) {
            await checkPriceAlert(env, sym, quote.c, t.priceAbove, t.priceBelow, notes);
          }

          // Fiyat geçmişi — korelasyon VEYA "neden hareket etti" özelliği
          // açıksa kaydedilir (ikisi de saatlik geçmişe ihtiyaç duyuyor)
          if (config.settings?.correlationEnabled || config.settings?.moveExplanationEnabled) {
            await appendPriceHistory(env, sym, quote.c);
          }
        } else if (quote?.c === 0) {
          snapshot[sym].note = `"${sym}" fiyatı 0 — sembolü kontrol et`;
        }
      }

      // ── 2. Rating ─────────────────────────────────────────────────────
      if (doPriceRating && doRating) {
        const recs = await get(FINNHUB, `/stock/recommendation?symbol=${sym}&token=${key}`);
        if (Array.isArray(recs) && recs.length > 0) {
          const rating = deriveRating(recs[0]);
          const prev   = await env.STOCKWATCH_KV.get(`rating:${sym}`);
          snapshot[sym].rating       = rating;
          snapshot[sym].ratingDetail = recs[0];
          if (prev && prev !== rating) {
            notes.push(note(sym, "rating", `${sym}: Rating değişti`, `${prev} → ${rating}`));
          }
          await env.STOCKWATCH_KV.put(`rating:${sym}`, rating);
        }
      }

      // ── 3. Fair value ─────────────────────────────────────────────────
      if (doPriceRating && doFairValue) {
        let analystFV = null, peFV = null, fvNote = null;

        const pt = await getSoft(FINNHUB, `/stock/price-target?symbol=${sym}&token=${key}`);
        if (pt === "PREMIUM") {
          fvNote = "Analist hedefi: Finnhub premium gerekli";
        } else if (pt?.targetMean > 0) {
          analystFV = round2(pt.targetMean);
        }

        const epsData = await getEpsTTM(FINNHUB, key, sym);
        let peUsed = null, peSource = null, currentPE = null;

        if (epsData.eps && epsData.eps > 0) {
          // Kendi güncel P/E'si — bilgi amaçlı gösterilir, fair value hesabında
          // KULLANILMAZ. Sebep: kendi P/E'siyle fair value hesaplarsan sonuç
          // matematiksel olarak mevcut fiyata eşit çıkar (tautoloji, %0 fark
          // gösterir), hiçbir karşılaştırma değeri olmaz.
          currentPE = epsData.peTTM ?? (snapshot[sym].price ? round2(snapshot[sym].price / epsData.eps) : null);

          // Kullanıcı manuel P/E girdiyse onu kullan; girmediyse sektör
          // benzerlerinin P/E'sini otomatik hesapla (ücretsiz kaynaklardan,
          // /stock/metric'e bağımlı değil — comparable company analysis mantığı).
          if (t.targetPe) {
            peUsed = t.targetPe; peSource = "manual";
          } else {
            peUsed = await getAutoPE(FINNHUB, key, env, sym);
            peSource = "auto";
          }
          if (typeof peUsed === "number" && peUsed > 0) {
            peFV = round2(epsData.eps * peUsed);
          }
        } else if (!fvNote) {
          // Ne metric ne earnings'ten EPS bulunamadı — dürüstçe belirt
          fvNote = "EPS verisi bulunamadı (ücretsiz kaynaklardan erişilemedi)";
        }

        const fv   = { analystFV, peFV, targetPe: peUsed, peSource, currentPE, note: fvNote };
        const prev = await env.STOCKWATCH_KV.get(`fv:${sym}`);
        snapshot[sym].fairValue = fv;

        if (prev && fvChanged(prev, fv)) {
          notes.push(note(sym, "fairValue", `${sym}: Fair value güncellendi`, fvSummary(prev, fv)));
        }
        await env.STOCKWATCH_KV.put(`fv:${sym}`, JSON.stringify(fv));
      }

      // ── 4. Haberler ───────────────────────────────────────────────────
      if (doGeneralNews || doCriticalNews) {
        const today = new Date();
        const from  = new Date(today.getTime() - 2 * 24 * 3600 * 1000);
        const news  = await getSoft(FINNHUB,
          `/company-news?symbol=${sym}&from=${fmtDate(from)}&to=${fmtDate(today)}&token=${key}`
        );
        if (Array.isArray(news)) {
          const seen     = new Set(JSON.parse(await env.STOCKWATCH_KV.get(`newsseen:${sym}`) || "[]"));
          const freshIds = [];
          for (const n of news.slice(0, 30)) {
            const id = String(n.id);
            freshIds.push(id);
            if (seen.has(id)) continue;
            const hl = (n.headline || "").toLowerCase();
            const critical = CRITICAL_KEYWORDS.some(kw => hl.includes(kw));
            if (critical && doCriticalNews && t.notify.criticalNews !== false) {
              notes.push(note(sym, "criticalNews", `⚠️ ${sym}: Kritik haber`, n.headline, n.url));
            } else if (!critical && doGeneralNews && t.notify.generalNews === true) {
              notes.push(note(sym, "news", `${sym}: Haber`, n.headline, n.url));
            }
          }
          await env.STOCKWATCH_KV.put(`newsseen:${sym}`, JSON.stringify(freshIds.slice(0, 60)));
        }
      }

    } catch (err) {
      const msg = String(err);
      console.log(`[ERROR] ${sym}: ${msg}`);
      if (msg.includes("429")) {
        snapshot[sym].rateLimitError = true;
        snapshot[sym].rateLimitNote  = "Finnhub istek limiti aşıldı — sonraki saatte yenilenir";
        snapshot[sym].rateLimitTime  = Date.now();
      }
    }
  }

  // ── Korelasyon kontrolü (özellik açıksa) ────────────────────────────────
  // Bu saatte büyük düşüş yaşayan ticker varsa, bilinen korelasyonlara bakıp
  // "X düştü, geçmişe göre Y de düşebilir" tahmini uyarısı üretir.
  if (config.settings?.correlationEnabled) {
    await checkCorrelationTriggers(env, snapshot, notes);
  }

  // ── "Neden hareket etti" kontrolü (özellik açıksa) ──────────────────────
  // Korelasyondan bağımsız: herhangi bir ticker büyük hareket ettiğinde,
  // o günün haberlerine bakıp muhtemel sebebi açıklamaya çalışır. Haber
  // bulunamazsa sebep UYDURMAZ, "belirgin haber yok" der.
  if (config.settings?.moveExplanationEnabled) {
    await checkMoveExplanations(env, snapshot, notes, FINNHUB, key);
  }

  // Validation kuyruğunu güncelle
  await env.STOCKWATCH_KV.put("validation_queue", JSON.stringify([...validationQueue]));

  // Snapshot kaydet
  snapshot._updated = Date.now();
  await env.STOCKWATCH_KV.put("snapshot", JSON.stringify(snapshot));

  // Bildirim kuyruğuna ekle
  if (notes.length > 0) {
    const pending = await env.STOCKWATCH_KV.get("pending","json") || [];
    await env.STOCKWATCH_KV.put("pending", JSON.stringify([...pending, ...notes].slice(-100)));
  }
}

// ── Fiyat alarmı ──────────────────────────────────────────────────────────
async function checkPriceAlert(env, sym, price, above, below, notes) {
  const lastFlag = await env.STOCKWATCH_KV.get(`pricealert:${sym}`);
  if (typeof above === "number" && price >= above && lastFlag !== "above") {
    notes.push(note(sym, "priceAlert", `${sym}: Fiyat üst sınırı geçti`, `$${round2(price)} ≥ $${above}`));
    await env.STOCKWATCH_KV.put(`pricealert:${sym}`, "above");
  } else if (typeof below === "number" && price <= below && lastFlag !== "below") {
    notes.push(note(sym, "priceAlert", `${sym}: Fiyat alt sınırın altında`, `$${round2(price)} ≤ $${below}`));
    await env.STOCKWATCH_KV.put(`pricealert:${sym}`, "below");
  } else if (
    (typeof above !== "number" || price < above) &&
    (typeof below !== "number" || price > below)
  ) {
    await env.STOCKWATCH_KV.put(`pricealert:${sym}`, "in");
  }
}

// ── Sembol validasyonu ────────────────────────────────────────────────────
// EPS(TTM) elde etmenin iki yolu:
//  1. /stock/metric (peTTM, epsTTM içeriyor) — ücretsiz katmanda genelde
//     403 dönüyor (premium gerekiyor), test ettiğimizde MRVL için doğrulandı.
//  2. /stock/earnings (çeyreklik gerçekleşen EPS raporları) — farklı bir
//     endpoint ailesi, genelde daha erişilebilir. Son 4 çeyreğin "actual"
//     EPS değerlerini toplayıp TTM (trailing twelve months) EPS'i kendimiz
//     hesaplıyoruz. Metric endpoint'i erişilebilirse onu tercih ediyoruz
//     (daha güvenilir), erişilemezse bu fallback'e düşüyoruz.
async function getEpsTTM(finnhubBase, key, sym) {
  const metric = await getSoft(finnhubBase, `/stock/metric?symbol=${sym}&metric=all&token=${key}`);
  if (metric && metric !== "PREMIUM") {
    const eps = metric?.metric?.epsTTM ?? metric?.metric?.epsInclExtraItemsTTM;
    if (typeof eps === "number" && eps > 0) return { eps, peTTM: metric?.metric?.peTTM ?? null, source: "metric" };
  }

  const earnings = await getSoft(finnhubBase, `/stock/earnings?symbol=${sym}&token=${key}`);
  if (Array.isArray(earnings) && earnings.length > 0) {
    const last4 = earnings.slice(0, 4).map(e => e.actual).filter(v => typeof v === "number");
    if (last4.length > 0) {
      // 4'ten azsa elimizdekiyle orantılayarak TTM tahmini yapıyoruz (yaklaşık)
      const sum = last4.reduce((a, b) => a + b, 0);
      const ttmEstimate = last4.length === 4 ? sum : sum * (4 / last4.length);
      return { eps: round2(ttmEstimate), peTTM: null, source: "earnings" };
    }
  }

  return { eps: null, peTTM: null, source: null };
}

async function validateSymbol(finnhub, key, sym) {
  try {
    const r = await fetch(`${finnhub}/quote?symbol=${sym}&token=${key}`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return false;
    const d = await r.json();
    return d && typeof d.c === "number" && d.c > 0;
  } catch { return false; }
}

// Kullanıcının P/E tahmin etmesine gerek kalmasın diye: aynı sektördeki
// benzer şirketlerin (Finnhub /stock/peers) P/E'sini otomatik hesaplar.
// ÖNEMLİ: peer P/E'si /stock/metric'e (genelde premium/403) değil,
// ücretsiz katmanda çalışan /quote (fiyat) + getEpsTTM (EPS, metric
// erişilemezse /stock/earnings'e düşer) kombinasyonundan KENDİMİZ
// hesaplıyoruz — sırf ücretsiz veriyle çalışsın diye.
// Haftada 1 kez KV'de önbelleklenir (rate limit'e dokunmasın diye).
async function getAutoPE(finnhubBase, key, env, sym) {
  const cacheKey = `peerpe:${sym}`;
  const cached = await env.STOCKWATCH_KV.get(cacheKey, "json");
  if (cached && Date.now() - cached.computedAt < 7 * 24 * 3600 * 1000) {
    return cached.pe;
  }

  try {
    const peersResp = await fetch(`${finnhubBase}/stock/peers?symbol=${sym}&token=${key}`, { cf: { cacheTtl: 0 } });
    if (!peersResp.ok) return cached?.pe ?? null;
    const peers = (await peersResp.json() || []).filter(p => p !== sym).slice(0, 5);

    const pes = [];
    for (const peer of peers) {
      await sleep(300); // rate limit koruması

      const quoteResp = await fetch(`${finnhubBase}/quote?symbol=${peer}&token=${key}`, { cf: { cacheTtl: 0 } });
      if (!quoteResp.ok) continue;
      const quote = await quoteResp.json();
      if (!(quote?.c > 0)) continue;

      const epsData = await getEpsTTM(finnhubBase, key, peer);
      if (!epsData.eps || epsData.eps <= 0) continue;

      const peerPE = quote.c / epsData.eps;
      if (peerPE > 0 && peerPE < 200) pes.push(peerPE); // aşırı uç değerleri ele
    }

    if (pes.length === 0) return cached?.pe ?? null;
    const avgPe = round2(pes.reduce((a, b) => a + b, 0) / pes.length);
    await env.STOCKWATCH_KV.put(cacheKey, JSON.stringify({ pe: avgPe, computedAt: Date.now(), peerCount: pes.length }));
    return avgPe;
  } catch (err) {
    console.log(`[AUTO-PE ERROR] ${sym}: ${err}`);
    return cached?.pe ?? null;
  }
}

// ── HTTP yardımcıları ─────────────────────────────────────────────────────
async function get(base, path) {
  const r = await fetch(base + path, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`HTTP ${r.status} → ${base + path}`);
  return r.json();
}

async function getSoft(base, path) {
  const r = await fetch(base + path, { cf: { cacheTtl: 0 } });
  if (r.status === 403 || r.status === 404) return "PREMIUM";
  if (!r.ok) throw new Error(`HTTP ${r.status} → ${base + path}`);
  return r.json();
}

// ── Genel yardımcılar ─────────────────────────────────────────────────────
function deriveRating(rec) {
  const buy  = (rec.strongBuy || 0) + (rec.buy || 0);
  const hold = rec.hold || 0;
  const sell = (rec.sell || 0) + (rec.strongSell || 0);
  if (buy >= hold && buy >= sell) return "Buy";
  if (sell > buy  && sell > hold) return "Sell";
  return "Hold";
}

function fvChanged(prevRaw, cur) {
  try { const p = JSON.parse(prevRaw); return p.analystFV !== cur.analystFV || p.peFV !== cur.peFV; }
  catch { return false; }
}

function fvSummary(prevRaw, cur) {
  try {
    const p = JSON.parse(prevRaw), parts = [];
    if (p.analystFV !== cur.analystFV) parts.push(`Analist: $${p.analystFV}→$${cur.analystFV}`);
    if (p.peFV      !== cur.peFV)      parts.push(`P/E: $${p.peFV}→$${cur.peFV}`);
    return parts.join(" | ") || "Güncellendi";
  } catch { return "Güncellendi"; }
}

function note(symbol, type, title, body, url) {
  // Bildirimler kısa olsun — 100 karakter üstünü kes
  const shortBody = body && body.length > 100 ? body.slice(0, 97) + "..." : body;
  return { id: crypto.randomUUID(), symbol, type, title, body: shortBody, url: url || null, ts: Date.now() };
}

function resp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json" },
  });
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }
function round2(n)  { return Math.round(n * 100) / 100; }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════════
// KORELASYON MOTORU
// ══════════════════════════════════════════════════════════════════════════
// Mantık:
//  1. Her saatlik fiyat, ticker başına KV'de "history:<sym>" altında biriktirilir
//     (son ~30 gün, saatlik nokta — liste [{t: timestamp, p: price}, ...])
//  2. Günde bir kez recomputeCorrelations() çalışır: her ticker çiftini alır,
//     A'nın saatlik %değişimi ile B'nin 0-4 saat SONRAKİ %değişimi arasında
//     Pearson korelasyon katsayısı hesaplar. Düz istatistik — AI kullanmaz,
//     AI bu işte daha kötü olurdu.
//  3. Yeterince güçli ilişki bulunursa (|r| >= 0.5, en az 20 örnek) sonuç
//     "correlations" KV key'ine otomatik yazılır. Kullanıcı hiçbir şey
//     seçmez — sistem kendi keşfeder.
//  4. Her scan sonunda checkCorrelationTriggers() o saat büyük hareket eden
//     ticker'lara bakar, "correlations" tablosunda onunla ilişkili başka
//     ticker var mı diye kontrol eder, varsa AI ile insan-dili açıklama
//     üretip predictive bildirim atar.

const HISTORY_MAX_POINTS = 24 * 30; // ~30 gün saatlik veri
const CORR_MIN_POINTS    = 20;      // en az bu kadar örnek olmadan hesaplama
const CORR_MIN_STRENGTH  = 0.5;     // |r| bu değerin altındaysa "korelasyon yok" say
const BIG_MOVE_THRESHOLD = 0.03;    // %3+ hareket "büyük hareket" sayılır

// Regime-change (ilişki zayıflaması) parametreleri
const REGIME_MIN_RECENT_POINTS = 10; // son 7 günde en az bu kadar eşleşme olmalı
const REGIME_CHANGE_DROP       = 0.3; // baseline'a göre bu kadar (mutlak) düşüş "zayıfladı" sayılır

async function appendPriceHistory(env, sym, price) {
  const raw = await env.STOCKWATCH_KV.get(`history:${sym}`);
  const hist = raw ? JSON.parse(raw) : [];
  hist.push({ t: Date.now(), p: price });
  const trimmed = hist.slice(-HISTORY_MAX_POINTS);
  await env.STOCKWATCH_KV.put(`history:${sym}`, JSON.stringify(trimmed));
}

// Fiyat listesini saatlik % değişim dizisine çevirir
function toPctChanges(hist) {
  const out = [];
  for (let i = 1; i < hist.length; i++) {
    const prev = hist[i - 1].p, cur = hist[i].p;
    if (prev > 0) out.push({ t: hist[i].t, pct: (cur - prev) / prev });
  }
  return out;
}

// Sadece son N günün verisini filtreler (regime-change karşılaştırması için)
function filterSince(pctArr, daysAgo) {
  const cutoff = Date.now() - daysAgo * 24 * 3600 * 1000;
  return pctArr.filter(p => p.t >= cutoff);
}

// Pearson korelasyon katsayısı
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// 0-4 saat gecikme dener, en güçlü korelasyonu döndürür.
// recomputeCorrelations bunu paylaşır, aynı mantık iki yerde tekrar yazılmasın diye.
function bestCorrelation(fromPct, toPct, maxDelayHours = 4) {
  let best = { delay: 0, r: 0, sampleSize: 0 };
  for (let delay = 0; delay <= maxDelayHours; delay++) {
    const { r, sampleSize } = correlationAtDelay(fromPct, toPct, delay);
    if (sampleSize < CORR_MIN_POINTS) continue;
    if (Math.abs(r) > Math.abs(best.r)) best = { delay, r, sampleSize };
  }
  return best;
}

// Belirli bir sabit gecikmede korelasyon hesaplar (regime-change karşılaştırmasında
// baseline ile aynı gecikmeyi kullanmak için tek-gecikmeli versiyon gerekiyor).
function correlationAtDelay(fromPct, toPct, delayHours) {
  const xs = [], ys = [];
  for (const fp of fromPct) {
    const targetTime = fp.t + delayHours * 3600 * 1000;
    const match = toPct.find(tp => Math.abs(tp.t - targetTime) < 30 * 60 * 1000);
    if (match) { xs.push(fp.pct); ys.push(match.pct); }
  }
  return { r: pearson(xs, ys), sampleSize: xs.length };
}

// Günde bir kez çalışır: tüm ticker çiftleri için 0-4 saat gecikmeli korelasyon
// hesaplar (30 günlük veri = baseline). AYRICA son 7 günü aynı gecikmeyle ayrı
// hesaplayıp baseline ile karşılaştırır. İlişki belirgin zayıflamışsa
// (regime change) bunu ayrı bir bildirimle işaretler — "ilişki var" bilgisinden
// daha nadir ve daha değerli: bir şeyin yapısal olarak değiştiğinin erken sinyali.
async function recomputeCorrelations(env) {
  const config = await env.STOCKWATCH_KV.get("config","json") || defaultConfig();

  // Kullanıcı korelasyon özelliğini kapattıysa bu günlük iş hiç çalışmasın —
  // aksi halde sadece "neden hareket etti" açık olan biri de fark etmeden
  // korelasyon tablosu + regime-change bildirimi almaya başlardı.
  if (!config.settings?.correlationEnabled) {
    console.log("[CORRELATION] ozellik kapali, gunluk hesaplama atlandi");
    return;
  }

  const symbols = config.tickers.map(t => t.symbol);
  const results = [];
  const regimeChanges = [];

  for (const from of symbols) {
    const fromHistAll = JSON.parse(await env.STOCKWATCH_KV.get(`history:${from}`) || "[]");
    const fromPctAll  = toPctChanges(fromHistAll);
    if (fromPctAll.length < CORR_MIN_POINTS) continue;

    for (const to of symbols) {
      if (to === from) continue;
      const toHistAll = JSON.parse(await env.STOCKWATCH_KV.get(`history:${to}`) || "[]");
      const toPctAll  = toPctChanges(toHistAll);
      if (toPctAll.length < CORR_MIN_POINTS) continue;

      const baseline = bestCorrelation(fromPctAll, toPctAll);
      if (Math.abs(baseline.r) < CORR_MIN_STRENGTH) continue;

      results.push({
        from, to,
        strength: round2(baseline.r),
        delayHours: baseline.delay,
        sampleSize: baseline.sampleSize,
        computedAt: Date.now(),
      });

      // Regime-change kontrolü: son 7 günü aynı gecikmeyle ayrı ölç
      const fromRecent = filterSince(fromPctAll, 7);
      const toRecent   = filterSince(toPctAll, 7);
      if (fromRecent.length < REGIME_MIN_RECENT_POINTS) continue; // yeterli yeni veri yok

      const recent  = correlationAtDelay(fromRecent, toRecent, baseline.delay);
      const weakened = Math.abs(baseline.r) - Math.abs(recent.r);

      if (weakened >= REGIME_CHANGE_DROP && recent.sampleSize >= REGIME_MIN_RECENT_POINTS) {
        regimeChanges.push({
          from, to,
          baselineStrength: round2(baseline.r),
          recentStrength: round2(recent.r),
          delayHours: baseline.delay,
          drop: round2(weakened),
        });
      }
    }
  }

  await env.STOCKWATCH_KV.put("correlations", JSON.stringify(results));
  console.log(`[CORRELATION] ${results.length} iliski, ${regimeChanges.length} rejim degisimi bulundu`);

  if (regimeChanges.length > 0) {
    await notifyRegimeChanges(env, regimeChanges);
  }
}

// Regime-change bulununca bildirim üretir + KV "pending" kuyruğuna ekler.
// recomputeCorrelations, runScan'in notes dizisine erişemediği için (ayrı
// bir cron dalında çalışıyor) bildirimleri doğrudan pending'e yazıyor.
async function notifyRegimeChanges(env, changes) {
  const pending  = await env.STOCKWATCH_KV.get("pending","json") || [];
  const newNotes = [];

  for (const c of changes) {
    const weekBucket = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
    const dedupeKey  = `regime_notified:${c.from}:${c.to}:${weekBucket}`;
    if (await env.STOCKWATCH_KV.get(dedupeKey)) continue; // bu hafta zaten bildirildi

    const explanation = await explainRegimeChange(env, c);
    newNotes.push(note(
      c.to, "regimeChange",
      `⚡ ${c.from}-${c.to} ilişkisi zayıfladı`,
      explanation
    ));
    await env.STOCKWATCH_KV.put(dedupeKey, "1", { expirationTtl: 7 * 24 * 3600 });
  }

  if (newNotes.length > 0) {
    await env.STOCKWATCH_KV.put("pending", JSON.stringify([...pending, ...newNotes].slice(-100)));
  }
}

// AI ile regime-change açıklaması üretir. Spekülatif olduğunu açıkça belirtir,
// kesin sebep iddia etmez.
async function explainRegimeChange(env, c) {
  const fallback =
    `${c.from} ile ${c.to} arasındaki ilişki zayıflıyor: son 30 günde ${Math.abs(c.baselineStrength)} ` +
    `güçündeyken son 7 günde ${Math.abs(c.recentStrength)}'e düştü. Bunun sebebi şirkete özel bir ` +
    `gelişme olabilir, kontrol etmeni öneririz.`;

  if (!env.AI) return fallback;

  try {
    const prompt =
      `İki hisse (${c.from} ve ${c.to}) arasındaki tarihsel fiyat ilişkisi zayıflıyor: ` +
      `son 30 günde korelasyon gücü ${Math.abs(c.baselineStrength)} iken son 7 günde ` +
      `${Math.abs(c.recentStrength)}'e düştü (${c.delayHours} saat gecikmeli ilişki). ` +
      `Bu genelde şirkete özel bir gelişmenin (yeni tedarikçi, ürün geçişi, farklı bir ` +
      `büyüme sürücüsü vb.) işareti olabilir. Yatırımcıya 2 cümlelik, spekülatif olduğunu ` +
      `açıkça belirten, ihtiyatlı bir Türkçe not yaz. Kesin sebep iddia etme.`;

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 130,
    });
    return result?.response?.trim() || fallback;
  } catch (err) {
    console.log(`[AI ERROR regime-change] ${err}`);
    return fallback;
  }
}

// Her scan sonunda çağrılır — bu saat büyük hareket eden ticker varsa
// korelasyon tablosuna bakıp AI ile açıklamalı tahmin bildirimi üretir
async function checkCorrelationTriggers(env, snapshot, notes) {
  const correlations = JSON.parse(await env.STOCKWATCH_KV.get("correlations") || "[]");
  if (correlations.length === 0) return;

  for (const sym of Object.keys(snapshot)) {
    const hist = JSON.parse(await env.STOCKWATCH_KV.get(`history:${sym}`) || "[]");
    if (hist.length < 2) continue;
    const last = hist[hist.length - 1], prev = hist[hist.length - 2];
    if (prev.p === 0) continue;
    const pctChange = (last.p - prev.p) / prev.p;

    if (Math.abs(pctChange) < BIG_MOVE_THRESHOLD) continue; // büyük hareket değil

    // Bu sembolden etkilenen başka ticker var mı?
    const affects = correlations.filter(c => c.from === sym);
    for (const c of affects) {
      const hourBucket = Math.floor(Date.now() / 3600000);
      const dedupeKey  = `predicted:${sym}:${c.to}:${hourBucket}`;
      const already    = await env.STOCKWATCH_KV.get(dedupeKey);
      if (already) continue; // bu saat için zaten uyarı verildi

      const explanation = await explainCorrelation(env, sym, c.to, pctChange * 100, c);

      notes.push(note(
        c.to, "correlation",
        `📊 ${c.to}: ${sym} hareketi nedeniyle tahmin`,
        explanation
      ));
      await env.STOCKWATCH_KV.put(dedupeKey, "1", { expirationTtl: 3600 * 6 });
    }
  }
}

// Cloudflare Workers AI ile insan-dili açıklama üretir.
// AI binding yoksa (henüz eklenmediyse) sabit şablon metne düşer — hata vermez.
async function explainCorrelation(env, fromSym, toSym, fromPctChange, corr) {
  const fallback = `${fromSym} bu saat %${round2(Math.abs(fromPctChange))} ${fromPctChange < 0 ? "düştü" : "yükseldi"}. ` +
    `Geçmiş ${corr.sampleSize} örneğe göre ${toSym} genelde ${corr.delayHours} saat içinde ` +
    `benzer yönde tepki veriyor (korelasyon gücü: ${Math.abs(corr.strength)}).`;

  if (!env.AI) return fallback; // AI binding eklenmemişse şablonla devam et

  try {
    const prompt =
      `Bir hisse senedi bildirimi için 2 cümlelik Türkçe açıklama yaz. ` +
      `${fromSym} hissesi bu saat %${round2(Math.abs(fromPctChange))} ${fromPctChange < 0 ? "düştü" : "yükseldi"}. ` +
      `Geçmiş verilere göre ${toSym} hissesi ile ${corr.strength > 0 ? "pozitif" : "negatif"} yönde ` +
      `${Math.abs(corr.strength)} güçünde korelasyonu var, genelde ${corr.delayHours} saat gecikmeyle tepki veriyor ` +
      `(${corr.sampleSize} geçmiş örneğe dayanıyor). Yatırımcıya kısa, net, ölçülü bir uyarı ver. ` +
      `Kesin tahmin yapma, "olabilir/genelde" gibi ihtiyatlı dil kullan.`;

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
    });
    return result?.response?.trim() || fallback;
  } catch (err) {
    console.log(`[AI ERROR] ${err}`);
    return fallback;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// "NEDEN HAREKET ETTİ" — haber bazlı, korelasyondan bağımsız
// ══════════════════════════════════════════════════════════════════════════
// Korelasyon motorundan farkı: bu özellik hiçbir ticker'ın başka bir
// ticker'la ilişkisine bakmaz. Sadece "bu hisse bu saat neden hareket etti?"
// sorusuna, o günün gerçek haberlerine bakarak cevap arar. Haber yoksa
// AI'a sebep UYDURTMAZ — dürüstçe "belirgin haber bulunamadı" der.

async function checkMoveExplanations(env, snapshot, notes, finnhubBase, key) {
  for (const sym of Object.keys(snapshot)) {
    const hist = JSON.parse(await env.STOCKWATCH_KV.get(`history:${sym}`) || "[]");
    if (hist.length < 2) continue;
    const last = hist[hist.length - 1], prev = hist[hist.length - 2];
    if (prev.p === 0) continue;
    const pctChange = (last.p - prev.p) / prev.p;
    if (Math.abs(pctChange) < BIG_MOVE_THRESHOLD) continue; // büyük hareket değil

    const hourBucket = Math.floor(Date.now() / 3600000);
    const dedupeKey  = `moveexplain:${sym}:${hourBucket}`;
    if (await env.STOCKWATCH_KV.get(dedupeKey)) continue; // bu saat için zaten üretildi

    // Son 24 saatteki haberleri çek (mevcut olanı tekrar kullan, ekstra
    // bir Finnhub çağrısı — ama sadece büyük hareket olduğunda, nadir)
    let headlines = [];
    try {
      const today = new Date();
      const from  = new Date(today.getTime() - 24 * 3600 * 1000);
      const news  = await getSoft(finnhubBase,
        `/company-news?symbol=${sym}&from=${fmtDate(from)}&to=${fmtDate(today)}&token=${key}`
      );
      if (Array.isArray(news)) {
        headlines = news.slice(0, 5).map(n => n.headline).filter(Boolean);
      }
    } catch (err) {
      console.log(`[MOVE-EXPLAIN NEWS ERROR] ${sym}: ${err}`);
    }

    const explanation = await explainMove(env, sym, pctChange * 100, headlines);
    notes.push(note(
      sym, "moveExplanation",
      `${pctChange < 0 ? "📉" : "📈"} ${sym}: %${round2(Math.abs(pctChange * 100))} hareket`,
      explanation
    ));
    await env.STOCKWATCH_KV.put(dedupeKey, "1", { expirationTtl: 3600 * 6 });
  }
}

async function explainMove(env, sym, pctChange, headlines) {
  const direction = pctChange < 0 ? "düştü" : "yükseldi";
  const pctAbs    = round2(Math.abs(pctChange));

  // Haber yoksa sebep uydurma — dürüst şablon
  if (headlines.length === 0) {
    return `${sym} bu saat %${pctAbs} ${direction}. Şirkete özel belirgin bir haber ` +
      `bulunamadı — sektörel veya genel piyasa hareketi olabilir.`;
  }

  const fallback = `${sym} bu saat %${pctAbs} ${direction}. Son haberler arasında: "${headlines[0]}". ` +
    `Kesin sebep bu olmayabilir, ilgili haberi kontrol etmeni öneririz.`;

  if (!env.AI) return fallback;

  try {
    const prompt =
      `Bir hisse senedi ${sym} bu saat %${pctAbs} ${direction}. ` +
      `Son 24 saatteki başlıklar: ${headlines.map((h, i) => `${i + 1}) ${h}`).join(" | ")}. ` +
      `Bu başlıklardan hangisi bu fiyat hareketini açıklıyor olabilir, 2 cümlelik ` +
      `ihtiyatlı Türkçe özet yaz. Eğer hiçbir başlık ilgili görünmüyorsa bunu açıkça söyle, ` +
      `bağlantı uydurma. Kesin iddiada bulunma, "olabilir/muhtemelen" gibi ifadeler kullan.`;

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 140,
    });
    return result?.response?.trim() || fallback;
  } catch (err) {
    console.log(`[AI ERROR move-explain] ${err}`);
    return fallback;
  }
}

function defaultSettings() {
  return {
    criticalNewsFreqHours: 1,
    generalNewsFreqHours: 2,
    pollIntervalHours: 1,
    correlationEnabled: false,      // varsayılan kapalı, ayarlardan açılır
    moveExplanationEnabled: false,  // varsayılan kapalı, ayarlardan açılır
  };
}

function defaultConfig() {
  return {
    defaultTargetPe: 40,
    finnhubUrl: "https://finnhub.io/api/v1",
    settings: defaultSettings(),
    tickers: [
      { symbol: "MRVL",   isEtf: false, targetPe: 50, priceAbove: null, priceBelow: null, notify: { ...DEFAULT_NOTIFY } },
      { symbol: "MU",     isEtf: false, targetPe: 15, priceAbove: null, priceBelow: null, notify: { ...DEFAULT_NOTIFY } },
      { symbol: "SGLN.L", isEtf: true,                priceAbove: null, priceBelow: null, notify: { rating: false, fairValue: false, criticalNews: true, generalNews: false, priceAlert: false } },
      // TSM: korelasyon motoru için referans ticker (MRVL'in tedarik zinciri partneri)
      { symbol: "TSM",    isEtf: false, targetPe: 25, priceAbove: null, priceBelow: null, notify: { rating: false, fairValue: false, criticalNews: false, generalNews: false, priceAlert: false } },
    ],
  };
}
