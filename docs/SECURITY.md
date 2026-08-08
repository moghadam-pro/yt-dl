# Security Notes

This relay executes third-party downloader tools against URLs received from Telegram. Treat it as an internet-facing service even if the HTTP application itself is bound to localhost.

## Threat model

The main risks are:

- leaking Telegram bot credentials;
- leaking browser/session cookies;
- allowing arbitrary URLs to reach downloader tools;
- exhausting CPU, RAM, disk, or process count;
- exposing private/internal network destinations through URL fetching;
- serving predictable or permanent download URLs;
- accidentally making all group members administrators;
- leaving expired files behind;
- publishing production configuration in a public repository.

## Required practices

### Never commit secrets

Do not commit:

- `.env`;
- `cookies.txt`;
- Telegram bot tokens;
- real Telegram group/user IDs;
- TLS private keys;
- server SSH keys;
- production download tokens;
- private URLs or logs containing sensitive URLs.

Use `.env.example` with placeholders.

### Restrict Telegram access

Use:

- one explicit group ID for group access;
- an explicit allowlist of user IDs for private-chat access;
- the same or a narrower trusted-user list for administrative actions such as persistent storage.

Do not infer authorization from usernames. Numeric Telegram IDs are the stable identity value.

### Restrict URL hosts

Only pass URLs whose host matches `ALLOWED_MEDIA_HOSTS`.

The implementation compares normalized hostnames, not arbitrary substring matches.

Example:

```text
allowed: youtube.com
accepted: www.youtube.com
accepted: m.youtube.com
rejected: youtube.com.attacker.example
```

### SSRF considerations

A hostname whitelist significantly reduces SSRF exposure, but production deployments should also resolve outbound destinations and reject:

- loopback ranges;
- RFC1918 private ranges;
- link-local ranges;
- cloud metadata addresses such as `169.254.169.254`;
- internal DNS zones.

Redirects should be revalidated as well.

The LinkedIn public fallback in this repository only accepts final media URLs hosted on LinkedIn/LinkedIn CDN hostnames.

### Cookie handling

Source cookie files should be:

```text
owner: service account
mode: 0600
```

Mount the cookie directory read-only into the container.

The downloader copies the needed cookie file into a per-job temporary directory. The temporary copy is writable and is removed when the job finishes.

Never print cookie contents in logs.

### Docker isolation

The reference Compose file uses:

- non-root UID;
- read-only root filesystem;
- dropped capabilities;
- `no-new-privileges`;
- PID limit;
- CPU limit;
- memory/swap limits;
- tmpfs for `/tmp`;
- explicit writable volumes only.

### HTTP exposure

Publish the application port only on localhost:

```text
127.0.0.1:8080:8080
```

Expose the service through Nginx or another reverse proxy with HTTPS.

### Random tokens

Download URLs use 32 random bytes encoded as base64url.

Never use sequential IDs, filenames, Telegram message IDs, or timestamps as public download tokens.

### Expiry and persistence

Non-persistent records expire automatically.

Persistent records are intentionally excluded from timed cleanup. Add monitoring or quotas before offering persistence to many users.

### Logging

Structured logs are useful, but avoid storing secret values.

Consider redacting or hashing source URLs in privacy-sensitive deployments.

## Additional hardening recommended for public deployments

The reference project is intentionally small. Before exposing it to untrusted users, consider adding:

- DNS/IP validation before every outbound request and after redirects;
- per-user rate limiting;
- maximum URL length;
- maximum queue length;
- download wall-clock timeout;
- maximum decompressed/ZIP size;
- disk free-space guard;
- malware scanning for downloaded files;
- SQLite/PostgreSQL state rather than JSON;
- audit log for persistent files;
- administrator cleanup commands;
- automatic removal of orphaned job directories;
- read-only dedicated filesystem or object storage policies.

## Responsible use

Use the relay only for media you are authorized to access and download. Source-site terms, copyright rules, privacy rules, and local law still apply. The repository does not include DRM bypass logic or private-service credential harvesting.
