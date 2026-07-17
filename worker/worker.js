/**
 * StockWatch Backend — Cloudflare Worker
 * -------------------------------------------------
 * Görevi:
 *  - Cron ile Finnhub'dan fiyat / analist rating / fiyat hedefi / haber çeker
 *  - Önceki değerle karşılaştırır (Workers KV'de saklanır)
 *  - Değişiklik varsa "bekleyen bildirim" olarak KV'ye yazar
 *  - Android uygulaması /pending endpoint'inden bunları çeker (polling)
 *
 * Ücretsiz katman: Cron Triggers + Workers KV yeterli.
 * Scraping YOK — resmi Finnhub API (ToS'a uygun).
 *
 * KV Namespace binding: STOCKWATCH_KV
 * Secret: FINNHUB_KEY  (wrangler secret put FINNHUB_KEY)
 * Secret: DEVICE_TOKEN (basit kimlik doğrulama için paylaşılan gizli anahtar)
 */

const FINNHUB = "https://finnhub.io/api/v1";

// Kritik haber olarak sayılacak anahtar kelimeler (şirketin kendi haberleri için)
const CRITICAL_KEYWORDS = [
  "earnings", "guidance", "acquisition", "acquire", "merger",
  "ceo", "cfo", "resign", "appoint", "downgrade", "upgrade",
  "lawsuit", "sec", "dividend", "buyback", "layoff", "restructur",
  "profit warning", "outlook", "forecast",
];

export default {
  // ---- HTTP: Android uygulaması buraya sorar ----
  async fetch(request, env) {
    const url = new URL(request.url);

    // Basit kimlik doğrulama
    const auth = request.headers.get("x-device-token");
    if (auth !== env.DEVICE_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/pending" && request.method === "GET") {
      return handlePending(env);
    }

    if (url.pathname === "/config" && request.method === "GET") {
      const cfg = await env.STOCKWATCH_KV.get("config", "json");
      return json(cfg || defaultConfig());
    }

    if (url.pathname === "/config" && request.method === "POST") {
      const body = await request.json();
      await env.STOCKWATCH_KV.put("config", JSON.stringify(body));
      return json({ ok: true, config: body });
    }

    // Manuel tetikleme (test için)
    if (url.pathname === "/scan" && request.method === "POST") {
      await runScan(env, "manual");
      return json({ ok: true });
    }

    // Anlık durum (uygulama ana ekranı için)
    if (url.pathname === "/snapshot" && request.method === "GET") {
      const snap = await env.STOCKWATCH_KV.get("snapshot", "json");
      return json(snap || {});
    }

    return json({ error: "not found" }, 404);
  },

  // ---- Cron: zamanlanmış tarama ----
  async scheduled(event, env, ctx) {
    // cron ifadesine göre hangi tür tarama olduğunu anlıyoruz
    // wrangler.toml'da 3 ayrı cron tanımlı
    ctx.waitUntil(runScan(env, event.cron));
  },
};

// --------------------------------------------------
// Bekleyen bildirimleri döndür ve temizle
// --------------------------------------------------
async function handlePending(env) {
  const pending = (await env.STOCKWATCH_KV.get("pending", "json")) || [];
  // Uygulama çektikten sonra kuyruğu temizliyoruz
  if (pending.length > 0) {
    await env.STOCKWATCH_KV.put("pending", JSON.stringify([]));
  }
  return json({ notifications: pending });
}

