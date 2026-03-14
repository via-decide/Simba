const required = ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "GITHUB_OWNER"];

export function loadConfig() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    githubOwner: process.env.GITHUB_OWNER,
    githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || "https://api.github.com",
    pollIntervalMs: Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000),
    artifactsDir: process.env.ARTIFACTS_DIR || "artifacts",
    githubRepoScanLimit: Number(process.env.GITHUB_REPO_SCAN_LIMIT || 30),
    allowLivePush: process.env.SIMBA_ALLOW_LIVE_PUSH === "true",
    allowLivePr: process.env.SIMBA_ALLOW_LIVE_PR === "true"
  };
}
