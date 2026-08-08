# Roadmap

This roadmap tracks the next practical improvements discovered while operating the reference relay.

## P0 — Media relay completeness

### Complete multi-image LinkedIn extraction

Current state:

- LinkedIn video posts can work through yt-dlp.
- Image-only posts need a separate path.
- The repository includes a public HTML/Open Graph fallback.
- Complete carousel extraction is still best-effort because public LinkedIn HTML may expose only a preview image.

Next steps:

- evaluate a stable released LinkedIn gallery extractor when available;
- preserve post order;
- avoid avatars/logos/preview duplicates;
- add deterministic test fixtures that contain no private content.

### Validate Telegram preview route

The relay separates:

```text
/d/<token> -> forced download
/m/<token> -> inline media stream
/p/<token> -> Open Graph preview document
```

Next steps:

- verify MP4 preview behavior across Telegram desktop/mobile;
- add width/height/duration metadata when available;
- add image dimensions;
- confirm preview behavior after a file is marked persistent.

## P1 — YouTube reliability

YouTube is the main remaining unreliable platform in the cloud-VPS test environment.

Current mitigations:

- yt-dlp nightly/pre-release package;
- `curl_cffi`;
- optional Netscape cookies;
- disposable per-job cookie copies;
- conservative request sleeps.

Next step:

- add an **optional PO Token provider** integration following current yt-dlp guidance.

Requirements:

- disabled by default;
- no token/cookie logging;
- no account secrets in Git;
- clear operational/account-risk documentation;
- preserve existing behavior for non-YouTube sites.

## P1 — Persistent queue

The current queue is intentionally in memory.

Move jobs into SQLite so that:

- queued jobs survive a restart;
- running jobs can be marked interrupted;
- retries can be bounded;
- job history can be inspected safely.

## P1 — Disk safety

Persistent downloads can outlive the 24-hour cleanup window.

Add:

- minimum free-disk guard;
- maximum persistent-file count/size;
- admin list/delete commands;
- orphan-directory cleanup;
- per-user keep quotas.

## P2 — Security hardening

- Resolve hostnames and reject private/link-local/metadata IP ranges before outbound requests.
- Revalidate every redirect target.
- Add per-user and per-chat rate limiting.
- Add maximum queue depth.
- Add wall-clock download timeout.
- Add optional source-URL redaction/hashing in logs.

## P2 — Observability

Expose operator metrics such as:

```text
jobs_total{platform,status}
active_downloads
queue_length
download_bytes_total
extractor_failures_total{engine,type}
persistent_bytes
disk_free_bytes
```

## P2 — Storage backends

For larger deployments, support S3-compatible storage while preserving short-lived signed links and timed cleanup.

## P3 — User experience

- `/status` for authorized users.
- `/help` generated from the current whitelist.
- Admin command to inspect queue length.
- Localized bot strings (English/Persian) through a message catalog instead of hard-coded strings.
- Better ZIP filenames and manifest metadata.
