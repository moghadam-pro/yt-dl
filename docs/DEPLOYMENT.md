# Deployment Guide

This guide deploys the relay on an Ubuntu server with Docker, Nginx, and Certbot.

All production values are placeholders. Replace them locally; do not commit the real values.

## 1. Server prerequisites

Recommended minimum for a small private relay:

- Ubuntu 22.04/24.04
- 2 vCPU
- ~1 GB RAM
- swap enabled
- enough disk for your temporary retention window
- Docker Engine + Docker Compose plugin
- Nginx
- Certbot

For a ~1 GB server, a 2 GB swap file is useful as a safety margin for FFmpeg spikes.

## 2. Clone

```bash
git clone https://github.com/moghadam-pro/yt-dl.git
cd yt-dl/relay
```

## 3. Runtime directories

```bash
mkdir -p \
  runtime/downloads \
  runtime/tmp \
  runtime/data \
  runtime/cookies

chmod 700 runtime/cookies
```

## 4. Environment

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and replace placeholders:

```dotenv
BOT_TOKEN=<TELEGRAM_BOT_TOKEN>
ALLOWED_CHAT_ID=<TELEGRAM_GROUP_ID>
ALLOWED_PRIVATE_USER_IDS=<TELEGRAM_USER_ID_1>,<TELEGRAM_USER_ID_2>
PUBLIC_BASE_URL=https://<DOWNLOAD_SUBDOMAIN>
```

Do not commit `.env`.

## 5. Optional cookies

Export cookies only when a platform actually requires them.

Cookie files must use Mozilla/Netscape cookies.txt format.

Example paths:

```text
runtime/cookies/youtube.txt
runtime/cookies/instagram.txt
```

Recommended permissions:

```bash
chmod 600 runtime/cookies/*.txt
```

The cookie volume is mounted read-only. The relay creates writable per-job copies for downloader tools.

## 6. Build

```bash
docker compose config --quiet
docker compose build
docker compose up -d
```

Check versions:

```bash
docker compose exec bot yt-dlp --version
docker compose exec bot gallery-dl --version
```

Check logs:

```bash
docker compose logs --tail=100 bot
```

## 7. Health endpoint

The Compose example publishes the HTTP service only on localhost:

```bash
curl -s http://127.0.0.1:8080/health
```

Expected shape:

```json
{
  "ok": true,
  "downloads": 0,
  "ttlHours": 24
}
```

## 8. DNS

Create an A/AAAA record for your download hostname pointing to the server.

Example only:

```text
<DOWNLOAD_SUBDOMAIN> -> <SERVER_PUBLIC_IP>
```

If using Cloudflare, keeping the record DNS-only during initial certificate setup is the simplest path.

## 9. Nginx

Copy the example:

```bash
sudo cp nginx/download.example.conf \
  /etc/nginx/sites-available/<DOWNLOAD_SUBDOMAIN>
```

Replace `<DOWNLOAD_SUBDOMAIN>` in the file.

Enable it:

```bash
sudo ln -sfn \
  /etc/nginx/sites-available/<DOWNLOAD_SUBDOMAIN> \
  /etc/nginx/sites-enabled/<DOWNLOAD_SUBDOMAIN>

sudo nginx -t
sudo systemctl reload nginx
```

Before TLS, this should reach the Node service:

```bash
curl -i http://<DOWNLOAD_SUBDOMAIN>/d/not-a-real-token
```

A 404 from the relay is expected.

## 10. HTTPS

```bash
sudo certbot --nginx \
  -d <DOWNLOAD_SUBDOMAIN>
```

Then:

```bash
curl -I https://<DOWNLOAD_SUBDOMAIN>/d/not-a-real-token
sudo certbot renew --dry-run
```

A 404 without a TLS error confirms the request reached the relay.

### Multiple old certificates on the same server

If the server already has Certbot certificates created using the `standalone` authenticator, renewal may fail after Nginx starts owning port 80.

For an active domain, reconfigure the authenticator if appropriate:

```bash
sudo certbot reconfigure \
  --cert-name <EXISTING_CERT_NAME> \
  --authenticator nginx
```

For a domain that has been permanently removed, remove its stale Certbot entry instead of accepting a permanently failing renewal job:

```bash
sudo certbot delete \
  --cert-name <REMOVED_CERT_NAME>
```

Do not manually delete files under `/etc/letsencrypt/live` as a replacement for `certbot delete`.

## 11. Telegram setup

Create a bot in BotFather and disable privacy mode if the bot needs to see ordinary URL messages in a group.

Add the bot to the allowed group.

The production values belong only in `.env`:

```text
<TELEGRAM_BOT_TOKEN>
<TELEGRAM_GROUP_ID>
<TELEGRAM_USER_ID_1>
<TELEGRAM_USER_ID_2>
```

## 12. Validation checklist

### Allowed media URL in group

Expected:

1. queued status;
2. download starts;
3. caption/metadata is returned;
4. direct download link is returned;
5. a single video/image gets a large preview when Telegram can render it;
6. a multi-item post returns a ZIP;
7. keep button is shown.

### Non-whitelisted URL

Expected: no bot response.

### Authorized private user

Expected: same behavior as the allowed group.

### Unauthorized private user

Expected: no download processing.

### Keep button

A trusted user should be able to make the file persistent. Other users receive an authorization warning.

## 13. Operations

Useful commands:

```bash
# logs
docker compose logs -f bot

# status
docker compose ps

# restart
docker compose restart bot

# disk usage
du -sh runtime/downloads

# registry
jq . runtime/data/downloads.json

# health
curl -s http://127.0.0.1:8080/health | jq
```

## 14. Updating downloader engines

Source sites change frequently.

Rebuild the image to refresh the yt-dlp nightly/pre-release package:

```bash
docker compose build --pull --no-cache
docker compose up -d --force-recreate
```

Validate known-good and known-bad sample links after every downloader update.

## 15. Production note

This reference implementation is appropriate for a small trusted group. For a public bot, add persistent queue storage, strong SSRF controls, rate limits, disk quotas, and operational monitoring before accepting untrusted traffic.
