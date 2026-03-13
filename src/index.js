import { loadConfig } from "./config.js";
import { formatTelegramResult, parseTaskMessage, runTask } from "./orchestrator.js";

const HELP_TEXT = `Simba Repo Orchestrator Bot

Commands:
/start - show usage
/repos - list your GitHub owner/org repos
/task - send a multiline task in this format:
repo: owner/repo
mode: codex | claude | codex_then_claude
task: what to do
constraints: optional
goal: optional`;

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

async function sendMessage(token, chatId, text) {
  await telegramRequest("sendMessage", token, {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function start() {
  const config = loadConfig();
  let offset = 0;

  console.log("Simba bot started. Polling Telegram...");

  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", config.telegramToken, {
        timeout: 25,
        offset,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;

        const chatId = message.chat.id;
        const text = message.text.trim();

        if (text.startsWith("/start") || text.startsWith("/help")) {
          await sendMessage(config.telegramToken, chatId, HELP_TEXT);
          continue;
        }

        if (text.startsWith("/repos")) {
          const { listOwnerRepos } = await import("./github.js");
          const repos = await listOwnerRepos(config);
          const payload = repos.slice(0, 20).map((repo) => `- ${repo.fullName} (${repo.language})`).join("\n");
          await sendMessage(config.telegramToken, chatId, `Repos for ${config.githubOwner}:\n${payload || "No repos found."}`);
          continue;
        }

        if (text.startsWith("/task")) {
          const rawTask = text.replace(/^\/task\s*/i, "");
          try {
            const task = parseTaskMessage(rawTask);
            const result = await runTask(task, config);
            await sendMessage(config.telegramToken, chatId, formatTelegramResult(result));
          } catch (error) {
            await sendMessage(config.telegramToken, chatId, `Task parse/run error: ${error.message}`);
          }
          continue;
        }

        await sendMessage(config.telegramToken, chatId, "Unknown command. Use /start for help.");
      }
    } catch (error) {
      console.error(error);
      await sleep(config.pollIntervalMs);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

start().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
