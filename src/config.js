const REQUIRED = ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "GITHUB_OWNER"];

export function loadConfig() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const adminChatIds = (process.env.SIMBA_ADMIN_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    githubOwner: process.env.GITHUB_OWNER,
    githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || "https://api.github.com",
    pollIntervalMs: Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000),
    artifactsDir: process.env.ARTIFACTS_DIR || "artifacts",
    githubRepoScanLimit: Number(process.env.GITHUB_REPO_SCAN_LIMIT || 30),
    allowLivePush: process.env.SIMBA_ALLOW_LIVE_PUSH === "true",
    allowLivePr: process.env.SIMBA_ALLOW_LIVE_PR === "true",
    taskTimeoutMs: Number(process.env.SIMBA_TASK_TIMEOUT_MS || 120_000),
    adminChatIds,
    enforceAdminOnly: process.env.SIMBA_ENFORCE_ADMIN_ONLY === "true",
    maxTaskHistory: Number(process.env.SIMBA_MAX_TASK_HISTORY || 50)
  };
}
