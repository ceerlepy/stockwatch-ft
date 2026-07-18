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

        const metric = await getSoft(FINNHUB, `/stock/metric?symbol=${sym}&metric=all&token=${key}`);
        if (metric && metric !== "PREMIUM") {
          const eps = metric?.metric?.epsTTM ?? metric?.metric?.epsInclExtraItemsTTM;
          const pe  = t.targetPe ?? config.defaultTargetPe ?? 40;
          if (typeof eps === "number" && eps > 0) peFV = round2(eps * pe);
        }

        const fv   = { analystFV, peFV, targetPe: t.targetPe, note: fvNote };
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
async function validateSymbol(finnhub, key, sym) {
  try {
    const r = await fetch(`${finnhub}/quote?symbol=${sym}&token=${key}`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return false;
    const d = await r.json();
    return d && typeof d.c === "number" && d.c > 0;
  } catch { return false; }
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
  return { id: crypto.randomUUID(), symbol, type, title, body, url: url || null, ts: Date.now() };
}

function resp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json" },
  });
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }
function round2(n)  { return Math.round(n * 100) / 100; }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

function defaultSettings() {
  return { criticalNewsFreqHours: 1, generalNewsFreqHours: 2, pollIntervalHours: 1 };
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
    ],
  };
}
