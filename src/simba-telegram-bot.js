import { loadConfig } from "./config.js";
import { SimbaCommandRouter } from "./simba-command-router.js";
import { SimbaStateEngine } from "./simba-state-engine.js";

async function telegramRequest(method, token, body = undefined) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API ${method} failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} returned ok=false`);
  }

  return data.result;
}

function createTelegramMessenger(token) {
  return {
    async sendMessage(chatId, text) {
      await telegramRequest("sendMessage", token, {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      });
    },
    async sendPreviewCard(chatId, { text, buttons }) {
      await telegramRequest("sendMessage", token, {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: buttons
        }
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
  console.log("Simba bot started. Polling Telegram...");

  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", config.telegramToken, {
        timeout: 25,
        offset,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message?.text) {
          await router.handleMessage({
            chatId: update.message.chat.id,
            text: update.message.text
          });
        }

        if (update.callback_query?.data) {
          await router.handleCallback({
            chatId: update.callback_query.message.chat.id,
            data: update.callback_query.data
          });

          await telegramRequest("answerCallbackQuery", config.telegramToken, {
            callback_query_id: update.callback_query.id,
            text: "Simba received your choice"
          });
        }
      }
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
}
