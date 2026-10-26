# Bubble Ar-Ge — Veri sözlüğü ve arşiv

## Nerede duruyor

- **Ham kayıt:** Supabase `public.bubble_olcum`. Her satır bir rapordur (`report` jsonb). Tabloya yalnız ekleme yapılabilir; dışarıdan okunamaz.
- **Özet görünüm:** `public.bubble_olcum_ozet`. Her satır kategorilere ayrılmış ve öne çıkan sayılarla birlikte gelir. Yalnız Supabase panelinden okunur (`security_invoker`; anon ve authenticated için kapalı).
- **Arşiv:** Vault'taki `Projects/BeRelax/Ar-Ge/` klasörü. Her test turu için bir rapor (`tur-YYYY-MM-DD.md`) tutulur: o turun cihaz tablosu, bulgular ve verilen kararlar.

## Bir izleme = iki satır

| `stage` | Ne zaman yazılır | İçerik |
|---|---|---|
| `gosteri` | Gösteri bitince | Cihaz bilgisi, kapasite ölçümü (`bench`), sahne sahne kare süreleri (`results`), dokunma denemeleri |
| `deneyim` | "Sıra sende" bölümü bitince | Adım adım hareket verileri (`steps`), serbest bölüm (`free`) |

İki satır aynı `run` kimliğini taşır. Kişi ikinci bölümü yarıda bırakırsa yalnızca `gosteri` satırı yazılır.

Ar-Ge araç sayfaları (sürüm 6) kendi bölümleriyle yazar:

| `stage` | Sayfa | İçerik |
|---|---|---|
| `karsilastirma` | berelax.space/bubble-karsilastir | Aynı baloncuğun üç hâli (bugünkü, doku kapalı, doğumda çizilen doku) için kare maliyeti; `results[].name` hâl + çözünürlük, `bakedOctaves` |
| `galeri` | berelax.space/bubble-galeri | 40 sabit baloncuk; `results[]`: `seed`, `mark` (guzel / kargasik / null), `alpha` (genlik spektrumu eğimi), `grain` (en ince oktavın enerji payı, %), `colour` (renklilik), `ms` (1x kare maliyeti), `character` |

## Sürümler

