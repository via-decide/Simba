import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimbaCommandRouter } from "../src/simba-command-router.js";
import { SimbaStateEngine } from "../src/simba-state-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stateEngine = new SimbaStateEngine(path.join(__dirname, "..", "artifacts", "simba-state.test.json"));

const messages = [];
const messenger = {
  async sendMessage(chatId, text) {
    messages.push({ type: "message", chatId, text });
  },
  async sendPreviewCard(chatId, card) {
    messages.push({ type: "preview", chatId, ...card });
  }
};

const config = {
  telegramToken: "test-token",
  githubToken: process.env.GITHUB_TOKEN || "missing-token",
  githubOwner: process.env.GITHUB_OWNER || "simba-owner",
  githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || "https://api.github.com",
  pollIntervalMs: 10,
  artifactsDir: path.join(__dirname, "..", "artifacts"),
  githubRepoScanLimit: 5,
  allowLivePush: false,
  allowLivePr: false
};

const router = new SimbaCommandRouter({ config, stateEngine, messenger });
const chatId = 1001;

await router.handleMessage({ chatId, text: "/start" });
await router.handleMessage({ chatId, text: "/analyze octocat/Hello-World" });
await router.handleMessage({ chatId, text: "/improve octocat/Hello-World" });

const preview = messages.find((entry) => entry.type === "preview");
if (!preview) {
  throw new Error("Expected preview card from /improve.");
}

const dryRunButton = preview.buttons[0][0];
await router.handleCallback({ chatId, data: dryRunButton.callback_data });
await router.handleMessage({ chatId, text: "/status" });
await router.handleMessage({ chatId, text: "/analyze invalid-repo-format" });

console.log("=== Local bot harness output ===");
for (const entry of messages) {
  if (entry.type === "preview") {
    console.log(`PREVIEW: ${entry.text}`);
    console.log(`BUTTONS: ${entry.buttons.flat().map((b) => b.text).join(", ")}`);
    continue;
  }
  console.log(`MESSAGE: ${entry.text}`);
}
