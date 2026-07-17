# 📱 Telefondan Kurulum Kılavuzu (bilgisayar YOK)

Bu kılavuz her şeyi **sadece telefonla** yapman için. İki büyük adım var:
1. **Worker'ı Cloudflare'e yükle** (backend)
2. **APK'yı GitHub'da derlet** (uygulama) → telefona kur

---

## BÖLÜM 1 — Cloudflare Worker (backend)

### 1.1 Finnhub anahtarı al
- Telefon tarayıcısında **finnhub.io** → ücretsiz kaydol → **API key**'i kopyala/not al

### 1.2 Worker oluştur
- **dash.cloudflare.com** → giriş yap (yoksa ücretsiz hesap aç)
- Sol menü → **Workers & Pages** → **Create** → **Create Worker**
- İsim: **stockwatch** → **Deploy** (boş şablonla oluşur)
- **Edit code** → şablonun tamamını sil → `worker/worker.js` içeriğini yapıştır → **Deploy**

### 1.3 KV (veritabanı) ekle
- **Workers & Pages** → sağ üst sekmelerden **KV** → **Create a namespace**
- İsim: **STOCKWATCH_KV** → oluştur
- **stockwatch** Worker'ına geri dön → **Settings** → **Bindings** (veya Variables) →
  **Add binding** → **KV namespace**
  - Variable name: `STOCKWATCH_KV`
  - Namespace: az önce açtığın **STOCKWATCH_KV**
  - Kaydet

### 1.4 Secret'ları ekle
Aynı **Settings** ekranında **Variables and Secrets** (Encrypt ederek):
- `FINNHUB_KEY` = Finnhub anahtarın
- `DEVICE_TOKEN` = kendin uydur, uzun rastgele bir yazı (ör. `vt-mrvl-9f3kQ7xP2z`)
  → **bunu bir yere not et, birazdan Android'de aynısını gireceksin**

### 1.5 Cron (otomatik tarama) ekle
- **Settings** → **Triggers** → **Cron Triggers** → **Add**
- Şu ikisini ekle:
  - `0 * * * *`   (saat başı)
  - `0 */2 * * *` (2 saatte bir)

### 1.6 URL'ini not et
Worker'ın adresi şu şekildedir:
`https://stockwatch.<senin-kullanıcı-adın>.workers.dev`
(Worker sayfasının üstünde yazar. Bunu not et.)

### 1.7 İlk veriyi çek (test)
Tarayıcıda şu adrese git (kendi URL'inle):
`https://stockwatch.<...>.workers.dev/scan` → çalışmazsa sorun değil, cron zaten
saat başı çalışacak. (Not: /scan POST ister; tarayıcıdan açılmayabilir, cron'u bekle.)

---

## BÖLÜM 2 — APK'yı GitHub'da derlet (bilgisayar yok)

### 2.1 GitHub hesabı + repo
- Telefon tarayıcısında **github.com** → ücretsiz kaydol/giriş yap
- Sağ üst **+** → **New repository**
- İsim: **stockwatch** → **Private** seç → **Create repository**

### 2.2 Kodu yükle
GitHub web arayüzünden dosya yüklemek telefonda zahmetli olabilir. En kolay yol:
- Repo sayfasında **Add file** → **Upload files**
- Bu zip'in içindeki **tüm klasörleri** (`.github`, `android`, `worker`, dosyalar)
  yükle. **Önemli:** klasör yapısını koru — `.github/workflows/build.yml` ve
  `android/...` aynı hiyerarşide kalmalı.
- Alternatif (daha kolay): **GitHub mobil uygulaması** yerine tarayıcıda "Desktop
  site" moduna geç, sürükle-bırak daha rahat olur.
- Yükleyince **Commit changes**

> İpucu: Zip'i telefonda açıp dosyaları tek tek yüklemek yerine, istersen bir
> dosya yöneticisiyle klasörleri koruyarak yükle. Klasör yapısı bozulursa
> Actions çalışmaz.

### 2.3 ÖNEMLİ: Android ayarlarını gir
APK derlenmeden ÖNCE `android/app/src/main/java/com/stockwatch/app/Data.kt`
dosyasını düzenle (GitHub'da dosyaya tıkla → kalem ✏️ ikonu):
```kotlin
const val BASE_URL = "https://stockwatch.<SENIN-SUBDOMAIN>.workers.dev"
const val DEVICE_TOKEN = "vt-mrvl-9f3kQ7xP2z"   // 1.4'te not ettiğin AYNI değer
```
→ **Commit changes**

### 2.4 APK derlensin
- Kodu yükleyince (veya Data.kt'yi commit'leyince) **Actions** sekmesine git
- **Build APK** workflow'u otomatik çalışmaya başlar (sarı nokta → yeşil tik)
- İlk sefer 3-5 dakika sürer
- Çalışmazsa: **Actions** → **Build APK** → sağdaki **Run workflow** ile elle tetikle

### 2.5 APK'yı indir
- Actions → tamamlanan (yeşil ✓) çalışmaya tıkla
- En altta **Artifacts** → **StockWatch-APK** → indir (zip iner)
- Zip'i aç → içinden **app-debug.apk** çıkar

### 2.6 Telefona kur
- **app-debug.apk**'ye dokun → "bilinmeyen kaynaklardan kuruluma izin ver" çıkarsa
  izin ver → **Kur**
- Aç → bildirim iznini ver
- İlk açılışta hisseler görünür (MRVL, MU, SGLN). Worker cron saat başı taradıkça
  fiyat/rating/fair value dolar.

---

## Alternatif/Yedek: Codemagic (isteğe bağlı)
`codemagic.yaml` de repoda hazır. GitHub Actions bir gün kırılır veya dakika
limitine takılırsan yedek olarak kullanabilirsin:
- **codemagic.io** → GitHub ile giriş → bu repoyu bağla → `codemagic.yaml` otomatik algılanır
- Görsel UI'dan tek tıkla build (telefonda YAML'dan biraz daha kolay)
- Ücretsiz: 500 dk/ay (Android build ~3-5 dk)
- **Bonus:** Codemagic APK'yı derleyince **vt@gmail.com** adresine otomatik
  e-posta ile gönderecek şekilde ayarlı (yaml içinde). Yani APK'yı indirmek yerine
  doğrudan mailine düşer.

> Not: Hata tespiti açısından ikisi aynıdır — ikisi de aynı Gradle derlemesini
> çalıştırır, aynı hatayı gösterir. Codemagic'in değeri "ikinci güvenli liman"
> ve telefonda kolay görsel arayüz olması.


- Cloudflare Worker saat başı tarar, değişiklik olursa "bekleyen bildirim" oluşturur
- Telefondaki uygulama (WorkManager) saatte bir Worker'a sorar, yeni varsa
  **gerçek Android bildirimi** gösterir — uygulama kapalıyken bile
- Ayarlardan (⚙) sıklıkları değiştirebilirsin

## Sorun çözme
- **Uygulama boş/veri yok** → Data.kt'deki URL ve DEVICE_TOKEN doğru mu? Worker ile
  birebir aynı mı? Cron en az bir kez çalıştı mı (saat başını bekle)?
- **Actions kırmızı (hata)** → hatayı Actions logunda gör; genelde klasör yapısı
  bozulmuştur (android/ altındaki dosyalar yanlış yere gitmiştir)
- **SGLN fiyatı gelmiyor** → Finnhub ücretsiz katmanı Londra sembolünü desteklemiyor
  olabilir; MRVL/MU çalışıyorsa sorun sadece SGLN'dedir, sonra alternatif kaynak
  ekleriz
