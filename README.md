# Telegram Media Relay — yt-dlp + gallery-dl

A self-hosted Telegram media relay for trusted groups and private users.

Send a supported social-media post URL to the bot. The relay downloads the media, preserves the post caption/description, creates a temporary direct-download URL, and removes the file automatically after 24 hours unless a trusted user explicitly keeps it.

> **Repository note**
>
> This repository started as a fork of **yt-dlp**, so the upstream yt-dlp source and history are intentionally still present. The relay built during this project lives in [`/relay`](./relay). The relay uses packaged yt-dlp at runtime rather than modifying upstream extractor code.

## Why this project exists

The project began as a very small private utility: paste a video URL into a Telegram group and receive a temporary download link.

Real usage quickly changed the problem:

- some posts contain video;
- some contain one image;
- some are carousels with multiple images/videos;
- captions are as important as the media;
- YouTube behaves differently from a cloud/datacenter IP;
- downloader cookie jars may be mutated;
- unrelated URLs appear in the same Telegram group;
- a few trusted users also need private-chat access;
- some downloads should survive the default 24-hour retention window.

The result is a small **media relay**, not just a video downloader.

## Features

- Telegram long-polling bot; no public webhook required.
- One allowed group plus an explicit allowlist of private Telegram users.
- Explicit media-domain whitelist; unrelated links are silently ignored.
- Two concurrent download jobs by default; additional work is queued.
- Best available video quality through yt-dlp.
- yt-dlp nightly/pre-release channel with `curl_cffi` support.
- Image/gallery fallback through gallery-dl.
- Best-effort public-image fallback for LinkedIn posts.
- Single media item -> direct file link.
- Multiple media items -> ZIP archive.
- `caption.txt` included inside multi-media ZIP files.
- Full post caption/description also returned as Telegram text.
- Long captions are split into additional Telegram messages.
- Random 32-byte download tokens.
- 24-hour expiration by default.
- Trusted-user **Keep this link** action to disable automatic expiry.
- HTTP byte-range support for video streaming/seeking.
- Open Graph preview route for large Telegram media previews.
- Nginx + HTTPS public edge; application stays on localhost.
- Read-only source cookie volume with writable per-job copies.
- Non-root, read-only Docker container with dropped capabilities and resource limits.
- Structured JSON logs and basic error classification.

## Supported / whitelisted hosts in the example

The example environment includes common media hosts such as:

```text
youtube.com / youtu.be
instagram.com
tiktok.com
x.com / twitter.com
reddit.com / redd.it
linkedin.com
vimeo.com
twitch.tv
pinterest.com
threads.net / threads.com
bsky.app
facebook.com / fb.watch
dailymotion.com
```

This is an **allowlist**, not a promise that every post type on every platform will always download. Extractors and anti-bot behavior change frequently.

## Architecture

```text
Telegram
   |
   v
Authorization + domain whitelist
   |
   v
In-memory queue (2 concurrent jobs)
   |
   v
Metadata extraction
   |
   +------------------+
   |                  |
   v                  v
yt-dlp           gallery-dl
video/audio       image/gallery
   |                  |
   +--------+---------+
            |
            v
 LinkedIn public fallback
       (best effort)
            |
            v
     discovered media
            |
     +------+------+
     |             |
 one file      multi-media
     |             |
 direct file     ZIP + caption.txt
     |             |
     +------+------+
            |
            v
  expiring download store
            |
    /d/<random-token>
    /p/<random-token>
            |
            v
       Nginx + TLS
```

Read the detailed architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

## Repository layout

```text
relay/
├── .env.example
├── .gitignore
├── docker-compose.yml
├── nginx/
│   └── download.example.conf
└── app/
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── index.mjs
        ├── media-downloader.mjs
        ├── download-store.mjs
        └── linkedin-fallback.mjs

docs/
├── ARCHITECTURE.md
├── DEPLOYMENT.md
├── LEARNINGS.md
└── SECURITY.md
```

