# StockWatch — Local Hisse Takip & Bildirim

> **Önemli — teslim durumu:** Kod tamamdır ve statik kontrolden geçmiştir
> (Worker JS syntax OK, Kotlin yapısı tutarlı). Ancak bu ortamda internet
> kapalı olduğu için **canlı test edilemedi** ve **deploy yapılamadı**. Worker
> deploy'u senin Cloudflare hesabından, APK derlemesi senin Android
> Studio'ndan yapılır. Aşağıdaki adımlar bunun içindir.

## APK nasıl üretilir (local, Play Store yok)
1. `android/` klasörünü Android Studio'da **Open** ile aç (root gradle
   dosyaları hazır: settings.gradle.kts, build.gradle.kts, gradle.properties)
2. Gradle sync bitince: **Build > Build Bundle(s)/APK(s) > Build APK(s)**
3. Çıkan `app-debug.apk`'yı telefonuna kur (USB veya dosya transferi;
   "bilinmeyen kaynaklar"a izin ver)
4. Veya telefonu USB ile bağlayıp doğrudan **Run** — en kolayı bu


MRVL, MU, SGLN (ve eklediğin diğer semboller) için:
- Analist **rating** değişiminde (Buy/Hold/Sell) bildirim
- **Fair value** aynı gün içinde değişirse bildirim (2 kaynak: analist hedefi + kendi P/E modelin)
- Şirketin **kritik haberi** çıkınca bildirim
- İstersen genel haber bildirimi de açılabilir
- Her ticker için ayrı ayrı **customize** edilebilir, istediğin kadar yeni sembol eklenebilir

**Firebase YOK. Play Store YOK. Tamamen local + ücretsiz Cloudflare Worker.**

---

## Mimari (kısa)

```
Cloudflare Worker (cron)  ──►  Finnhub API (resmi, güvenilir)
        │  saat başı: fiyat + rating + fair value
        │  2 saatte bir: genel haber
        │  30 dk: kritik haber
        ▼
   Workers KV  (son değerleri saklar, değişimi tespit eder,
                "bekleyen bildirim" kuyruğu tutar)
        ▲
        │  telefon saatte bir "yeni var mı?" diye sorar (HTTPS)
        ▼
 Android app (WorkManager)  ──►  yerel bildirim gösterir
```

Pil derdi yok: telefon sadece saatte bir tek HTTPS isteği atıyor. Ağır iş
Cloudflare'de dönüyor.

---

## Kurulum

### 1) Finnhub API anahtarı (ücretsiz)
- https://finnhub.io → ücretsiz hesap → API key kopyala

### 2) Cloudflare Worker
```bash
cd worker
npm install -g wrangler
wrangler login

# KV oluştur, çıkan id'yi wrangler.toml içine yapıştır
wrangler kv namespace create STOCKWATCH_KV

# Secret'ları ekle
wrangler secret put FINNHUB_KEY      # Finnhub anahtarın
wrangler secret put DEVICE_TOKEN     # kendin belirle, uzun rastgele bir string

wrangler deploy
```
Deploy sonrası URL çıkar: `https://stockwatch.<subdomain>.workers.dev`

İlk config'i yüklemek için (varsayılan MRVL/MU/SGLN gelir):
```bash
curl -X POST https://stockwatch.<subdomain>.workers.dev/scan \
  -H "x-device-token: <DEVICE_TOKEN>"
```

### 3) Android
- `android/` klasörünü Android Studio'da aç
- `Data.kt` içinde:
  - `Backend.BASE_URL` = kendi Worker URL'in
  - `Backend.DEVICE_TOKEN` = yukarıda koyduğun DEVICE_TOKEN
- Telefonu USB ile bağla → Run
- Bildirim iznini ver

Uygulama açılınca saatlik polling otomatik başlar (WorkManager).

---

## Yeni hisse eklemek
Uygulamada sağ alttaki **"Hisse Ekle"** → sembolü gir (ör. `AVGO`, `NVDA`).
Londra ETC/ETF için `.L` ekle (ör. `SGLN.L`). "ETF/ETC" kutusunu işaretlersen
sadece fiyat + haber takibi yapılır (rating/fair value ETF'lerde yoktur).

Her kartın **"Bildirimler"** butonundan o hisse için hangi bildirimleri
istediğini ayrı ayrı ayarlayabilirsin.

---

## Fair value nasıl hesaplanıyor?
İki değer birden gösterilir:
1. **Analist hedefi** — Finnhub `price-target` (targetMean), Wall Street konsensüsü
2. **Kendi P/E modelin** — `EPS(TTM) × senin girdiğin hedef P/E`
   (MRVL için varsayılan 50x, MU için 15x; değiştirilebilir)

İkisinden biri gün içinde değişirse bildirim gelir.

> Not: Bunlar tahmindir, yatırım tavsiyesi değildir. Kaynak Finnhub (resmi API).

---

## Ayarlar ekranı (⚙)
Uygulamada üst bardaki **⚙** ikonundan:
- **Kritik haber sıklığı:** 1 saat (varsayılan) veya 2 saat
- **Genel haber sıklığı:** 1 saat veya 2 saat (varsayılan)
- **Telefon kontrol sıklığı:** 1 veya 2 saat (2 saat = biraz daha az pil)

Her **hisse kartındaki "Ayarlar"** butonundan ise o hisseye özel:
- Hangi bildirimleri istediğin (rating / fair value / kritik haber / genel haber / fiyat alarmı)
- **Fiyat alarmı:** üst ve alt $ sınırı gir → fiyat o bandı aşınca/altına düşünce bildirim
- **Hedef P/E:** kendi fair value modelinin çarpanı (MRVL 50, MU 15 vb.)

Bu ayarların hepsi Cloudflare config'ine (KV) yazılır; `wrangler.toml`'a hiç
dokunmadan telefondan yönetilir.

## Veri kaynağı — neden Finnhub?
Uygulamanın 3 şeye ihtiyacı var: fiyat + **analist rating** + **haber**.
Sadece Finnhub bu üçünü tek API'de veriyor:
- Alpaca: ücretsiz katmanı en cömerti ama **rating/fair value yok** (sadece fiyat/trade)
- Twelve Data: global kapsama iyi (SGLN için Finnhub'dan iyi olabilir) ama
  rating tarafı zayıf
- **Finnhub:** fiyat + `recommendation` (rating) + `price-target` (fair value) +
  `company-news` → senin kullanım senaryonun tam karşılığı

Notlar:
- Ücretsiz katman ~60 çağrı/dk (3-4 hisse için fazlasıyla yeterli)
- Fiyat ücretsiz katmanda ~20 dk gecikmeli olabilir (saat başı tarama için sorun değil)
- SGLN (`SGLN.L`) için veri gelmezse → SGLN'i Twelve Data'dan çekecek ikinci bir
  kaynak eklenebilir (worker.js'de fetchJson'ı o sembol için değiştirmek yeterli)

## Zamanlama özeti
| Ne | Sıklık | Ayarlanabilir? |
|----|--------|----------------|
| Fiyat + rating + fair value + fiyat alarmı | saat başı | Hayır (sabit) |
| Kritik haber | 1 veya 2 saat | ✅ Settings (⚙) |
| Genel haber | 1 veya 2 saat | ✅ Settings (⚙) |
| Telefon "yeni var mı?" | 1 veya 2 saat | ✅ Settings (⚙) |
