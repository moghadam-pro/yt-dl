# Build Log & Lessons Learned

This document records the practical lessons that came out of building a small self-hosted Telegram media relay on an Ubuntu VPS.

The goal is not to present a perfect final architecture. It is to preserve the real failure modes, trade-offs, and fixes that made the system work.

---

# English

## 1. Start with the smallest useful architecture

The first working target was intentionally narrow:

- one Telegram group;
- one bot;
- one server;
- one URL per message;
- two simultaneous downloads;
- everything else queued;
- best available video quality;
- 24-hour server retention.

Starting small made it easier to separate Telegram problems from downloader problems and storage problems.

## 2. A desktop downloader is not automatically a server API

The first project investigated was OmniGet. It contains useful downloader logic and a CLI, but its desktop application and internal localhost bridge are not the same thing as a production headless HTTP service.

Lesson:

> Reuse the extraction/download engine, not necessarily the desktop application's runtime architecture.

The relay therefore became a small server application around downloader CLIs instead of trying to run a full desktop application on a VPS.

## 3. The standalone yt-dlp Linux binary was a bad fit in this container

An early Docker image downloaded the standalone `yt-dlp_linux` executable. On this deployment it failed at startup with a PyInstaller extraction/decompression error.

Moving yt-dlp into a Python virtual environment inside the container fixed the problem:

```text
python3 -m venv /opt/media-tools
/opt/media-tools/bin/python -m pip install ... yt-dlp
```

Lesson:

> When a bundled binary fails inside a minimal container, prefer the native runtime/package installation before debugging the bundled executable for hours.

## 4. YouTube failure was not a Docker failure

After the yt-dlp runtime was fixed, YouTube still failed from the cloud VPS with a message similar to:

```text
Sign in to confirm you're not a bot
```

That changed the diagnosis completely. The downloader was working; YouTube was challenging the server/account/IP combination.

A valid Netscape cookie file allowed extraction to proceed in testing, but this introduces its own lifecycle and security concerns.

Lesson:

> Distinguish downloader crashes from extractor/authentication failures. They require very different fixes.

## 5. Cookie files should not be writable shared state

The first secure instinct was to mount the cookie directory read-only:

```yaml
./runtime/cookies:/data/cookies:ro
```

That exposed another real behavior: yt-dlp may save/update its cookie jar when it exits. A read-only source file caused the download to succeed and then fail during cookie save.

Simply making the shared cookie file writable was functional but undesirable, especially with two concurrent jobs.

The better design became:

1. keep the source cookie file mounted read-only;
2. copy it into the per-job temp directory;
3. give the writable copy to yt-dlp/gallery-dl;
4. delete the copy with the rest of the job temp data.

Lesson:

> Credentials should be immutable input whenever possible. Give mutable tools disposable copies.

## 6. Cloud IP reputation is part of downloader reliability

Some platforms behave differently when requests come from datacenter IP ranges. A link that works on a residential browser can fail on a public VPS.

This means downloader reliability is not only a software-version problem. It can depend on:

- source platform;
- extractor version;
- cookies/account state;
- TLS/browser fingerprint;
- request rate;
- IP reputation;
- region.

For this reason the container later moved to yt-dlp nightly/pre-release builds with `curl_cffi` support.

## 7. Video downloaders do not cover every social-media post type

A major turning point was a LinkedIn post that contained images instead of video. yt-dlp correctly failed to extract a video because there was no video.

That exposed a product assumption hidden in the first version:

> The input is not a "video URL". It is a "social-media post URL that may contain media".

The architecture changed to:

```text
yt-dlp      -> video/audio
 gallery-dl -> images/galleries/multi-media
 fallback   -> limited public-page extraction when needed
```

## 8. Multi-media should be treated as one artifact

For a carousel or post with multiple images/videos, returning many short-lived URLs creates a poor experience and complicates cleanup.

The chosen behavior is:

- one media item -> return it directly;
- multiple media items -> ZIP everything;
- also write the post caption to `caption.txt` inside the ZIP;
- still send the caption as Telegram text.

This creates one token, one expiration time, and one cleanup unit.

## 9. Captions are first-class output

The first prototype only returned filename and size. That lost an important part of social content: the author's text.

The downloader now tries to preserve:

- title;
- uploader/creator;
- platform/extractor;
- original post URL;
- full description/caption.

Telegram message limits require long captions to be split across messages. The download URL is repeated so the continuation is still useful when read out of context.

## 10. Whitelisting is safer than trying every URL

A Telegram group contains many links that have nothing to do with media extraction.

Instead of passing every HTTP URL to download tools, the bot has an explicit hostname whitelist.

Benefits:

