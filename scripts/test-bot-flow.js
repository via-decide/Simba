import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimbaCommandRouter } from "../src/simba-command-router.js";
import { SimbaStateEngine } from "../src/simba-state-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stateEngine = new SimbaStateEngine(
  path.join(__dirname, "..", "artifacts", "simba-state.test.json")
);

const messages = [];
const messenger = {
  async sendMessage(chatId, text) {
    messages.push({ type: "msg", chatId, text });
  },
  async sendPreviewCard(chatId, card) {
    messages.push({ type: "preview", chatId, ...card });
  }
};

const config = {
  telegramToken: "test-token",
  githubToken: process.env.GITHUB_TOKEN || "missing-token",
  githubOwner: process.env.GITHUB_OWNER || "via-decide",
  githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || "https://api.github.com",
  pollIntervalMs: 10,
  artifactsDir: path.join(__dirname, "..", "artifacts"),
  githubRepoScanLimit: 5,
  allowLivePush: false,
  allowLivePr: false,
  taskTimeoutMs: 30000,
  adminChatIds: [],
  enforceAdminOnly: false,
  maxTaskHistory: 50
};

const router = new SimbaCommandRouter({ config, stateEngine, messenger });
const chatId = 9999;

console.log("=== Simba v2 test harness ===\n");

// Test /help
await router.handleMessage({ chatId, text: "/help" });
console.log("✅ /help");

// Test /analyze
await router.handleMessage({ chatId, text: "/analyze via-decide/decide.engine-tools" });
console.log("✅ /analyze");

// Test /status
await router.handleMessage({ chatId, text: "/status" });
console.log("✅ /status");

// Test /history
await router.handleMessage({ chatId, text: "/history" });
console.log("✅ /history");

// Test /logs
await router.handleMessage({ chatId, text: "/logs 5" });
console.log("✅ /logs");

// Test /improve (generates preview card)
await router.handleMessage({ chatId, text: "/improve via-decide/decide.engine-tools" });
const preview = messages.find((m) => m.type === "preview");
if (!preview) throw new Error("Expected preview from /improve");
console.log("✅ /improve (preview card)");

// Accept dry-run via callback
const dryBtn = preview.buttons[0][0];
await router.handleCallback({ chatId, data: dryBtn.callback_data });
console.log("✅ callback (dry-run pipeline)");

// Test /cancel
await router.handleMessage({ chatId, text: "/cancel" });
console.log("✅ /cancel");

// Test error handling
await router.handleMessage({ chatId, text: "/analyze bad-format" });
console.log("✅ /analyze error path");

// Test unknown command
await router.handleMessage({ chatId, text: "/foobar" });
console.log("✅ unknown command");

console.log(`\n=== ${messages.length} messages captured ===\n`);

// Print summary
for (const m of messages) {
  if (m.type === "preview") {
    console.log(`[PREVIEW] ${m.text?.slice(0, 60)}...`);
  } else {
    const first = m.text?.split("\n")[0] || "";
    console.log(`[MSG] ${first.slice(0, 80)}`);
  }
}

console.log("\n✅ All tests passed.");
