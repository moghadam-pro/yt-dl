# Telegram Preview Strategy

The relay deliberately separates **download**, **inline media**, and **link preview** concerns.

## Routes

```text
/d/<token>  -> attachment/download response
/m/<token>  -> inline media stream with Range support
/p/<token>  -> small Open Graph HTML document
```

For a single image or video, the Telegram success message contains the normal `/d/<token>` link but asks Telegram to render the preview from `/p/<token>`.

The `/p/<token>` page references `/m/<token>` in its Open Graph metadata. This lets the direct download route remain an attachment while the preview crawler sees an inline media endpoint.

## Why not use only `/d/<token>`?

A download-oriented `Content-Disposition: attachment` header is useful for users who click the link, but it is not ideal for media preview crawlers.

Keeping `/m/<token>` separate avoids making the download response and preview response fight over incompatible HTTP semantics.

## Why not always call `sendVideo`?

The relay is designed around temporary server-controlled media lifecycle. Sending the full media file to Telegram changes that lifecycle and also introduces Bot API file-size and upload/download behavior that is separate from the public download service.

The Open Graph approach is therefore a best-effort preview layer, not a second permanent media store.

## Failure behavior

Telegram ultimately decides whether a preview is rendered.

If `editMessageText` rejects the requested preview options, the bot retries the exact success message with link previews disabled. The media artifact, download token, and expiration record remain valid.

A preview failure must never turn a successful media download into a failed job.

## Nginx

All three routes must reach the relay application:

```nginx
location ~ ^/(?:d|m|p)/ {
    proxy_pass http://127.0.0.1:8080;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;

    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Do not expose the Node service directly on a public interface. Keep Docker bound to `127.0.0.1:8080` and let Nginx own the public TLS endpoint.
