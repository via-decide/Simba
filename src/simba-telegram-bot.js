import { loadConfig } from "./config.js";
import { SimbaCommandRouter } from "./simba-command-router.js";
import { SimbaStateEngine } from "./simba-state-engine.js";

const MAX_MESSAGE_LENGTH = 4000;
const CONFLICT_RETRY_DELAY_MS = 5000;   // wait 5s on 409 before retrying
const MAX_CONFLICT_RETRIES    = 12;     // give up after ~60s of conflicts

async function telegramRequest(method, token, body = undefined) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram ${method} ${response.status}: ${text}`);
  }

  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method} returned ok=false`);
  return data.result;
}

/**
 * On startup:
 * 1. Delete any registered webhook (webhooks and long-polling are mutually exclusive)
 * 2. Drop all pending updates so we start with a clean slate
 * 3. Return the highest seen update_id as the initial offset
 */
async function initPolling(token) {
  // Remove any webhook so long-polling works
  try {
    await telegramRequest("deleteWebhook", token, { drop_pending_updates: false });
    console.log("[init] Webhook cleared.");
  } catch (err) {
    console.warn("[init] deleteWebhook failed (non-fatal):", err.message);
  }

  // Drain pending updates and get latest offset
  try {
    const pending = await telegramRequest("getUpdates", token, {
      timeout: 0,
      offset: -1,
      limit: 1
    });
    if (pending.length > 0) {
      const latestId = pending[pending.length - 1].update_id;
      console.log(`[init] Fast-forwarded to update_id ${latestId + 1}`);
      return latestId + 1;
    }
  } catch (err) {
    console.warn("[init] Could not pre-fetch offset (non-fatal):", err.message);
  }

  return 0;
}

function createTelegramMessenger(token) {
  return {
    async sendMessage(chatId, text) {
      const chunks = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, MAX_MESSAGE_LENGTH));
        remaining = remaining.slice(MAX_MESSAGE_LENGTH);
      }
      for (const chunk of chunks) {
        await telegramRequest("sendMessage", token, {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true
        });
      }
    },
    async sendPreviewCard(chatId, { text, buttons }) {
      await telegramRequest("sendMessage", token, {
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: buttons }
      });
    }
  };
}

export async function startTelegramBot() {
  const config = loadConfig();
  const stateEngine = SimbaStateEngine.fromConfig(config);
  const messenger = createTelegramMessenger(config.telegramToken);
  const router = new SimbaCommandRouter({ config, stateEngine, messenger });

  let running = true;
  let conflictRetries = 0;

  const shutdown = (signal) => {
    console.log(`\n[${signal}] Shutting down Simba bot...`);
    running = false;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Simba v2 started.");
  if (config.enforceAdminOnly) {
    console.log(`Admin-only mode: ${config.adminChatIds.length} allowed chat(s)`);
  }
  console.log(`Live push: ${config.allowLivePush} | Live PR: ${config.allowLivePr}`);

  // Clear webhook + get clean offset before starting the poll loop
  let offset = await initPolling(config.telegramToken);
  console.log(`Polling Telegram from offset ${offset}...`);

  while (running) {
    try {
      const updates = await telegramRequest("getUpdates", config.telegramToken, {
        timeout: 25,
        offset,
        allowed_updates: ["message", "callback_query"]
      });

      // Successful poll — reset conflict counter
      conflictRetries = 0;

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message?.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text;
          console.log(`[msg] ${chatId}: ${text.slice(0, 80)}`);
          await router.handleMessage({ chatId, text });
        }

        if (update.callback_query?.data) {
          const chatId = update.callback_query.message.chat.id;
          const data = update.callback_query.data;
          console.log(`[cb] ${chatId}: ${data}`);
          await router.handleCallback({ chatId, data });
          await telegramRequest("answerCallbackQuery", config.telegramToken, {
            callback_query_id: update.callback_query.id,
            text: "Received"
          });
        }
      }
    } catch (error) {
      const is409 = error.message.includes("409");

      if (is409) {
        conflictRetries++;
        console.warn(
          `[poll] 409 Conflict (attempt ${conflictRetries}/${MAX_CONFLICT_RETRIES}) — ` +
          `another instance may be running. Waiting ${CONFLICT_RETRY_DELAY_MS / 1000}s...`
        );

        if (conflictRetries >= MAX_CONFLICT_RETRIES) {
          console.error("[poll] Too many 409 conflicts. Kill other bot instances then restart.");
          console.error("[poll] Run:  pkill -f 'node src/index.js'  then  npm start");
          running = false;
          break;
        }

        await new Promise((r) => setTimeout(r, CONFLICT_RETRY_DELAY_MS));
      } else {
        console.error("[poll error]", error.message);
        await new Promise((r) => setTimeout(r, config.pollIntervalMs));
      }
    }
  }

  console.log("Simba bot stopped.");
}
