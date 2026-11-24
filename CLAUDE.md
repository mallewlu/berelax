# Be Relax — Plexa

## Proje
Gen Z (18-25) için dijital wellness ve sosyal bağlantı platformu. berelax.space üzerinden sunuluyor.

## Tech Stack
- Frontend: Vite + React
- Auth: Supabase Auth (Google OAuth)
- Database: Supabase PostgreSQL, profiles tablosu, RLS aktif
- Hosting: Vercel + GitHub auto-deploy (main branch)
- Repo: github.com/mallewlu/berelax
- Supabase: kpoeifwhechqofqybrbr.supabase.co

## Tasarım Kuralları (MUTLAK)
- Siyah/beyaz minimal estetik, renkli UI yok
- Dark mode: bg=#080808, fg=#ddd8d0
- Light mode: bg=#ede9e3, fg=#1a1a1a
- Tipografi: yalnızca Apple sistem yazı tipi (SF Pro; -apple-system)
- Logo SVG dosyaları DOKUNULMAZ
- Minimalizm her zaman kazanır
- Tasarım kararları Lu'ya ait, onaysız görsel değişiklik yapma

## Auth Akışı
Hero ekranı → kalbe tıkla → login ekranı → Google ile giriş → hero'ya dön → swipe up → profil

## Yakınlar Sistemi
Takip/follower YOK. Yakınlık sadece fiziksel yan yana gelmeyle kurulur: iki kişi telefonlarının üst kısımlarını yaklaştırır, baloncuklar birleşir (yarısı bir telefonda, yarısı diğerinde, renkleri karışır), sonra bağlanılan kişinin kimlik kartı açılır. QR yok.

## Geliştirme
Geliştirme ve Lu'nun denemeleri berelax.space/dev üzerinden ilerler (kaynak: dev/, src/dev/, api/dev-signup.js, docs/dev/002_dev_space.sql). Eski taslaklar `arsiv/` branch'lerinde.