## Quick start

### 1. Clone

```bash
git clone https://github.com/moghadam-pro/yt-dl.git
cd yt-dl/relay
```

### 2. Create runtime directories

```bash
mkdir -p \
  runtime/downloads \
  runtime/tmp \
  runtime/data \
  runtime/cookies

chmod 700 runtime/cookies
```

### 3. Configure

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
BOT_TOKEN=<TELEGRAM_BOT_TOKEN>
ALLOWED_CHAT_ID=<TELEGRAM_GROUP_ID>
ALLOWED_PRIVATE_USER_IDS=<TELEGRAM_USER_ID_1>,<TELEGRAM_USER_ID_2>
PUBLIC_BASE_URL=https://<DOWNLOAD_SUBDOMAIN>
```

The real bot username, Telegram IDs, server IP, download hostname, tokens, and cookies from the original deployment are intentionally **not published**.

### 4. Build

```bash
docker compose config --quiet
docker compose build
docker compose up -d
```

### 5. Verify

```bash
docker compose ps
docker compose logs --tail=100 bot
curl -s http://127.0.0.1:8080/health
```

### 6. Add Nginx + HTTPS

Use:

```text
relay/nginx/download.example.conf
```

Replace `<DOWNLOAD_SUBDOMAIN>` with your own hostname, point DNS to the server, then obtain a certificate with Certbot.

Full instructions: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)

## Environment variables

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `ALLOWED_CHAT_ID` | Allowed group/supergroup ID |
| `ALLOWED_PRIVATE_USER_IDS` | Comma-separated trusted private-user IDs |
| `ALLOWED_MEDIA_HOSTS` | Comma-separated hostname whitelist |
| `POLL_TIMEOUT_SECONDS` | Telegram long-poll timeout |
| `MAX_CONCURRENT_DOWNLOADS` | Active download slots |
| `MAX_FILE_SIZE_MB` | Maximum accepted media bundle size |
| `DOWNLOAD_TTL_HOURS` | Default retention period |
| `PUBLIC_BASE_URL` | Public HTTPS download origin |
| `YOUTUBE_COOKIE_FILE` | Optional YouTube cookie path inside container |
| `INSTAGRAM_COOKIE_FILE` | Optional Instagram cookie path inside container |

## Single media vs. carousel behavior

### One file

If a post produces exactly one video or image:

```text
post URL
  -> downloader
  -> one media file
  -> /d/<token>
  -> /p/<token> preview page
```

### Multiple files

If a post produces multiple items:

```text
post URL
  -> downloader(s)
  -> image 1
  -> image 2
  -> video 1
  -> caption.txt
  -> archive.zip
  -> /d/<token>
