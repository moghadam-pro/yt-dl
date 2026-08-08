import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const LINKEDIN_HOSTS = [
  "linkedin.com",
  "licdn.com",
];

function isLinkedInHost(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^www\./u, "");

  return LINKEDIN_HOSTS.some(
    (allowed) =>
      host === allowed ||
      host.endsWith(`.${allowed}`),
  );
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function getMetaContent(html, key) {
  const escaped = key.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );

  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "iu",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "iu",
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return decodeHtml(match[1]);
    }
  }

  return "";
}

function normaliseCandidateUrl(value) {
  const decoded = decodeHtml(value)
    .replaceAll("\\u002F", "/")
    .replaceAll("\\/", "/");

  try {
    const parsed = new URL(decoded);

    if (
      parsed.protocol !== "https:" ||
      !isLinkedInHost(parsed.hostname)
    ) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function extractLinkedInImageUrls(html) {
  const candidates = new Set();

  for (const key of [
    "og:image",
    "og:image:secure_url",
    "twitter:image",
  ]) {
    const value = getMetaContent(html, key);
    const candidate = normaliseCandidateUrl(value);

    if (candidate) {
      candidates.add(candidate);
    }
  }

  const urlPattern =
    /https:\/\/[^"'<>\\\s]+(?:licdn\.com|linkedin\.com)[^"'<>\\\s]*/giu;

  for (const raw of html.match(urlPattern) || []) {
    const candidate = normaliseCandidateUrl(raw);

    if (!candidate) {
      continue;
    }

    const lower = candidate.toLowerCase();

    if (
      !lower.includes("/dms/image/") &&
      !lower.match(/\.(?:jpe?g|png|webp)(?:\?|$)/u)
    ) {
      continue;
    }

    if (
      lower.includes("profile-displayphoto") ||
      lower.includes("company-logo")
    ) {
      continue;
    }

    candidates.add(candidate);
  }

  return [...candidates];
}

function extensionForType(contentType, url) {
  const type = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  const byType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };

  if (byType[type]) {
    return byType[type];
  }

  try {
    const extension = path.extname(
      new URL(url).pathname,
    );

    if (/^\.(?:jpe?g|png|webp|gif)$/iu.test(extension)) {
      return extension.toLowerCase();
    }
  } catch {
    // Ignore URL parsing failures.
  }

  return ".jpg";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url, destination) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "Chrome/140.0 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(
      `LinkedIn image request failed with HTTP ${response.status}.`,
    );
  }

  const finalUrl = new URL(response.url);

  if (!isLinkedInHost(finalUrl.hostname)) {
    throw new Error(
      "LinkedIn image redirected outside an allowed LinkedIn host.",
    );
  }

  await pipeline(
    response.body,
    createWriteStream(destination, {
      mode: 0o600,
    }),
  );

  return response.headers.get("content-type") || "";
}

export async function downloadLinkedInPublicImages({
  url,
  outputDir,
  log = () => {},
}) {
  const parsed = new URL(url);

  if (!isLinkedInHost(parsed.hostname)) {
    return {
      supported: false,
      files: [],
      metadata: null,
    };
  }

  const response = await fetchWithTimeout(
    parsed.toString(),
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "Chrome/140.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.8",
      },
      redirect: "follow",
    },
  );

  if (!response.ok) {
    throw new Error(
      `LinkedIn public page returned HTTP ${response.status}.`,
    );
  }

  const html = await response.text();

  if (html.length > 6_000_000) {
    throw new Error(
      "LinkedIn page exceeded the fallback parser size limit.",
    );
  }

  const title =
    getMetaContent(html, "og:title") ||
    getMetaContent(html, "twitter:title");

  const description =
    getMetaContent(html, "og:description") ||
    getMetaContent(html, "twitter:description");

  const imageUrls = extractLinkedInImageUrls(html);

  await mkdir(outputDir, { recursive: true });

  const files = [];

  for (let index = 0; index < imageUrls.length; index += 1) {
    const imageUrl = imageUrls[index];
    const temporaryName = path.join(
      outputDir,
      `linkedin-image-${String(index + 1).padStart(2, "0")}.tmp`,
    );

    try {
      const contentType = await downloadImage(
        imageUrl,
        temporaryName,
      );

      const extension = extensionForType(
        contentType,
        imageUrl,
      );

      const finalPath = temporaryName.replace(
        /\.tmp$/u,
        extension,
      );

      const { rename } = await import("node:fs/promises");
      await rename(temporaryName, finalPath);
      files.push(finalPath);
    } catch (error) {
      log("linkedin_image_failed", {
        index,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  return {
    supported: true,
    files,
    metadata: {
      extractor: "linkedin-public-html",
      title,
      description,
      webpage_url: parsed.toString(),
    },
  };
}
