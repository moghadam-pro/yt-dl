# Media Relay Architecture

This document describes the public reference architecture used by the Telegram media relay in this repository.

## Goals

- Accept media URLs only from an explicit hostname whitelist.
- Process messages from one allowed Telegram group and an explicit list of allowed private users.
- Keep at most a small number of downloads active at once.
- Prefer the best available video quality.
- Support images and multi-item posts in addition to video.
- Bundle multi-item posts into a ZIP archive.
- Return the original post caption/description as Telegram text.
- Create unguessable download URLs that expire after 24 hours by default.
- Allow trusted users to mark a download as persistent.
- Keep the public HTTP service behind Nginx and bind the container port to localhost only.
- Never commit Telegram tokens, cookies, private IDs, or production domains.

## High-level flow

```text
Telegram group / private chat
          |
          v
  authorization + host whitelist
          |
          v
      in-memory queue
      max concurrency = 2
          |
          v
   metadata extraction
          |
          +----------------------------+
          |                            |
          v                            v
       yt-dlp                     gallery-dl
  video / audio first          images / galleries
          |                            |
          +-------------+--------------+
                        |
                        v
             LinkedIn public fallback
             (best-effort images only)
                        |
                        v
                discovered media
                        |
              +---------+---------+
              |                   |
          one file            multiple files
              |                   |
              |             caption.txt + ZIP
              |                   |
              +---------+---------+
                        |
                        v
                  download store
                        |
       random 32-byte base64url token
                        |
          +-------------+-------------+
          |                           |
      /d/<token>                 /p/<token>
    direct media/file          OG preview page
          |                           |
          +-------------+-------------+
                        |
                        v
                 Nginx + HTTPS
                        |
                        v
                    Telegram
```

## Download engines

### 1. yt-dlp

`yt-dlp` remains the first engine because it has strong support for video sites and format selection. The relay asks for best available video + audio and merges to MP4 when appropriate.

The container installs the nightly/pre-release channel and `curl_cffi` support because site extractors and anti-bot behavior change frequently.

### 2. gallery-dl

`gallery-dl` is the second engine. It is used when the first engine does not produce downloadable media, and is especially useful for image posts, galleries, and multi-item social posts.

### 3. LinkedIn public HTML fallback

At the time this architecture was documented, gallery-dl did not yet have a released LinkedIn extractor. The repository therefore includes a deliberately limited fallback that:

- fetches only a public LinkedIn page;
- reads Open Graph/Twitter metadata;
- considers only media hosted on LinkedIn/LinkedIn CDN hosts;
- does not bypass authentication;
- does not attempt private API calls.

It is best-effort. LinkedIn can change its markup at any time and some multi-image posts may not expose every asset in public HTML.

## Multi-item behavior

If exactly one media file is discovered, that file becomes the downloadable artifact.

If more than one media file is discovered:

1. the original post description is written to `caption.txt` when available;
2. all media files are retained;
3. the job directory is packaged as a ZIP file;
4. the ZIP becomes the public artifact.

The entire job directory is deleted when the download expires.

## Telegram preview behavior

The direct route is:

```text
https://<DOWNLOAD_SUBDOMAIN>/d/<TOKEN>
```

For a single image or video, a second route is generated:

```text
https://<DOWNLOAD_SUBDOMAIN>/p/<TOKEN>
```

The preview route returns a tiny Open Graph HTML document referencing the direct media URL. The Telegram message asks for a large link preview using that preview URL.

This avoids the main relay intentionally uploading the entire media file into Telegram as a new permanent Telegram-hosted attachment. It also keeps the direct download lifecycle controlled by the relay.

Preview generation is ultimately controlled by Telegram clients/crawlers and is not guaranteed for every format.

## Expiry model

Each record stores:

```json
{
  "token": "<RANDOM_TOKEN>",
  "createdAt": 0,
  "expiresAt": 0,
  "persistent": false,
  "keptAt": null,
  "keptBy": null
}
```

A cleanup loop checks once per minute. Expired non-persistent records are removed from the registry and their job directories are recursively deleted.

A trusted Telegram user can press the inline **Keep this link** button. The record then becomes persistent and is excluded from timed cleanup.

## Persistence

The reference implementation deliberately uses a small JSON registry instead of a database to keep the deployment easy to understand. File updates are serialized and written through a temporary file + rename.

For larger deployments, replace this with SQLite or PostgreSQL and make the job queue persistent as well.

## Queue

The reference server that motivated this design had approximately 1 GB of RAM. Two simultaneous downloads gave a practical compromise between responsiveness and memory/FFmpeg pressure.

The queue is currently in memory. A container restart keeps already registered downloads, but queued/running jobs are not resumed.

## Network model

```text
Internet
   |
   v
Nginx :80/:443
   |
   v
127.0.0.1:8080
   |
   v
Docker container
```

The container port is never published on all interfaces.

## Cookie model

Cookie files on the host are mounted read-only into the container.

Some download tools rewrite cookie jars on exit. Therefore each job copies the relevant cookie file into that job's writable temporary directory and gives the copy to the downloader.

This has two benefits:

- the source cookie file remains read-only;
- two concurrent jobs do not write to the same cookie file.

## Current limitations

- YouTube may still require fresh account cookies, PO Tokens, or a non-datacenter egress IP.
- Public cloud IP ranges are sometimes blocked by media platforms.
- LinkedIn public-image extraction is best-effort.
- The in-memory queue does not survive restarts.
- A persistent file never expires automatically, so operators must monitor disk usage.
- Download tools can break when source websites change.

## Possible next steps

- SQLite-backed queue and registry.
- Per-platform health metrics.
- Persistent-download quotas.
- Admin command to list/delete stored files.
- Optional S3-compatible object storage.
- Better media preview pages with width/height/duration metadata.
- Platform-specific authenticated adapters where permitted.
