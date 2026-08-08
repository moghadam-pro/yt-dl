import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import {
  initializeDownloadStore,
  keepDownload,
  registerDownload,
} from "./download-store.mjs";
import {
  classifyDownloadError,
  downloadMedia,
} from "./media-downloader.mjs";

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const ALLOWED_CHAT_ID = Number(
  process.env.ALLOWED_CHAT_ID,
);
const POLL_TIMEOUT_SECONDS = Number(
  process.env.POLL_TIMEOUT_SECONDS || "30",
);
const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || "/data/downloads";
const TEMP_DIR =
  process.env.TEMP_DIR || "/data/tmp";
const MAX_CONCURRENT_DOWNLOADS = Number(
  process.env.MAX_CONCURRENT_DOWNLOADS || "2",
);
const MAX_FILE_SIZE_MB = Number(
  process.env.MAX_FILE_SIZE_MB || "2000",
);

const ALLOWED_PRIVATE_USER_IDS = new Set(
  (process.env.ALLOWED_PRIVATE_USER_IDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isSafeInteger),
);

const ALLOWED_MEDIA_HOSTS = new Set(
  (process.env.ALLOWED_MEDIA_HOSTS || "")
    .split(",")
    .map((value) =>
      value.trim().toLowerCase().replace(/^www\./u, ""),
    )
    .filter(Boolean),
);

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required.");
}

if (!Number.isSafeInteger(ALLOWED_CHAT_ID)) {
  throw new Error(
    "ALLOWED_CHAT_ID must be a valid integer.",
  );
}

if (
  !Number.isInteger(MAX_CONCURRENT_DOWNLOADS) ||
  MAX_CONCURRENT_DOWNLOADS < 1 ||
  MAX_CONCURRENT_DOWNLOADS > 4
) {
  throw new Error(
    "MAX_CONCURRENT_DOWNLOADS must be between 1 and 4.",
  );
}

const telegramBaseUrl =
  `https://api.telegram.org/bot${BOT_TOKEN}`;

const queue = [];
let activeDownloads = 0;
let updateOffset = 0;

function log(event, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...data,
  }));
}

