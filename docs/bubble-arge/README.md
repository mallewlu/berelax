# Bubble Ar-Ge

Baloncuğa eklenen her özellik önce burada denenir, ölçülür ve değerlendirilir.

## Link

https://www.berelax.space/bubble-arge/?olcum=1&seed=65ad1f24806f4b44

- `olcum=1`: tören (izleyici dokunmaz, sadece izler) ve ölçüm. Bu parametre yoksa sayfa normal lab olarak açılır.
- `seed`: herkes aynı baloncuğu görür; sonuçlar cihazlar arasında karşılaştırılabilir.
- Patlamadan sonra doğan baloncuk her cihazda aynıdır: `reference-9`.

## Döngü

1. **Ekle.** Yeni özellik törene bir sahne olarak girer: `src/bubble/zoom-lab/measurementShow.js`. Her sahnenin `id`'si ölçümdeki bölüm adıdır. Sahneler değişince rapordaki `version` artırılır.
2. **Yayınla.** `node scripts/build-bubble-arge.mjs` sayfayı `public/bubble-arge/` içine derler. Ardından commit atılır ve main'e push edilir; Vercel yayınlar. Link değişmez.
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
| merhaba | Bu bir baloncuk. / Nefes alıyor. | Karanlıktan belirir |
| dokunus | Dokun. | Dört dokunuş, dalgacıklar |
| cizim-daire, -ucgen, -kalp, -sonsuz, -yildiz | İz bırak. / Renkler akar. | Zarın üzerine parmakla şekiller çizilir |
| cevir | Çevir. | Kavisli bir savuruş; bırakınca kendi kendine yavaşlar |
| yakin-kenar | Yaklaş. | Sağ üst kenara doğru 3.2x yakınlaşıp geri gelir |
| yakin-kose | (Yaklaş.) | Sol alt kenara doğru 4.1x yakınlaşıp geri gelir |
| varyantlar | Her biri farklı. | Sekiz farklı baloncuk yarımşar saniye görünür, sonra ilk baloncuğa dönülür |
| son-nefes | Bazen patlar. | Sessiz bir an |
| patlama | Üzülme. / Yenisi doğar. | Zar bir noktadan yırtılır; parlak kenar ve damlacıklar |
| dogum | İşte yenisi. | Yeni baloncuk bir noktadan büyüyerek doğar |
| (kapasite) | Bir an. / Cihazına bakıyoruz. | Karanlığın arkasında kare maliyeti ölçülür |
| (kapanış) | Teşekkürler. / Şimdi sıra sende. | Baloncuk geri gelir, artık dokunulabilir |

Kurgu, tören yönetmeni rolündeki bir ajanın senaryosundan uyarlandı. Metinleri Lu sadeleştirdi: kısa ve öz olmalı, duygu sömürüsü yok.

## Kurallar

- Bütün hareketler her ekran karesinde yumuşak eğrilerle ilerler. Hızlanma her zaman yavaş başlar; ani hareket yok.
- Şekiller, baloncuğun ekrandaki gerçek konumuna ve boyutuna göre çizilir; bu yüzden her ekrana uyar.
- Yazılar sabit bir alt şeritte durur ve baloncuk bu şeridin etrafına yerleşir; yazı baloncuğun üstüne binmez. Tek istisna yakın bakış: baloncuk ekranı doldurduğu için yazı zarın üstünde kalır.
- Ölçüm sırasında ekran görüntüsü alınmamalı. Ekran görüntüsü kare kaçırır ve kalite ayarlayıcıyı yanıltır.