- fewer accidental downloads;
- less SSRF-like attack surface;
- lower load;
- less noisy error logging;
- predictable product behavior.

The public example includes common media hosts, but deployments should narrow the list to what they actually need.

## 11. Group access and private access are separate policies

The relay supports:

- one allowed group chat ID;
- an explicit list of private Telegram user IDs.

That means all members of the group can use the bot in the group, while only trusted users can use it in private chat.

The same trusted-user list is also used to authorize the **keep forever** action.

## 12. Two concurrent downloads were a deliberate resource choice

The reference VPS had roughly:

- 2 vCPU;
- ~1 GB RAM;
- 2 GB swap;
- ~40 GB disk.

FFmpeg and multiple downloaders can spike memory. A concurrency limit of two was a practical compromise.

The container also received:

- memory limit;
- swap limit;
- CPU limit;
- PID limit;
- read-only root filesystem;
- dropped Linux capabilities;
- `no-new-privileges`.

## 13. Expiring URLs need unguessable tokens

Public downloads use random 32-byte tokens encoded as base64url.

The route looks like:

```text
https://<DOWNLOAD_SUBDOMAIN>/d/<RANDOM_TOKEN>
```

The token is not derived from Telegram IDs, filenames, URLs, or timestamps.

A registry stores the token -> file mapping and expiration time.

## 14. Deleting the file is only half the expiration model

The desired behavior is:

- after 24 hours the URL stops working;
- the file is deleted;
- stale records are removed;
- cleanup also happens after a restart.

The implementation therefore checks expiry both:

- proactively in a periodic cleanup loop;
- reactively when a request arrives.

## 15. "Keep forever" should be authorization-controlled

A persistent-download button is useful, but letting every group member keep arbitrary files forever can fill the disk quickly.

The button is visible with successful downloads, but only explicitly trusted Telegram users can activate it.

A persistent record stores:

```json
{
  "persistent": true,
  "keptAt": 0,
  "keptBy": 123456789
}
```

Persistent records are skipped by the timed cleanup loop.

## 16. Telegram link preview and Telegram file upload are different products

Telegram's Bot API can fetch and send an HTTP video URL as a native video message, but doing so effectively creates a Telegram-hosted media message and changes the lifecycle semantics.

This relay instead keeps the download lifecycle on the relay server and adds a small preview page:

```text
/p/<token>
```

The preview page exposes Open Graph metadata referencing the direct media route. Telegram is asked to use a large preview.

This is a best-effort preview: Telegram ultimately decides whether and how a URL is rendered.

## 17. Nginx should be the public edge

The application listens inside Docker on port 8080, but Docker publishes it only to:

```text
127.0.0.1:8080
```

Nginx owns ports 80 and 443 and proxies to localhost.

This makes TLS management, HTTP headers, request limits, and future access controls much easier.

## 18. Certbot renewal configuration matters when multiple services share a server

One server already had certificates created with Certbot's `standalone` authenticator. After Nginx started listening on port 80, those old standalone renewals could no longer bind the port.

For active domains, reconfiguring renewal to use the Nginx authenticator solved the problem.

For a domain/service that no longer existed, deleting its stale certificate/renewal entry was cleaner than keeping a permanently failing renewal job.

Lesson:

> Adding a web server can break renewal methods of certificates that predate the web server.

## 19. Logs should explain which layer failed

A generic "download failed" message is not enough for operation or learning.

Useful structured fields include:

```text
platform
hostname
error_type
engine
source_url (only when appropriate for your privacy model)
active_downloads
queue_length
```

The relay classifies common failures such as:

- authentication required;
- extractor unsupported;
- no video format;
- access blocked/403;
- size limit;
- generic download failure.

## 20. What is intentionally not published

The public repository must never contain:

- Telegram bot tokens;
- Telegram group IDs from a real deployment;
- trusted user's real Telegram IDs;
- exported cookie values;
- production `.env` files;
- private server IP addresses;
- real download tokens;
- private or sensitive source URLs;
- TLS private keys.

The public examples use placeholders instead.

---

# فارسی

## چرا این مستند نوشته شد؟

این پروژه فقط یک Downloader نیست؛ مجموعه‌ای از تجربه‌های واقعی درباره‌ی Telegram Bot، Docker، yt-dlp، Cookie، محدودیت IP دیتاسنتری، Nginx، Certbot و مدیریت فایل موقت است.

هدف این بخش این است که نکته‌های اصلی مسیر ساخت، بدون اطلاعات خصوصی Deployment اصلی، برای فارسی‌زبان‌ها هم قابل استفاده باشد.

## مهم‌ترین یادگیری‌ها

### ۱. مسئله را کوچک شروع کنید