function normaliseError(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

async function telegram(method, payload = {}) {
  const response = await fetch(
    `${telegramBaseUrl}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram ${method} failed: ${JSON.stringify(result)}`,
    );
  }

  return result.result;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isAllowedMediaUrl(value) {
  if (!isValidHttpUrl(value)) {
    return false;
  }

  try {
    const hostname = new URL(value)
      .hostname
      .toLowerCase()
      .replace(/^www\./u, "");

    for (const allowedHost of ALLOWED_MEDIA_HOSTS) {
      if (
        hostname === allowedHost ||
        hostname.endsWith(`.${allowedHost}`)
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function isAuthorizedMessage(message) {
  if (!message?.chat || !message?.from) {
    return false;
  }

  if (message.chat.type === "private") {
    return ALLOWED_PRIVATE_USER_IDS.has(
      message.from.id,
    );
  }

  return message.chat.id === ALLOWED_CHAT_ID;
}

function extractUrls(message) {
  const values = [];
  const text = message.text || message.caption || "";
  const entities = [
    ...(message.entities || []),
    ...(message.caption_entities || []),
  ];

  for (const entity of entities) {
    if (entity.type === "text_link" && entity.url) {
      values.push(entity.url);
      continue;
    }

    if (entity.type === "url") {
      values.push(
        text.slice(
          entity.offset,
          entity.offset + entity.length,
        ),
      );
    }
  }

  const plainUrls = text.match(
    /https?:\/\/[^\s<>()]+/giu,
  ) || [];

  values.push(...plainUrls);

  return [...new Set(values)]
    .map((value) =>
      value.replace(/[),.;!?]+$/u, ""),
    )
    .filter(isAllowedMediaUrl);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function sendStatus(job, text) {
  const message = await telegram("sendMessage", {
    chat_id: job.chatId,
    text,
    reply_parameters: {
      message_id: job.sourceMessageId,
      allow_sending_without_reply: true,
    },
    link_preview_options: {
      is_disabled: true,
    },
  });

  job.statusMessageId = message.message_id;
}

async function editStatus(
  job,
  text,
  replyMarkup = null,
  previewUrl = null,
) {
  const payload = {
    chat_id: job.chatId,
    message_id: job.statusMessageId,
    text,
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  payload.link_preview_options = previewUrl
    ? {
        is_disabled: false,
        url: previewUrl,
        prefer_large_media: true,
        show_above_text: true,
      }
    : { is_disabled: true };

  await telegram("editMessageText", payload);
}

function splitText(value, maxLength = 3600) {
  const text = String(value || "").trim();

  if (!text) {
    return [];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(
      "\n",
      maxLength,
    );

    if (splitAt < maxLength * 0.6) {
      splitAt = maxLength;
    }

    chunks.push(
      remaining.slice(0, splitAt).trim(),
    );
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendCaptionContinuation(
  job,
  chunks,
  downloadUrl,
) {
  for (let index = 0; index < chunks.length; index += 1) {
    await telegram("sendMessage", {
      chat_id: job.chatId,
      text: [
        index === 0
          ? "📝 ادامه کپشن:"
          : "📝 ادامه:",
        chunks[index],
        "",
        `⬇️ ${downloadUrl}`,
      ].join("\n"),
      reply_parameters: {
        message_id: job.sourceMessageId,
        allow_sending_without_reply: true,
      },
      link_preview_options: {
        is_disabled: true,
      },
    });
  }
}

function platformLabel(metadata, url) {
  if (metadata?.extractor) {
    return metadata.extractor;
  }

  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "media";
  }
}

function errorMessageFor(code, url) {
  const platform = platformLabel(null, url);

  const messages = {
    authentication_required:
      "این سرویس برای این لینک احراز هویت یا Cookie بیشتری می‌خواهد.",
    extractor_unsupported:
      "ساختار این پست فعلاً توسط موتورهای دانلود قابل استخراج نیست.",
    no_video_format:
      "برای این لینک ویدیوی قابل دانلود پیدا نشد.",
    access_blocked:
      "سرویس مقصد درخواست سرور را مسدود کرده است.",
    size_limit:
      "حجم فایل یا مجموعه از سقف مجاز سرور بیشتر است.",
    download_failed:
      "رسانه قابل دانلودی برای این لینک پیدا نشد.",
  };

  return [
    "❌ دانلود ناموفق بود.",
    "",
    `🌐 ${platform}`,
    `⚠️ ${messages[code] || messages.download_failed}`,
  ].join("\n");
}

function buildCompletion({
  result,
  access,
}) {
  const metadata = result.metadata || {};
  const title = String(metadata.title || "").trim();
  const uploader = String(metadata.uploader || "").trim();
  const description = String(
    metadata.description || "",
  ).trim();
  const originalUrl =
    metadata.webpage_url || "";

  const lines = [
    result.isArchive
      ? "✅ مجموعه رسانه آماده شد."
      : "✅ رسانه با بهترین کیفیت موجود آماده شد.",
    "",
    `📄 ${result.artifactName}`,
    `📦 ${formatBytes(result.artifactSize)}`,
    `🧩 ${result.mediaCount} فایل رسانه‌ای`,
  ];

  if (title) {
    lines.push("", `📌 ${title}`);
  }

  if (uploader) {
    lines.push(`👤 ${uploader}`);
  }

  if (originalUrl) {
    lines.push(`🔗 لینک اصلی: ${originalUrl}`);
  }

  const captionBudget = 1500;
  const inlineCaption = description.slice(
    0,
    captionBudget,
  );

  if (inlineCaption) {
    lines.push(
      "",
      "📝 کپشن:",
      inlineCaption +
        (description.length > captionBudget
          ? "…"
          : ""),
    );
  }

  lines.push(
    "",
    "⬇️ لینک دانلود:",
    access.downloadUrl,
    "",
    "⚠️ این لینک پس از ۲۴ ساعت منقضی می‌شود، مگر اینکه توسط کاربر مجاز دائمی شود.",
  );

  const remainingCaption =
    description.length > captionBudget
      ? description.slice(captionBudget)
      : "";

  return {
    text: lines.join("\n"),
    remainingCaption,
  };
}

async function processJob(job) {
  try {
    await editStatus(
      job,
      "⬇️ در حال دریافت رسانه با بهترین کیفیت موجود…",
    );

    log("download_started", {
      job_id: job.id,
      source_message_id: job.sourceMessageId,
      active_downloads: activeDownloads,
      queue_length: queue.length,
    });

    const result = await downloadMedia({
      url: job.url,
      jobId: job.id,
      downloadRoot: DOWNLOAD_DIR,
      tempRoot: TEMP_DIR,
      log,
    });

    const access = await registerDownload({
      filePath: result.artifactPath,
      fileName: result.artifactName,
      fileSize: result.artifactSize,
      mimeType: result.mimeType,
      previewKind: result.previewKind,
      title: result.metadata?.title || "",
    });

    const completion = buildCompletion({
      result,
      access,
    });

    const replyMarkup = access.downloadUrl
      ? {
          inline_keyboard: [
            [
              {
                text: "♾️ این لینک حذف نشود",
                callback_data: `keep:${access.token}`,
              },
            ],
          ],
        }
      : null;

    await editStatus(
      job,
      completion.text,
      replyMarkup,
      access.previewUrl,
    );

    if (completion.remainingCaption) {
      await sendCaptionContinuation(
        job,
        splitText(completion.remainingCaption),
        access.downloadUrl,
      );
    }

    log("download_completed", {
      job_id: job.id,
      file_name: result.artifactName,
      file_size: result.artifactSize,
      media_count: result.mediaCount,
      archive: result.isArchive,
      expires_at: new Date(
        access.expiresAt,
      ).toISOString(),
    });
  } catch (error) {
    const code =
      error?.code ||
      classifyDownloadError(
        normaliseError(error),
      );

    log("download_failed", {
      job_id: job.id,
      error_type: code,
      source_host: (() => {
        try {
          return new URL(job.url).hostname;
        } catch {
          return null;
        }
      })(),
      error: normaliseError(error),
      attempts: error?.attempts || null,
    });

    await rm(
      `${DOWNLOAD_DIR}/${job.id}`,
      { recursive: true, force: true },
    );
    await rm(
      `${TEMP_DIR}/${job.id}`,
      { recursive: true, force: true },
    );

    await editStatus(
      job,
      errorMessageFor(code, job.url),
    );
  }
}

function pumpQueue() {
  while (
    activeDownloads < MAX_CONCURRENT_DOWNLOADS &&
    queue.length > 0
  ) {
    const job = queue.shift();
    activeDownloads += 1;

    log("job_started_from_queue", {
      job_id: job.id,
      active_downloads: activeDownloads,
      queue_length: queue.length,
    });

    processJob(job)
      .catch((error) => {
        log("job_process_unhandled", {
          job_id: job.id,
          error: normaliseError(error),
        });
      })
      .finally(() => {
        activeDownloads -= 1;

        log("download_slot_released", {
          job_id: job.id,
          active_downloads: activeDownloads,
          queue_length: queue.length,
        });

        pumpQueue();
      });
  }
}

async function handleCallbackQuery(callbackQuery) {
  const callbackId = callbackQuery?.id;
  const userId = callbackQuery?.from?.id;
  const data = callbackQuery?.data || "";

  if (!data.startsWith("keep:")) {
    return;
  }

  if (!ALLOWED_PRIVATE_USER_IDS.has(userId)) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "این گزینه فقط برای کاربران مجاز فعال است.",
      show_alert: true,
    });
    return;
  }

  const token = data.slice("keep:".length);
  const result = await keepDownload(
    token,
    userId,
  );

  if (!result.ok) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text:
        result.reason === "expired"
          ? "این فایل قبلاً منقضی شده است."
          : "فایل پیدا نشد.",
      show_alert: true,
    });
    return;
  }

  await telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text:
      result.alreadyPersistent
        ? "این فایل از قبل دائمی شده بود."
        : "فایل دائمی شد و خودکار حذف نمی‌شود.",
  });

  const message = callbackQuery.message;

  if (!message?.text) {
    return;
  }

  let updatedText = message.text.replace(
    /⚠️ این لینک پس از ۲۴ ساعت منقضی می‌شود، مگر اینکه توسط کاربر مجاز دائمی شود\.?/u,
    "♾️ این فایل دائمی شده و دیگر به‌صورت خودکار حذف نمی‌شود.",
  );

  if (!updatedText.includes("♾️ این فایل دائمی شده")) {
    updatedText +=
      "\n\n♾️ این فایل دائمی شده و دیگر به‌صورت خودکار حذف نمی‌شود.";
  }

  await telegram("editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: updatedText,
    link_preview_options: {
      is_disabled: false,
      prefer_large_media: true,
      show_above_text: true,
    },
    reply_markup: {
      inline_keyboard: [],
    },
  });

  log("persistent_callback_completed", {
    user_id: userId,
    already_persistent:
      result.alreadyPersistent,
  });
}

