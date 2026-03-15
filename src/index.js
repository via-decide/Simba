import { startTelegramBot } from "./simba-telegram-bot.js";

startTelegramBot().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