نسخه اول فقط یک گروه تلگرام، یک Bot، دو دانلود هم‌زمان و نگهداری ۲۴ ساعته داشت. این کار باعث شد مشکل‌های Telegram، Downloader و Storage از هم جدا شوند.

### ۲. خرابی yt-dlp همیشه به معنی خرابی خود yt-dlp نیست

بعد از رفع مشکل اجرای Binary داخل Docker، YouTube همچنان Anti-bot نشان می‌داد. این یعنی Runtime سالم بود و مشکل در Authentication/IP/Extractor قرار داشت.

### ۳. Cookie اصلی را Writable نکنید

Cookie اصلی روی Host به‌صورت Read-only Mount می‌شود. برای هر Job یک Copy موقت ساخته می‌شود تا Downloader بتواند آن را تغییر دهد و دو Job هم‌زمان روی یک فایل Credential مشترک ننویسند.

### ۴. «لینک ویدیو» تعریف درستی برای محصول نبود

پست شبکه اجتماعی می‌تواند شامل:

- ویدیو؛
- یک عکس؛
- چند عکس؛
- ترکیب چند رسانه؛
- متن و کپشن

باشد. به همین دلیل معماری از یک Video Downloader به یک **Media Relay** تبدیل شد.

### ۵. برای Gallery موتور جدا لازم است

`yt-dlp` برای Video عالی است، ولی برای Gallery و Image ابزار `gallery-dl` مناسب‌تر است. بنابراین سیستم چندموتوره شد.

### ۶. Multi-media بهتر است یک ZIP باشد

اگر پست چند فایل داشته باشد، همه فایل‌ها به همراه `caption.txt` داخل ZIP می‌روند و فقط یک لینک دانلود ساخته می‌شود.

### ۷. Caption بخشی از خروجی است

متن پست مثل خود Media مهم است. Caption در پیام Telegram ارسال می‌شود و اگر طولانی باشد به چند پیام تقسیم می‌شود.

### ۸. Whitelist مهم است

هر URL داخل گروه نباید وارد Downloader شود. فقط Hostهای مجاز پردازش می‌شوند و سایر لینک‌ها بدون پاسخ Ignore می‌شوند.

### ۹. Private Access باید محدود باشد

استفاده مستقیم از Bot فقط برای User IDهای مشخص فعال است، در حالی که اعضای گروه مجاز می‌توانند در همان گروه از Bot استفاده کنند.

### ۱۰. نگهداری دائمی فایل باید مجوز داشته باشد

دکمه‌ی «این لینک حذف نشود» فقط توسط کاربران Trusted قابل فعال‌سازی است تا فضای Disk توسط اعضای گروه بدون کنترل پر نشود.

### ۱۱. لینک ۲۴ ساعته فقط یک Timer نیست

Expired شدن یعنی:

- URL دیگر کار نکند؛
- Record حذف شود؛
- فایل روی Disk حذف شود؛
- بعد از Restart هم Cleanup انجام شود.

### ۱۲. Preview تلگرام با Upload کردن فایل فرق دارد

برای اینکه Lifecycle فایل همچنان روی سرور کنترل شود، به‌جای تبدیل هر فایل به Attachment دائمی Telegram، یک Preview URL با Open Graph تولید می‌شود.

### ۱۳. Nginx مرز عمومی سرویس است

Container فقط روی `127.0.0.1:8080` Publish می‌شود و Nginx روی 80/443 قرار می‌گیرد.

### ۱۴. Certbot قدیمی ممکن است بعد از نصب Nginx خراب شود

Certificateهایی که قبلاً با `standalone` ساخته شده‌اند برای Renewal نیاز دارند خود Certbot روی Port 80 Bind کند. وقتی Nginx این Port را گرفته باشد، Renewal شکست می‌خورد. برای دامنه فعال باید Authenticator اصلاح شود؛ برای دامنه حذف‌شده بهتر است Renewal قدیمی پاک شود.

### ۱۵. اطلاعات واقعی Deployment نباید Public شوند

Token، Cookie، Chat ID، User ID، IP، Private Key و Production Domain در Repository عمومی قرار نمی‌گیرند و با Placeholder جایگزین می‌شوند.

---

## Final principle / اصل نهایی

A reliable media relay is less about finding one magical downloader and more about building safe fallbacks, observable failures, bounded resource use, and disposable state around tools that will inevitably break when source websites change.

یک Media Relay قابل اعتماد با پیدا کردن یک Downloader جادویی ساخته نمی‌شود؛ با Fallback امن، خطای قابل مشاهده، مصرف منابع محدود و State قابل حذف ساخته می‌شود، چون سایت‌های مبدا دائماً تغییر می‌کنند.