```

Only one public download token is needed for the whole post.

## Caption behavior

The relay tries to preserve:

- title;
- creator/uploader;
- original post URL;
- platform/extractor name;
- full post description/caption.

A portion is included in the main success message. Longer captions are split into continuation messages so they are not silently lost to Telegram's message limits.

For multi-media posts the caption is also written into `caption.txt` inside the ZIP.

## Telegram preview behavior

The direct media route is:

```text
https://<DOWNLOAD_SUBDOMAIN>/d/<RANDOM_TOKEN>
```

Single videos/images also receive a preview route:

```text
https://<DOWNLOAD_SUBDOMAIN>/p/<RANDOM_TOKEN>
```

The preview route publishes Open Graph metadata pointing at the direct media file, and the Telegram message requests a large link preview.

This is intentionally different from calling Telegram `sendVideo` with the full file. The relay keeps the media lifecycle under the temporary server URL rather than deliberately creating a permanent Telegram-hosted attachment.

Telegram ultimately controls whether a given format receives an inline preview.

## Keep forever

Successful downloads include an inline action similar to:

```text
[ ♾️ Keep this link ]
```

Only users listed in `ALLOWED_PRIVATE_USER_IDS` can activate it.

Once kept, the registry changes the record to:

```json
{
  "persistent": true,
  "keptAt": 1234567890,
  "keptBy": 123456789
}
```

Persistent files are excluded from automatic timed cleanup.

> If you expose this to many users, add quotas and disk monitoring before allowing persistent storage.

## Cookies and YouTube anti-bot behavior

A cloud VPS can receive a YouTube anti-bot challenge even when yt-dlp itself is healthy.

Cookie files are optional and highly sensitive. If used:

1. export them in Netscape cookies.txt format;
2. keep them out of Git;
3. set restrictive permissions;
4. mount the source cookie directory read-only;
5. let each job create a disposable writable copy.

YouTube may still require newer extractor behavior, PO Tokens, account state changes, or different network egress. No single cookie technique guarantees permanent reliability.

## Why both yt-dlp and gallery-dl?

The original assumption was "the user sends a video link." Real social posts disproved that assumption.

`yt-dlp` is the primary video/audio engine.

`gallery-dl` is useful for image posts, galleries, and multi-item content on supported platforms.

At the time this documentation was written, gallery-dl's LinkedIn support had not landed as a released extractor, so the relay contains a narrow public-page fallback for LinkedIn images. It is intentionally best-effort and does not bypass authentication.

## Security

Read [`docs/SECURITY.md`](./docs/SECURITY.md) before using this beyond a trusted private group.

Important defaults:

- explicit Telegram access control;
- explicit host allowlist;
- random public tokens;
- short default retention;
- read-only cookie source;
- non-root container;
- localhost-only application port;
- Nginx/TLS at the edge;
- no production secrets in the repository.

## Lessons learned

The full build log and failure analysis are documented in:

[`docs/LEARNINGS.md`](./docs/LEARNINGS.md)

It includes practical lessons about:

- PyInstaller/standalone yt-dlp failures inside containers;
- switching to Python venv installation;
- YouTube anti-bot behavior on cloud IPs;
- cookie-file mutation and per-job copies;
- moving from "video downloader" to "media relay";
- ZIP packaging for carousel posts;
- Telegram previews;
- Nginx + Certbot on a server with pre-existing certificates;
- resource limits on a small VPS.

## Limitations

- Source websites can break extractors without notice.
- YouTube may reject datacenter IPs or require additional authentication/PO Token flows.
- LinkedIn image extraction is best-effort.
- The queue is in-memory and running jobs are not resumed after restart.
- The JSON download registry is intended for a small deployment, not high concurrency.
- Link preview rendering is controlled by Telegram.
- Persistent files require operator disk management.

## Responsible use

Use this project only for media you are authorized to access and download. Respect copyright, privacy, local law, and the terms of the source services.

This repository does not publish production session cookies, private credentials, DRM bypass logic, or private-service credential harvesting.

## Credits

This project is built around excellent open-source tools, especially:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [gallery-dl](https://pypi.org/project/gallery-dl/)
- FFmpeg
- Telegram Bot API
- Nginx
- Let's Encrypt / Certbot

The upstream yt-dlp source and commit history remain in this fork. Please follow upstream licensing and contribution guidance when modifying yt-dlp itself.

---

# نسخه فارسی

## Telegram Media Relay چیست؟

این پروژه یک سرویس Self-hosted برای دریافت Media از لینک پست‌های شبکه‌های اجتماعی از طریق Telegram است.

کاربر یک لینک مجاز را داخل گروه یا به‌صورت مستقیم برای Bot می‌فرستد. سیستم Media را دریافت می‌کند، Caption پست را نگه می‌دارد، یک لینک دانلود موقت می‌سازد و فایل را به‌صورت پیش‌فرض بعد از ۲۴ ساعت حذف می‌کند؛ مگر اینکه یکی از کاربران مورد اعتماد گزینه نگهداری دائمی را فعال کند.

> **نکته درباره Repository**
>
> این Repository از Fork کامل `yt-dlp` شروع شده است، بنابراین Source و History اصلی yt-dlp همچنان داخل Repo وجود دارد. کد Media Relay ما داخل پوشه [`/relay`](./relay) قرار دارد و بدون تغییر دادن Extractorهای upstream، از نسخه Package شده yt-dlp در Runtime استفاده می‌کند.

## چرا این پروژه ساخته شد؟

ایده اولیه خیلی ساده بود:

```text
لینک ویدیو در تلگرام
        ↓
