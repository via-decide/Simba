import fs from "node:fs/promises";
import path from "node:path";
import { runTask } from "./orchestrator.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var ${name}`);
  }
  return value;
}

async function main() {
  const config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "not-required-for-cli",
    githubToken: requireEnv("GITHUB_TOKEN"),
    githubOwner: process.env.GITHUB_OWNER || "via-decide",
    githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || "https://api.github.com",
    pollIntervalMs: Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000),
    artifactsDir: process.env.ARTIFACTS_DIR || ".",
    githubRepoScanLimit: Number(process.env.GITHUB_REPO_SCAN_LIMIT || 30)
  };

  const task = {
    targetRepo: process.env.TASK_REPO || "via-decide/decide.engine-tools",
    mode: process.env.TASK_MODE || "codex_then_claude",
    taskDescription: process.env.TASK_DESCRIPTION || "Add a new standalone tool called idea-remixer, integrate it safely into the current repo, and generate a PR package.",
    constraints: process.env.TASK_CONSTRAINTS || "preserve all existing tool folders; preserve standalone behavior; no unrelated deletions; update router/index/README only if needed",
    goal: process.env.TASK_GOAL || "Produce codex-task.md, claude-repair-task.md, pr-package.md, and execution.json"
  };

  const result = await runTask(task, config);

  const canonical = ["codex-task.md", "claude-repair-task.md", "pr-package.md", "execution.json"];
  const repoDir = task.targetRepo.replace("/", "__");
  for (const file of canonical) {
    await fs.copyFile(path.join(config.artifactsDir, repoDir, file), file);
  }

  console.log("Generated artifacts:");
  result.artifactPaths.forEach((item) => console.log(`- ${item}`));
  canonical.forEach((item) => console.log(`- ${item}`));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
