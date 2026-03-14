import { loadConfig } from "./config.js";
import { SimbaCommandRouter } from "./simba-command-router.js";
import { SimbaStateEngine } from "./simba-state-engine.js";

const MAX_MESSAGE_LENGTH = 4000;

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

function createTelegramMessenger(token) {
  return {
    async sendMessage(chatId, text) {
      // Telegram has a 4096 char limit per message; split if needed
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

  let offset = 0;
  let running = true;

  const shutdown = (signal) => {
    console.log(`\n[${signal}] Shutting down Simba bot...`);
    running = false;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Simba v2 started. Polling Telegram...");
  if (config.enforceAdminOnly) {
    console.log(`Admin-only mode: ${config.adminChatIds.length} allowed chat(s)`);
  }
  console.log(`Live push: ${config.allowLivePush} | Live PR: ${config.allowLivePr}`);

  while (running) {
    try {
      const updates = await telegramRequest("getUpdates", config.telegramToken, {
        timeout: 25,
        offset,
        allowed_updates: ["message", "callback_query"]
      });

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
      console.error("[poll error]", error.message);
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
  }

  console.log("Simba bot stopped.");
}
