import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { downloadLinkedInPublicImages } from "./linkedin-fallback.mjs";

const MAX_FILE_SIZE_MB = Number(
  process.env.MAX_FILE_SIZE_MB || "2000",
);

const YOUTUBE_COOKIE_FILE =
  process.env.YOUTUBE_COOKIE_FILE?.trim() || "";

const INSTAGRAM_COOKIE_FILE =
  process.env.INSTAGRAM_COOKIE_FILE?.trim() || "";

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".webm",
  ".mkv",
  ".mov",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".mp3",
  ".m4a",
  ".opus",
  ".wav",
]);

function normaliseError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function cookieSourceForUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl)
      .hostname
      .toLowerCase()
      .replace(/^www\./u, "");

    const isYouTube =
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com");

    if (
      isYouTube &&
      YOUTUBE_COOKIE_FILE
    ) {
      return YOUTUBE_COOKIE_FILE;
    }

    const isInstagram =
      hostname === "instagram.com" ||
      hostname.endsWith(".instagram.com");

    if (
      isInstagram &&
      INSTAGRAM_COOKIE_FILE
    ) {
      return INSTAGRAM_COOKIE_FILE;
    }
  } catch {
    return null;
  }

  return null;
}

async function copyCookieForJob(url, tempDir) {
  const source = cookieSourceForUrl(url);

  if (!source) {
    return null;
  }

  try {
    const destination = path.join(
      tempDir,
      "cookies.txt",
    );

    await copyFile(source, destination);
    await chmod(destination, 0o600);
    return destination;
  } catch {
    return null;
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

async function walkFiles(directory) {
  const files = [];
  const entries = await readdir(
    directory,
    { withFileTypes: true },
  );

  for (const entry of entries) {
    const fullPath = path.join(
      directory,
      entry.name,
    );

    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.has(
    path.extname(filePath).toLowerCase(),
  );
}

function metadataFromInfo(info, sourceUrl) {
  if (!info || typeof info !== "object") {
    return null;
  }

  return {
    title:
      info.title ||
      info.fulltitle ||
      "",
    description:
      info.description ||
      info.comment ||
      "",
    uploader:
      info.creator ||
      info.uploader ||
      info.channel ||
      info.artist ||
      "",
    extractor:
      info.extractor_key ||
      info.extractor ||
      "",
    webpage_url:
      info.webpage_url ||
      info.original_url ||
      sourceUrl,
  };
}

async function extractMetadata({
  url,
  cookieFile,
}) {
  const args = [
    "--no-playlist",
    "--skip-download",
    "--ignore-no-formats-error",
    "--js-runtimes",
    "node",
    "--no-warnings",
    "--dump-single-json",
  ];

  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

  args.push(url);

  const result = await runProcess(
    "yt-dlp",
    args,
  );

  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  try {
    return metadataFromInfo(
      JSON.parse(result.stdout),
      url,
    );
  } catch {
    return null;
  }
}

async function runYtDlp({
  url,
  outputDir,
  tempDir,
  cookieFile,
}) {
  const outputTemplate = path.join(
    outputDir,
    "%(title).120B-%(id)s.%(ext)s",
  );

  const args = [
    "--no-playlist",
    "--no-cache-dir",
    "--js-runtimes",
    "node",
    "--newline",
    "--restrict-filenames",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--max-filesize",
    `${MAX_FILE_SIZE_MB}M`,
    "--format",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--write-info-json",
    "--sleep-requests",
    "1",
    "--sleep-interval",
    "2",
    "--max-sleep-interval",
    "5",
    "--paths",
    `temp:${tempDir}`,
    "--output",
    outputTemplate,
  ];

  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

  args.push(url);

  return runProcess("yt-dlp", args);
}

async function runGalleryDl({
  url,
  outputDir,
  cookieFile,
}) {
  const galleryDir = path.join(
    outputDir,
    "gallery",
  );

  await mkdir(galleryDir, {
    recursive: true,
  });

  const args = [
    "--config-ignore",
    "--dest",
    galleryDir,
    "--no-mtime",
    "--filesize-max",
    `${MAX_FILE_SIZE_MB}M`,
  ];

  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

  args.push(url);

  return runProcess("gallery-dl", args);
}

function classifyMime(filePath) {
  const extension = path.extname(filePath)
    .toLowerCase();

  const map = {
    ".mp4": ["video/mp4", "video"],
    ".m4v": ["video/x-m4v", "video"],
    ".webm": ["video/webm", "video"],
    ".mkv": ["video/x-matroska", "video"],
    ".mov": ["video/quicktime", "video"],
    ".jpg": ["image/jpeg", "image"],
    ".jpeg": ["image/jpeg", "image"],
    ".png": ["image/png", "image"],
    ".webp": ["image/webp", "image"],
    ".gif": ["image/gif", "image"],
    ".mp3": ["audio/mpeg", "file"],
    ".m4a": ["audio/mp4", "file"],
    ".opus": ["audio/opus", "file"],
    ".wav": ["audio/wav", "file"],
  };

  return map[extension] || [
    "application/octet-stream",
    "file",
  ];
}

async function removeInfoJsonFiles(outputDir) {
  const files = await walkFiles(outputDir);

  for (const filePath of files) {
    if (filePath.endsWith(".info.json")) {
      await rm(filePath, { force: true });
    }
  }
}

async function findInfoMetadata(outputDir, sourceUrl) {
  const files = await walkFiles(outputDir);
  const infoFile = files.find(
    (filePath) => filePath.endsWith(".info.json"),
  );

  if (!infoFile) {
    return null;
  }

  try {
    const info = JSON.parse(
      await readFile(infoFile, "utf8"),
    );

    return metadataFromInfo(info, sourceUrl);
  } catch {
    return null;
  }
}

async function totalSize(files) {
  let size = 0;

  for (const filePath of files) {
    size += (await stat(filePath)).size;
  }

  return size;
}

function safeArchiveName(metadata) {
  const raw =
    metadata?.title ||
    "media-bundle";

  const safe = raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);

  return `${safe || "media-bundle"}.zip`;
}

async function createArchive({
  outputDir,
  metadata,
}) {
  const caption = String(
    metadata?.description || "",
  ).trim();

  if (caption) {
    await writeFile(
      path.join(outputDir, "caption.txt"),
      `${caption}\n`,
      { mode: 0o600 },
    );
  }

  const archiveName = safeArchiveName(metadata);
  const archivePath = path.join(
    outputDir,
    archiveName,
  );

  const result = await runProcess(
    "zip",
    [
      "-q",
      "-r",
      archiveName,
      ".",
      "-x",
      "*.info.json",
      "-x",
      archiveName,
    ],
    { cwd: outputDir },
  );

  if (result.code !== 0) {
    throw new Error(
      `zip failed: ${result.stderr.trim() || "unknown error"}`,
    );
  }

  return archivePath;
}

export function classifyDownloadError(errorText) {
  const text = String(errorText || "").toLowerCase();

  if (
    text.includes("sign in to confirm") ||
    text.includes("login required") ||
    text.includes("authentication")
  ) {
    return "authentication_required";
  }

  if (
    text.includes("unable to extract") ||
    text.includes("no suitable extractor")
  ) {
    return "extractor_unsupported";
  }

  if (
    text.includes("no video formats") ||
    text.includes("requested format is not available")
  ) {
    return "no_video_format";
  }

  if (
    text.includes("403") ||
    text.includes("forbidden")
  ) {
    return "access_blocked";
  }

  return "download_failed";
}

export async function downloadMedia({
  url,
  jobId,
  downloadRoot,
  tempRoot,
  log = () => {},
}) {
  const outputDir = path.join(
    downloadRoot,
    jobId,
  );

  const tempDir = path.join(
    tempRoot,
    jobId,
  );

  await mkdir(outputDir, {
    recursive: true,
  });
  await mkdir(tempDir, {
    recursive: true,
  });

  const cookieFile = await copyCookieForJob(
    url,
    tempDir,
  );

  log("download_configuration", {
    job_id: jobId,
    source_host: new URL(url).hostname,
    cookie_enabled: Boolean(cookieFile),
  });

  let metadata = await extractMetadata({
    url,
    cookieFile,
  });

  const attempts = [];

  const ytResult = await runYtDlp({
    url,
    outputDir,
    tempDir,
    cookieFile,
  });

  attempts.push({
    engine: "yt-dlp",
    code: ytResult.code,
    error: ytResult.stderr.trim(),
  });

  if (!metadata) {
    metadata = await findInfoMetadata(
      outputDir,
      url,
    );
  }

  let files = (await walkFiles(outputDir))
    .filter(isMediaFile);

  if (files.length === 0) {
    const galleryResult = await runGalleryDl({
      url,
      outputDir,
      cookieFile,
    });

    attempts.push({
      engine: "gallery-dl",
      code: galleryResult.code,
      error: galleryResult.stderr.trim(),
    });

    files = (await walkFiles(outputDir))
      .filter(isMediaFile);
  }

  if (files.length === 0) {
    try {
      const linkedInResult =
        await downloadLinkedInPublicImages({
          url,
          outputDir,
          log,
        });

      if (linkedInResult.supported) {
        attempts.push({
          engine: "linkedin-public-html",
          code:
            linkedInResult.files.length > 0
              ? 0
              : 1,
          error:
            linkedInResult.files.length > 0
              ? ""
              : "No public post images discovered",
        });

        files = linkedInResult.files;

        if (!metadata && linkedInResult.metadata) {
          metadata = linkedInResult.metadata;
        }
      }
    } catch (error) {
      attempts.push({
        engine: "linkedin-public-html",
        code: 1,
        error: normaliseError(error),
      });
    }
  }

  await removeInfoJsonFiles(outputDir);

  files = (await walkFiles(outputDir))
    .filter(isMediaFile);

  if (files.length === 0) {
    const combinedError = attempts
      .map((attempt) =>
        `${attempt.engine}: ${attempt.error || `exit ${attempt.code}`}`,
      )
      .join(" | ");

    const error = new Error(
      combinedError || "No downloadable media found.",
    );

    error.code = classifyDownloadError(combinedError);
    error.attempts = attempts;

    await rm(outputDir, {
      recursive: true,
      force: true,
    });

    throw error;
  }

  const aggregateSize = await totalSize(files);
  const maxBytes =
    MAX_FILE_SIZE_MB * 1024 * 1024;

  if (aggregateSize > maxBytes) {
    await rm(outputDir, {
      recursive: true,
      force: true,
    });

    const error = new Error(
      `Media bundle exceeds ${MAX_FILE_SIZE_MB} MB.`,
    );
    error.code = "size_limit";
    throw error;
  }

  let artifactPath;
  let previewKind = "file";
  let mimeType = "application/octet-stream";
  let isArchive = false;

  if (files.length > 1) {
    artifactPath = await createArchive({
      outputDir,
      metadata,
    });
    previewKind = "file";
    mimeType = "application/zip";
    isArchive = true;
  } else {
    [artifactPath] = files;
    [mimeType, previewKind] = classifyMime(
      artifactPath,
    );
  }

  const artifactStat = await stat(artifactPath);

  await rm(tempDir, {
    recursive: true,
    force: true,
  });

  return {
    artifactPath,
    artifactName: path.basename(artifactPath),
    artifactSize: artifactStat.size,
    mimeType,
    previewKind,
    isArchive,
    mediaCount: files.length,
    metadata: metadata || {
      title: "",
      description: "",
      uploader: "",
      extractor: "",
      webpage_url: url,
    },
    attempts,
  };
}