async function handleMessage(message) {
  if (
    !message ||
    message.from?.is_bot ||
    !message.chat
  ) {
    return;
  }

  if (!isAuthorizedMessage(message)) {
    log("unauthorised_message_ignored", {
      chat_id: message.chat.id,
      user_id: message.from?.id || null,
      chat_type: message.chat.type,
      message_id: message.message_id,
    });
    return;
  }

  const urls = extractUrls(message);

  if (urls.length === 0) {
    return;
  }

  const url = urls[0];
  const job = {
    id: randomUUID(),
    url,
    chatId: message.chat.id,
    userId: message.from.id,
    sourceMessageId: message.message_id,
    statusMessageId: null,
  };

  await sendStatus(
    job,
    "⏳ لینک دریافت شد و در صف پردازش قرار گرفت.",
  );

  queue.push(job);

  log("job_queued", {
    job_id: job.id,
    chat_id: job.chatId,
    source_message_id: job.sourceMessageId,
    active_downloads: activeDownloads,
    queue_length: queue.length,
  });

  pumpQueue();
}

async function start() {
  await mkdir(DOWNLOAD_DIR, {
    recursive: true,
  });
  await mkdir(TEMP_DIR, {
    recursive: true,
  });

  await initializeDownloadStore({ log });

  await telegram("deleteWebhook", {
    drop_pending_updates: false,
  });

  const bot = await telegram("getMe");

  log("bot_started", {
    bot_id: bot.id,
    bot_username: bot.username,
    allowed_chat_id: ALLOWED_CHAT_ID,
    allowed_private_users:
      ALLOWED_PRIVATE_USER_IDS.size,
    whitelist_hosts: ALLOWED_MEDIA_HOSTS.size,
    quality_mode: "best_available",
    max_concurrent_downloads:
      MAX_CONCURRENT_DOWNLOADS,
    max_file_size_mb: MAX_FILE_SIZE_MB,
  });

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: updateOffset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: [
          "message",
          "callback_query",
        ],
      });

      for (const update of updates) {
        updateOffset = Math.max(
          updateOffset,
          update.update_id + 1,
        );

        if (update.callback_query) {
          await handleCallbackQuery(
            update.callback_query,
          );
        } else if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      log("poll_failed", {
        error: normaliseError(error),
      });

      await new Promise((resolve) =>
        setTimeout(resolve, 3000),
      );
    }
  }
}

start().catch((error) => {
  log("fatal_error", {
    error: normaliseError(error),
  });
  process.exit(1);
});
