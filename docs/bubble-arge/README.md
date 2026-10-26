# Bubble Ar-Ge

Baloncuğa eklenen her özellik önce burada denenir, ölçülür ve değerlendirilir.

## Link

https://www.berelax.space/meetbubble (tören varsayılan; eski adres `/bubble-arge/` buraya yönlenir)

Araç sayfaları (sürüm 6):
- https://www.berelax.space/bubble-karsilastir — aynı baloncuk üç hâliyle yan yana, tek saatle; "ölç" her hâlin kare maliyetini yazar.
- https://www.berelax.space/bubble-galeri — 40 sabit baloncuk; Lu "güzel / kargaşık" işaretler (ölçüler gönderilene kadar gizli).
- Yeniden derleme: `node scripts/build-bubble-compare.mjs`.

Hedef cihazlar: iPhone, iPad, Mac; Safari ve Chrome eşit önemde (DECISIONS 2026-10-26).

- `olcum=1`: tören (izleyici dokunmaz, sadece izler) ve ölçüm. Bu parametre yoksa sayfa normal lab olarak açılır.
- Parametresiz açılınca her izlemede yeni, rastgele baloncuklar gösterilir. Hangileri gösterildiyse rapora yazılır (`seeds`).
- `seed=…` verilirse ana baloncuk o olur.
- `olcum=0` sayfayı normal lab olarak açar. `sira=1` doğrudan ikinci bölüme geçer (test için).
- Alan sözlüğü, kategoriler ve arşiv: [VERI.md](VERI.md).

## Döngü

1. **Ekle.** Yeni özellik törene bir sahne olarak girer: `src/bubble/zoom-lab/measurementShow.js`. Her sahnenin `id`'si ölçümdeki bölüm adıdır. Sahneler değişince rapordaki `version` artırılır.
2. **Yayınla.** `node scripts/build-bubble-arge.mjs` sayfayı `public/meetbubble/` içine derler. Ardından commit atılır ve main'e push edilir; Vercel yayınlar. Link değişmez.
3. **İzlet.** Link test edecek kişilere gönderilir. Kurulum ya da ayar gerekmez.
4. **Topla.** Her izleme Supabase'deki `public.bubble_olcum` tablosuna tek satır olarak yazılır (`api/olcum.js`). Tabloya yalnızca ekleme yapılabilir; okumak için Supabase SQL editörü kullanılır.
5. **Değerlendir.** Sonuçlar cihaz cihaz tabloya dökülür ve aşağıdaki sorular yanıtlanır.
   - `valid = false` olan satırlar hesaba katılmaz.
   - `touched = true` olan satırlar ayrıca işaretlenir.
   - İlk deneme satırları (id 1–3) hesaba katılmaz.
6. **Karar ver.** Varılan karar Vault'taki `BeRelax/DECISIONS.md` dosyasına yazılır. Bir sonraki özellik bu kararla geliştirilir.

## Rapor

| Alan | Anlamı |
|---|---|
| `gpu`, `device`, `screen`, `dpr`, `native` | Cihaz, ekran ve ekranın tam çözünürlüğü |
| `hz` | Ekranın yenileme hızı |
| `loadMs` | Sayfanın hazırlanma süresi |
| `results[]` | Her sahne: fps, p95, en uzun kare, o sahnede kalite ayarlayıcının seçtiği çözünürlük (`scale`), kare sayısı, geçerlilik |
| `bench[]` | Bir karenin ms maliyeti: 1x / 1.5x / 2x / tam çözünürlükte; lif kapalı; katman sınırı 8 / 5 / 3; yakın bakış 3.6x |
| `touched`, `valid` | İzleyici ekrana dokundu mu; ekran arka plana geçti mi |

FPS ekranın yenileme hızında tavan yapar. Cihazın ne kadar payı olduğunu `bench` gösterir.

## Değerlendirme soruları

