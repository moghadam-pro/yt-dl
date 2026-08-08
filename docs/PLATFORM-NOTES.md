# Platform Notes

These notes record observations from the small reference deployment that motivated the public relay. They are not guarantees of platform support.

Source sites change frequently. Always test the current downloader versions against public sample URLs that you are authorized to access.

## Observed status before the gallery/media-bundle upgrade

| Platform | Observation | Notes |
|---|---|---|
| YouTube | Problematic from the cloud VPS | yt-dlp runtime worked, but YouTube returned anti-bot/authentication challenges. Cookies helped in some tests but were not a durable fix. Current yt-dlp documentation also describes increasing PO Token enforcement. |
| Instagram | Successful on tested media links | Gallery/image support is now also routed through gallery-dl when needed. |
| TikTok | Successful on tested links | Site behavior and rate limits can still change. |
| X / Twitter | Successful on tested links | gallery-dl provides an additional path for image/gallery posts. |
| Reddit | Successful on tested links | gallery-dl can also process supported Reddit media/gallery content. |
| LinkedIn video | Mixed | Some public video posts downloaded successfully through yt-dlp; other post shapes returned extractor errors. |
| LinkedIn image-only | yt-dlp failed as expected | The URL referred to a post with images rather than downloadable video. The public relay now adds a best-effort public HTML image fallback. |

## YouTube

A successful yt-dlp installation does not guarantee YouTube will serve media to a datacenter IP.

The current public architecture uses:

- yt-dlp nightly/pre-release builds;
- `curl_cffi` support;
- optional cookie files;
- conservative request sleeps.

Possible remaining requirements include:

- fresh account/session state;
- a PO Token provider;
- different extractor client settings;
- non-datacenter egress;
- lower request rates.

Do not blindly rotate accounts or aggressively retry authentication failures. Account cookies are credentials and may be rate-limited or banned by the source platform.

## LinkedIn

There are two different cases:

### Video post

Try yt-dlp first.

If the extractor returns a video, the relay uses it normally.

### Image-only / carousel post

A video-only extractor can legitimately fail because there is no video.

The public relay therefore tries:

1. yt-dlp;
2. gallery-dl;
3. a narrow LinkedIn public-page image fallback.

At the time this document was written, gallery-dl had an open LinkedIn-support pull request rather than a released LinkedIn extractor. The included fallback is intentionally limited to public HTML/Open Graph/CDN media and does not bypass authentication.

Some LinkedIn carousels may expose only one preview image to unauthenticated public HTML. Treat complete multi-image LinkedIn extraction as best-effort until a stable supported extractor is available.

## Instagram / X / Reddit galleries

These are the main reason gallery-dl was added.

The relay treats the post as a media collection rather than assuming it contains exactly one video.

If multiple media files are discovered, the output becomes one ZIP archive with the caption copied into `caption.txt`.

## Telegram preview

A single image/video artifact receives a preview URL that publishes Open Graph metadata pointing at the direct expiring media URL.

The Telegram Bot API allows bots to request large link previews, but the Telegram crawler/client ultimately decides whether a preview is generated for a particular media type and URL.

## How to report a failed link safely

When debugging, capture:

- platform/hostname;
- error classification;
- downloader engine (`yt-dlp`, `gallery-dl`, fallback);
- downloader version;
- whether authentication was enabled (but never cookie values);
- whether the URL is a video, single-image, or carousel post.

Do **not** publish:

- private post URLs;
- session cookies;
- bot tokens;
- real download tokens;
- private user/group IDs.