دانلود روی سرور
        ↓
لینک دانلود ۲۴ ساعته
```

ولی استفاده واقعی نشان داد که مسئله فقط Video نیست:

- بعضی پست‌ها ویدیو دارند؛
- بعضی فقط عکس دارند؛
- بعضی Carousel و چندرسانه‌ای هستند؛
- Caption خود پست باید حفظ شود؛
- YouTube روی IP دیتاسنتری رفتار متفاوتی دارد؛
- Cookieها ممکن است توسط Downloader تغییر کنند؛
- داخل یک گروه لینک‌های نامرتبط زیادی ارسال می‌شود؛
- چند User مشخص باید بتوانند Private هم از Bot استفاده کنند؛
- بعضی فایل‌ها باید بیشتر از ۲۴ ساعت باقی بمانند.

به همین دلیل پروژه از یک Video Downloader به یک **Media Relay** تبدیل شد.

## قابلیت‌ها

- Telegram Bot با Long Polling و بدون نیاز به Webhook عمومی.
- یک Group مجاز + لیست User IDهای مجاز برای Private Chat.
- Whitelist صریح برای دامنه‌های Media.
- Ignore کامل لینک‌های غیرمرتبط.
- حداکثر دو دانلود هم‌زمان به‌صورت پیش‌فرض.
- Queue برای Jobهای بیشتر.
- بالاترین کیفیت موجود Video با yt-dlp.
- استفاده از yt-dlp nightly/pre-release و `curl_cffi`.
- استفاده از gallery-dl برای Image و Gallery.
- Fallback محدود برای عکس‌های Public LinkedIn.
- یک Media -> لینک مستقیم همان فایل.
- چند Media -> فایل ZIP.
- قرار دادن `caption.txt` داخل ZIPهای چندرسانه‌ای.
- ارسال Caption اصلی پست به‌صورت Text داخل Telegram.
- تقسیم Captionهای خیلی بلند به چند پیام.
- Token تصادفی ۳۲ بایتی برای لینک دانلود.
- حذف خودکار بعد از ۲۴ ساعت.
- دکمه نگهداری دائمی برای کاربران Trusted.
- پشتیبانی HTTP Range برای Seek و Streaming.
- Preview endpoint برای نمایش بزرگ‌تر Media داخل Telegram.
- Nginx + HTTPS روی Edge و نگه داشتن App روی localhost.
- Cookie اصلی Read-only و Copy قابل‌نوشتن برای هر Job.
- Container غیر Root با Read-only filesystem و Resource limit.
- Structured Log و Error Classification.

## جریان کلی

```text
Telegram
   ↓
بررسی دسترسی + Whitelist دامنه
   ↓
Queue با حداکثر ۲ Job هم‌زمان
   ↓
استخراج Metadata
   ↓
 ┌───────────────┐
 │               │
 ↓               ↓
yt-dlp        gallery-dl
Video/Audio    Image/Gallery
 │               │
 └───────┬───────┘
         ↓
LinkedIn Public Fallback
         ↓
Mediaهای پیدا شده
         ↓
 ┌───────┴────────┐
 │                │
یک فایل         چند فایل
 │                │
Direct           ZIP + caption.txt
 │                │
 └───────┬────────┘
         ↓
Download Store
         ↓
/d/<TOKEN>
/p/<TOKEN>
         ↓