1. Bu cihaz hangi baloncuk seviyelerini akıcı çalıştırır? (`bench`)
2. Hangi çözünürlükte kalmalı? (`bench` ölçeklerine karşılık yenileme payı: 60 Hz için 16.7 ms, 120 Hz için 8.3 ms)
3. Hafif seviyeler için hangi ayar ne kadar kazandırıyor? (lif ve katman satırları)
4. Deneyim takılıyor mu, nerede? (`results`: en uzun kare, p95, `scale` düşüşleri)
5. Açılışta cihaz nasıl tanınır? (`gpu` adı ile `bench` arasındaki ilişki)

## Tören (sırasıyla)

| Sahne | Yazı | Ne olur |
|---|---|---|
| (kapasite) | Bir an. / Cihazına bakıyoruz. | Baloncuk görünmeden, karanlıkta kare maliyeti ölçülür. Tören, ekranın yenileme hızına sığan en yüksek çözünürlükle başlar |
| merhaba | Bu bir baloncuk. / Nefes alıyor. | Karanlıktan belirir |
| dokunus | Dokun. | Dört dokunuş, dalgacıklar |
| cizim-daire, -ucgen, -kalp, -sonsuz, -yildiz | Basılı tut, çiz. | Zarın üzerine parmakla şekiller çizilir |
| cevir | Kaydır, çevir. | Kavisli bir savuruş; bırakınca kendi kendine yavaşlar |
| yakin-kenar | İki parmakla yaklaş. (masaüstünde: Tekerle yaklaş.) | Sağ üst kenara doğru 3.2x yakınlaşıp geri gelir |
| yakin-kose | (Yaklaş.) | Sol alt kenara doğru 4.1x yakınlaşıp geri gelir |
| varyantlar | Her biri farklı. | Baloncuk yavaşça dönerken yerini, boyunu ve hareketini bozmadan sırayla sekiz farklı baloncuğa dönüşür, sonra ilkine döner |
| son-nefes | (yazı yok) | Sessiz bir an |
| patlama | Patlar. | Zar en ince yerinden ~70 ms'de yırtılır; düzensiz kenar, ışığı yansıtan damlacıklar |
| dogum | Yenisi doğar. | Yeni baloncuk bir noktadan büyüyerek doğar |
| (sıra sende) | Şimdi sıra sende. → Dokun. → Basılı tut, çiz. → Kaydır, çevir. → İki parmakla yaklaş. → Serbestsin. | Her talimat kişi hareketi yapana kadar (en çok 8 sn) bekler; sonra 10 sn serbest |
| (kapanış) | Teşekkürler. | |

**Sıra sende verisi** (ayrı satır, `stage = 'deneyim'`, gösteriyle aynı `run`): her adım için yapıldı mı, kaç ms'de, kaç dokunuş, kaç başka hareket, çizim uzunluğu/hızı (baloncuk yarıçapı cinsinden), çevirme uzunluğu/hızı, ulaşılan en büyük yakınlık ve o adımdaki fps/p95/en uzun kare. Serbest bölüm: ilk hareket ve hareket sayıları. Parmağın izi, konum, isim tutulmaz.

Kurgu, tören yönetmeni rolündeki bir ajanın senaryosundan uyarlandı. Metinleri Lu sadeleştirdi: kısa ve öz olmalı, duygu sömürüsü yok.

## Kurallar

- Bütün hareketler her ekran karesinde yumuşak eğrilerle ilerler. Hızlanma her zaman yavaş başlar; ani hareket yok.
- Şekiller, baloncuğun ekrandaki gerçek konumuna ve boyutuna göre çizilir; bu yüzden her ekrana uyar.
- Gösteri boyunca gerçek dokunuşlar engellenir ("Şimdi sıra sende." çıkana kadar); denemeler `touchAttempts` olarak sayılır.
- Gösteri boyunca üstte "Ekrana dokunma. Sadece izle, tadını çıkar." uyarısı durur.
- Yazılar sabit bir alt şeritte durur ve baloncuk bu şeridin etrafına yerleşir; yazı baloncuğun üstüne binmez. Tek istisna yakın bakış: baloncuk ekranı doldurduğu için yazı zarın üstünde kalır.
- Ölçüm sırasında ekran görüntüsü alınmamalı. Ekran görüntüsü kare kaçırır ve kalite ayarlayıcıyı yanıltır.