| `version` | Değişen |
|---|---|
| 1 (yok) | İlk ölçüm: 30 sn'lik otomatik oynatma, kapasite ölçümü yok |
| 2 | Kapasite ölçümü (`bench`) eklendi |
| 3 | Tören: şekiller, köşeye yakınlaşma, patlama ve doğum |
| 4 | Varyant geçidi, dokunma kilidi, sıra sende bölümü |
| 5 | Ölçüm törenden önce yapılıyor, başlangıç çözünürlüğü buna göre seçiliyor (`startScale`, `refreshMs`). Kapasiteye `0.5x` ve `akış adımı` eklendi. Rapora `build` ve `touchPoints` eklendi. Baloncuklar her izlemede rastgele (`seeds`) |
| 6 | `client` (cihaz ve tarayıcı: Safari / Chrome …). Ekran hızı gerçek ekran hızına yuvarlanır (120/90/60/30 Hz; sürüm 5'te yavaş telefonlar 37 Hz görünüyordu). Dokunma payı 12 px; adımlar önceki hareketi saymaz; "yaklaş" adımı o anki yakınlıktan +0.8 ister. Patlama shader'ı açılışta derlenir; kalite ayarlayıcı 1.1 × kare süresinde düşer |

Sürümler arasındaki sahne sayıları birbirinin yerine kullanılmaz. Karşılaştırma yalnızca aynı sürüm içinde yapılır.

## Alanlar

| Alan | Anlamı |
|---|---|
| `build` | Raporu üreten derleme: commit, `+` (çalışma kopyası commit'ten farklıysa) ve tarih |
| `client` | `{ device, browser }`: iPhone / iPad / Mac … ve Safari / Chrome … (sürüm 6). Safari ve Chrome eşit önemde; iPhone/iPad'de ikisi de WebKit, Mac'te Chrome farklı motor |
| `device`, `touchPoints` | Tarayıcının kendini tanıtma satırı ve dokunmatik nokta sayısı. iPad'ler kendini Mac gibi tanıtır; `touchPoints > 1` iPad olduğunu gösterir |
| `gpu` | Ekran kartının adı. Safari bunu gizler, yalnızca "Apple GPU" yazar |
| `screen`, `dpr`, `native` | Ekran boyutu (CSS px), piksel yoğunluğu, ekranın tam çözünürlüğü (en çok 3) |
| `hz`, `refreshMs` | Ekranın yenileme hızı ve bir karenin süresi. 30 Hz çoğunlukla iOS düşük güç modu ya da ısınma demektir |
| `startScale` | Ölçüme göre törenin başladığı çözünürlük |
| `seeds` | Gösterilen baloncuklar: ana baloncuk, 8 varyant, yeni doğan |
| `bench[]` | Bir karenin süresi (ms) |
| `results[]` | Sahne başına: `fps`, `p95`, `max` (en uzun kare), `scale` (kalite ayarlayıcının seçtiği çözünürlük), `frames`, `valid` |
| `touched`, `touchAttempts` | Gösteri sırasında ekrana dokunuldu mu, kaç kez denendi |
| `steps[]` | Adım başına: `done`, `ms`, `downs` (basma sayısı), `other` (beklenen dışı hareket), `draw` / `turn` (uzunluk ve hız, baloncuk yarıçapı cinsinden), `maxZoom`, kare istatistikleri |
| `free` | Serbest bölümde ilk hareket (`first`) ve hareket sayıları |
| `valid` | Ekran arka plana geçmediyse doğru |

`bench` içindeki ölçümler:
- **Çözünürlük:** `1x`, `1.5x`, `2x`, tam çözünürlük.
- **Sabit maliyet:** `0.5x` ve `akış adımı`. 1x ile 0.5x neredeyse aynıysa yük piksellerden gelmiyor; çözünürlüğü düşürmek o cihazı kurtarmaz.
- **Doku ayarları:** lifler kapalı; katman sınırı 8, 5 ve 3.
- **Yakın bakış:** 3.6x yakınlaşmada bir kare.

## Kategoriler (özet görünümde)

| Kolon | Değerler |
|---|---|
| `cihaz_sinifi` | iPhone, iPad, iPad (tahmin), Android telefon, Android tablet, Mac, Windows, diğer |
| `yenileme` | 30 / 60 / 90 / 120 Hz |
| `bolum` | gosteri / deneyim |
| `surum` | 1–5 |
| `gecerli`, `dokunuldu`, `deneme_satiri` | Temizlik bayrakları |

## Temizlik kuralları

- `deneme_satiri` (id 1–3 ve deneme kayıtları) analize girmez.
- `gecerli = false` analize girmez.
- `dokunuldu = true` olan satırlar ayrıca işaretlenir; sürüm 4 ve sonrasında dokunuşlar engellendiği için sonuçları bozmaz.
- 30 Hz satırlar ayrı değerlendirilir: cihazın gücünü değil, düşük güç modunu gösterir.
- Bu Mac'in satırları (`gpu` içinde M5 Pro) geliştirme ölçümüdür; cihaz tablosunda ayrı tutulur.

## Arşiv ve değerlendirme döngüsü

1. Test turu biter.
2. Özet görünümden cihaz tablosu çıkarılır. Satırlar cihaz sınıfı ve yenileme hızına göre gruplanır, her grup için kapasite ve sahne ortalamaları alınır.
3. Vault'a `Ar-Ge/tur-YYYY-MM-DD.md` yazılır. İçinde şunlar yer alır: tablo, bulgular, her bulgunun hangi satırlara dayandığı (id), verilen kararlar.
4. Kararlar `DECISIONS.md` dosyasına, yapılacak işler `HANDOFF.md` dosyasına geçer.
5. Ham verinin tam yedeği gerektiğinde Supabase'den CSV olarak alınır: Table Editor → `bubble_olcum` → Export.