Nginx + HTTPS
```

## راه‌اندازی سریع

```bash
git clone https://github.com/moghadam-pro/yt-dl.git
cd yt-dl/relay

mkdir -p \
  runtime/downloads \
  runtime/tmp \
  runtime/data \
  runtime/cookies

cp .env.example .env
chmod 600 .env
```

سپس `.env` را با مقادیر خودتان پر کنید:

```dotenv
BOT_TOKEN=<TELEGRAM_BOT_TOKEN>
ALLOWED_CHAT_ID=<TELEGRAM_GROUP_ID>
ALLOWED_PRIVATE_USER_IDS=<TELEGRAM_USER_ID_1>,<TELEGRAM_USER_ID_2>
PUBLIC_BASE_URL=https://<DOWNLOAD_SUBDOMAIN>
```

بعد:

```bash
docker compose config --quiet
docker compose build
docker compose up -d
```

بررسی:

```bash
docker compose ps
docker compose logs --tail=100 bot
curl -s http://127.0.0.1:8080/health
```

راهنمای کامل Deploy:

[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)

## رفتار پست تک‌رسانه‌ای و چندرسانه‌ای

### یک فایل

اگر پست فقط یک عکس یا یک ویدیو داشته باشد، همان فایل به‌صورت مستقیم با Token موقت سرو می‌شود.

### چند فایل

اگر پست چند عکس/ویدیو داشته باشد:

1. همه فایل‌ها دانلود می‌شوند؛
2. Caption در `caption.txt` ذخیره می‌شود؛
3. کل مجموعه ZIP می‌شود؛
4. فقط یک لینک دانلود برای ZIP ساخته می‌شود؛
5. Caption همچنان جداگانه داخل Telegram هم ارسال می‌شود.

## Caption

سیستم تلاش می‌کند این موارد را حفظ کند:

- Title؛
- Creator/Uploader؛
- URL اصلی پست؛
- Platform/Extractor؛
- Description/Caption کامل.

اگر Caption از محدودیت پیام Telegram بزرگ‌تر باشد، ادامه آن در پیام‌های جداگانه ارسال می‌شود.

## Preview در Telegram

لینک مستقیم Media:

```text
https://<DOWNLOAD_SUBDOMAIN>/d/<RANDOM_TOKEN>
```

برای Single Image/Video یک Preview URL هم وجود دارد:

```text
https://<DOWNLOAD_SUBDOMAIN>/p/<RANDOM_TOKEN>
```

این صفحه Open Graph metadata تولید می‌کند و Telegram برای نمایش Preview بزرگ از آن استفاده می‌کند.

این طراحی عمداً با `sendVideo` کردن کامل فایل فرق دارد؛ چون هدف این است که Lifecycle فایل همچنان تحت کنترل لینک موقت سرور باقی بماند و فایل را عمداً به یک Attachment دائمی Telegram تبدیل نکنیم.

نمایش Preview در نهایت به تصمیم Telegram Client/Crawler بستگی دارد.

## دکمه نگهداری دائمی

بعد از دانلود موفق، دکمه‌ای مشابه زیر نمایش داده می‌شود:

```text
[ ♾️ این لینک حذف نشود ]
```

فقط User IDهای موجود در `ALLOWED_PRIVATE_USER_IDS` اجازه فعال‌کردن آن را دارند.

بعد از فعال‌سازی:

```json
{
  "persistent": true,
  "keptAt": 1234567890,
  "keptBy": 123456789
}
```

و Cleanup دیگر آن فایل را با Timer حذف نمی‌کند.

## Cookie و مشکل Anti-bot YouTube

کار کردن yt-dlp روی یک لینک به این معنی نیست که YouTube همیشه همان درخواست را از IP سرور ابری قبول می‌کند.

در صورت نیاز می‌توان Cookie اضافه کرد، اما Cookie یک Credential حساس است.

الگوی این پروژه:

1. Cookie اصلی خارج از Git نگهداری می‌شود؛
2. Permission محدود دارد؛
3. Volume Cookie داخل Container Read-only است؛
4. برای هر Job یک Copy موقت ساخته می‌شود؛
5. Downloader روی Copy کار می‌کند؛
6. Copy همراه Temp Job حذف می‌شود.

حتی با Cookie هم YouTube ممکن است به PO Token، Account state یا Network egress متفاوت نیاز داشته باشد.

## چرا gallery-dl اضافه شد؟

تجربه عملی نشان داد فرض «هر لینک یک ویدیو دارد» غلط است.

`yt-dlp` موتور اصلی Video/Audio باقی ماند، اما برای Image، Carousel و Gallery از `gallery-dl` استفاده می‌شود.

در زمان نوشتن این مستند، LinkedIn extractor رسمی gallery-dl هنوز در Release اصلی وجود نداشت؛ برای همین یک fallback محدود Public HTML اضافه شده است. این بخش تضمین نمی‌کند تمام LinkedIn Carouselها را همیشه بگیرد و Authentication را دور نمی‌زند.

## امنیت

قبل از استفاده عمومی حتماً بخوانید:

[`docs/SECURITY.md`](./docs/SECURITY.md)

اصول مهم:

- هیچ Token یا Cookie واقعی داخل Git نباشد؛
- Group/User IDهای واقعی داخل Repo Public قرار نگیرند؛
- فقط Hostهای Whitelist شده به Downloader داده شوند؛
- Container غیر Root باشد؛
- Port برنامه فقط روی localhost Publish شود؛
- HTTPS روی Nginx terminate شود؛
- Token دانلود تصادفی و غیرقابل حدس باشد؛
- Persistent storage برای کاربران محدود باشد.

## مسیر یادگیری و تجربه‌های واقعی

تمام Failureها و چیزهایی که در ساخت این پروژه یاد گرفته شد اینجا ثبت شده است:

[`docs/LEARNINGS.md`](./docs/LEARNINGS.md)

از جمله:

- مشکل Binary مستقل yt-dlp داخل Docker؛
- مهاجرت به Python venv؛
- Anti-bot یوتیوب روی IP ابری؛
- مشکل Read-only Cookie و راه‌حل Copy per-job؛
- تغییر معماری از Video Downloader به Media Relay؛
- ZIP برای Carousel؛
- Telegram Preview؛
- Nginx و Certbot روی سروری که Certificate قدیمی داشته؛
- محدود کردن CPU/RAM روی VPS کوچک.

## محدودیت‌ها

- تغییر سایت‌های مبدا می‌تواند Extractorها را خراب کند.
- YouTube ممکن است IP دیتاسنتری را محدود کند.
- Fallback عکس LinkedIn Best-effort است.
- Queue فعلی In-memory است و بعد از Restart Job در حال اجرا Resume نمی‌شود.
- Registry JSON برای Deployment کوچک طراحی شده است.
- Telegram خودش درباره نمایش Link Preview تصمیم می‌گیرد.
- فایل‌های Persistent نیاز به مدیریت Disk دارند.

## استفاده مسئولانه

فقط Mediaهایی را دانلود کنید که اجازه دسترسی و دانلود آن‌ها را دارید. قوانین Copyright، Privacy، قوانین محلی و Terms سرویس مبدا همچنان معتبر هستند.

این Repository اطلاعات واقعی Session، Cookie خصوصی، Credential یا مکانیزم DRM bypass منتشر نمی‌کند.

## ابزارهای اصلی

این پروژه روی شانه ابزارهای Open Source زیر ساخته شده است:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [gallery-dl](https://pypi.org/project/gallery-dl/)
- FFmpeg
- Telegram Bot API
- Nginx
- Let's Encrypt / Certbot

برای جزئیات بیشتر معماری، Deploy و Security به پوشه [`docs`](./docs) مراجعه کنید.