// --------------------------------------------------
// Ana tarama fonksiyonu
// --------------------------------------------------
async function runScan(env, cronTag) {
  const config = (await env.STOCKWATCH_KV.get("config", "json")) || defaultConfig();
  const key = env.FINNHUB_KEY;

  // Ayarlar (Settings ekranından değiştirilebilir)
  const settings = config.settings || defaultSettings();

  // Hangi cron çalıştı? (wrangler.toml ile eşleşir)
  //  "0 * * * *"      -> saatlik batch
  //  "0 */2 * * *"    -> 2 saatlik batch
  const isHourly = cronTag === "0 * * * *";
  const is2Hourly = cronTag === "0 */2 * * *";
  const isManual = cronTag === "manual";

  const doPriceRating = isHourly || isManual;

  // Genel haber sıklığı: kullanıcı 1 veya 2 saat seçebilir
  const doGeneralNews =
    isManual ||
    (settings.generalNewsFreqHours === 1 && isHourly) ||
    (settings.generalNewsFreqHours === 2 && is2Hourly);

  // Kritik haber sıklığı: kullanıcı 1 veya 2 saat seçebilir (varsayılan 1 saat)
  const doCriticalNews =
    isManual ||
    (settings.criticalNewsFreqHours === 1 && isHourly) ||
    (settings.criticalNewsFreqHours === 2 && (isHourly || is2Hourly));

  const newNotifications = [];
  const snapshot = (await env.STOCKWATCH_KV.get("snapshot", "json")) || {};

  for (const t of config.tickers) {
    const sym = t.symbol;
    snapshot[sym] = snapshot[sym] || {};

    try {
      // ---- FİYAT (rating kapalı olsa bile çekilir) ----
      if (doPriceRating) {
        const quote = await fetchJson(`${FINNHUB}/quote?symbol=${sym}&token=${key}`);
        if (quote && typeof quote.c === "number") {
          snapshot[sym].price = quote.c;
          snapshot[sym].priceTime = Date.now();

          // Fiyat eşiği bildirimi (kullanıcı Settings'ten sınır koyduysa)
          if (t.notify.priceAlert === true) {
            const above = t.priceAbove;
            const below = t.priceBelow;
            const lastFlag = await kvGet(env, `pricealert:${sym}`);
            if (typeof above === "number" && quote.c >= above && lastFlag !== "above") {
              newNotifications.push(mkNote(
                sym, "priceAlert", `${sym}: Fiyat üst sınırı geçti`,
                `$${round2(quote.c)} ≥ $${above}`
              ));
              await kvPut(env, `pricealert:${sym}`, "above");
            } else if (typeof below === "number" && quote.c <= below && lastFlag !== "below") {
              newNotifications.push(mkNote(
                sym, "priceAlert", `${sym}: Fiyat alt sınırın altında`,
                `$${round2(quote.c)} ≤ $${below}`
              ));
              await kvPut(env, `pricealert:${sym}`, "below");
            } else if (
              (typeof above !== "number" || quote.c < above) &&
              (typeof below !== "number" || quote.c > below)
            ) {
              // Bandın içine döndü -> tekrar tetiklenebilir
              await kvPut(env, `pricealert:${sym}`, "in");
            }
          }
        }

        // ---- RATING + FAIR VALUE ----
        if (t.notify.rating !== false || t.notify.fairValue !== false) {

        // ETF/ETC (ör. SGLN) için rating/hedef gelmez, atla
        if (!t.isEtf) {
          // Analist rating
          const recs = await fetchJson(
            `${FINNHUB}/stock/recommendation?symbol=${sym}&token=${key}`
          );
          if (Array.isArray(recs) && recs.length > 0) {
            const latest = recs[0];
            const rating = deriveRating(latest); // Buy / Hold / Sell
            const prev = await kvGet(env, `rating:${sym}`);
            snapshot[sym].rating = rating;
            snapshot[sym].ratingDetail = latest;
            if (prev && prev !== rating && t.notify.rating !== false) {
              newNotifications.push(mkNote(
                sym,
                "rating",
                `${sym}: Rating değişti`,
                `${prev} → ${rating}`
              ));
            }
            await kvPut(env, `rating:${sym}`, rating);
          }

          // Fiyat hedefi (fair value proxy #1) + kendi P/E modeli (#2)
          if (t.notify.fairValue !== false) {
            const pt = await fetchJson(
              `${FINNHUB}/stock/price-target?symbol=${sym}&token=${key}`
            );
            let analystFV = null;
            if (pt && typeof pt.targetMean === "number" && pt.targetMean > 0) {
              analystFV = round2(pt.targetMean);
            }

            // Kendi basit P/E modeli: EPS * hedef P/E
            // metric endpoint'inden TTM EPS alıyoruz
            const metric = await fetchJson(
              `${FINNHUB}/stock/metric?symbol=${sym}&metric=all&token=${key}`
            );
            let peFV = null;
            const eps = metric?.metric?.epsTTM ?? metric?.metric?.epsInclExtraItemsTTM;
            const targetPe = t.targetPe ?? config.defaultTargetPe ?? 40;
            if (typeof eps === "number" && eps > 0) {
              peFV = round2(eps * targetPe);
            }

            const combined = { analystFV, peFV, targetPe };
            const prev = await kvGet(env, `fv:${sym}`, true);
            snapshot[sym].fairValue = combined;

            // Aynı gün içinde değişim kontrolü
            if (prev && fvChanged(prev, combined)) {
              newNotifications.push(mkNote(
                sym,
                "fairValue",
                `${sym}: Fair value güncellendi`,
                fvSummary(prev, combined)
              ));
            }
            await kvPut(env, `fv:${sym}`, JSON.stringify(combined));
          }
        }
        } // rating/fairValue bloğu sonu
      } // doPriceRating bloğu sonu

      // ---- HABERLER ----
      if ((doGeneralNews || doCriticalNews)) {
        const today = new Date();
        const from = new Date(today.getTime() - 2 * 24 * 3600 * 1000);
        const news = await fetchJson(
          `${FINNHUB}/company-news?symbol=${sym}` +
          `&from=${fmtDate(from)}&to=${fmtDate(today)}&token=${key}`
        );
        if (Array.isArray(news)) {
          const seen = (await kvGet(env, `newsseen:${sym}`, true)) || [];
          const seenSet = new Set(seen);
          const freshSeen = [];

          for (const n of news.slice(0, 30)) {
            const id = String(n.id);
            freshSeen.push(id);
            if (seenSet.has(id)) continue;

            const headline = (n.headline || "").toLowerCase();
            const isCritical = CRITICAL_KEYWORDS.some((kw) =>
              headline.includes(kw)
            );

            // Kritik haber -> her zaman bildir (eğer açıksa)
            // Genel haber -> sadece 2 saatlik batch'te ve kullanıcı istiyorsa
            if (isCritical && doCriticalNews && t.notify.criticalNews !== false) {
              newNotifications.push(mkNote(
                sym,
                "criticalNews",
                `⚠️ ${sym}: Kritik haber`,
                n.headline,
                n.url
              ));
            } else if (!isCritical && doGeneralNews && t.notify.generalNews === true) {
              newNotifications.push(mkNote(
                sym,
                "news",
                `${sym}: Haber`,
                n.headline,
                n.url
              ));
            }
          }
          // Son 60 haberi "görüldü" olarak sakla (KV şişmesin)
          await kvPut(env, `newsseen:${sym}`, JSON.stringify(freshSeen.slice(0, 60)));
        }
      }
    } catch (err) {
      // Bir ticker hata verirse diğerleri devam etsin
      console.log(`scan error ${sym}: ${err}`);
    }
  }

  // Snapshot'ı güncelle
  snapshot._updated = Date.now();
  await env.STOCKWATCH_KV.put("snapshot", JSON.stringify(snapshot));

  // Yeni bildirimleri kuyruğa ekle
  if (newNotifications.length > 0) {
    const pending = (await env.STOCKWATCH_KV.get("pending", "json")) || [];
    const merged = [...pending, ...newNotifications].slice(-100); // en fazla 100
    await env.STOCKWATCH_KV.put("pending", JSON.stringify(merged));
  }
}

// --------------------------------------------------
// Yardımcılar
// --------------------------------------------------
function deriveRating(rec) {
  // Finnhub recommendation: {buy, hold, sell, strongBuy, strongSell, period}
  const buy = (rec.strongBuy || 0) + (rec.buy || 0);
  const hold = rec.hold || 0;
  const sell = (rec.sell || 0) + (rec.strongSell || 0);
  if (buy >= hold && buy >= sell) return "Buy";
  if (sell > buy && sell > hold) return "Sell";
  return "Hold";
}

function fvChanged(prev, cur) {
  const p = JSON.parse(prev);
  return (
    p.analystFV !== cur.analystFV ||
    p.peFV !== cur.peFV
  );
}

function fvSummary(prevRaw, cur) {
  const p = JSON.parse(prevRaw);
  const parts = [];
  if (p.analystFV !== cur.analystFV) {
    parts.push(`Analist: $${p.analystFV} → $${cur.analystFV}`);
  }
  if (p.peFV !== cur.peFV) {
    parts.push(`P/E model: $${p.peFV} → $${cur.peFV}`);
  }
  return parts.join(" | ") || "Güncellendi";
}

function mkNote(symbol, type, title, body, url) {
  return {
    id: crypto.randomUUID(),
    symbol,
    type,
    title,
    body,
    url: url || null,
    ts: Date.now(),
  };
}

async function fetchJson(url) {
  const r = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function kvGet(env, k, raw) {
  return raw ? env.STOCKWATCH_KV.get(k) : env.STOCKWATCH_KV.get(k);
}
async function kvPut(env, k, v) {
  return env.STOCKWATCH_KV.put(k, v);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

function defaultSettings() {
  return {
    criticalNewsFreqHours: 1,   // 1 veya 2
    generalNewsFreqHours: 2,    // 1 veya 2
    pollIntervalHours: 1,       // telefon kaç saatte bir kontrol etsin (bilgi amaçlı)
  };
}

function defaultConfig() {
  return {
    defaultTargetPe: 40,
    settings: defaultSettings(),
    tickers: [
      {
        symbol: "MRVL",
        isEtf: false,
        targetPe: 50,
        priceAbove: null,
        priceBelow: null,
        notify: { rating: true, fairValue: true, criticalNews: true, generalNews: false, priceAlert: false },
      },
      {
        symbol: "MU",
        isEtf: false,
        targetPe: 15,
        priceAbove: null,
        priceBelow: null,
        notify: { rating: true, fairValue: true, criticalNews: true, generalNews: false, priceAlert: false },
      },
      {
        symbol: "SGLN.L",
        isEtf: true,
        priceAbove: null,
        priceBelow: null,
        notify: { rating: false, fairValue: false, criticalNews: true, generalNews: false, priceAlert: false },
      },
    ],
  };
}
