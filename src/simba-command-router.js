import crypto from "node:crypto";
import { listOwnerRepos, inspectRepository } from "./github.js";
import { runExecutionPipeline, STAGES } from "./simba-execution-pipeline.js";
import { runTask, parseTaskMessage, formatTelegramResult } from "./orchestrator.js";

function nowIso() {
  return new Date().toISOString();
}

function parseRepoArg(text) {
  const [, ...rest] = text.trim().split(/\s+/);
  return rest[0] || "";
}

function isValidRepo(value) {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function makePreviewText({ repo, mode }) {
  return [
    "🧪 Simba Task Preview",
    `Repo: ${repo}`,
    "Proposed action: Improve repository through Simba pipeline",
    `Planned stages: ${STAGES.join(" → ")}`,
    `Safety mode: ${mode}`
  ].join("\n");
}

function formatStatus(task) {
  if (!task) {
    return "No active task. Use /analyze <repo> then /improve <repo>.";
  }

  return [
    `Task: ${task.taskId}`,
    `Repo: ${task.repo}`,
    `Mode: ${task.mode}`,
    `Stage: ${task.currentStage}`,
    `Retries: ${task.retries ?? 0}`,
    `Last update: ${task.timestamps?.updatedAt || "n/a"}`,
    `Result: ${task.status}`,
    task.errorDetails ? `Error: ${task.errorDetails.likelyCause}` : "Error: none"
  ].join("\n");
}

function structuredErrorMessage(title, cause, retryPossible, nextAction) {
  return [
    `❌ ${title}`,
    `Likely cause: ${cause}`,
    `Retry possible: ${retryPossible ? "yes" : "no"}`,
    `Next action: ${nextAction}`
  ].join("\n");
}

export class SimbaCommandRouter {
  constructor({ config, stateEngine, messenger }) {
    this.config = config;
    this.stateEngine = stateEngine;
    this.messenger = messenger;
  }

  async handleMessage({ chatId, text }) {
    const trimmed = text.trim();

    try {
      if (trimmed.startsWith("/start") || trimmed.startsWith("/help")) {
        await this.messenger.sendMessage(chatId,
          "Simba Bot Commands:\n/start\n/help\n/analyze <owner/repo>\n/improve <owner/repo>\n/status\n/resume\n/test\n/repos\n/task"
        );
        return;
      }

      if (trimmed.startsWith("/repos")) {
        const repos = await listOwnerRepos(this.config);
        const textOut = repos.slice(0, 20).map((r) => `- ${r.fullName} (${r.language})`).join("\n");
        await this.messenger.sendMessage(chatId, `Repos:\n${textOut}`);
        return;
      }

      if (trimmed.startsWith("/analyze")) {
        const repo = parseRepoArg(trimmed);
        if (!repo || !isValidRepo(repo)) {
          await this.messenger.sendMessage(chatId, structuredErrorMessage("Analyze failed", "Invalid repo input.", true, "Use /analyze owner/repo."));
          return;
        }
        const audit = await inspectRepository(repo, this.config);
        const analysisTaskId = `analysis-${Date.now()}`;
        await this.stateEngine.setTaskState(chatId, analysisTaskId, {
          taskId: analysisTaskId,
          repo,
          action: "analyze",
          currentStage: "PLAN",
          mode: "dry-run",
          retries: 0,
          status: "success",
          result: audit,
          timestamps: { updatedAt: nowIso() }
        });
        await this.messenger.sendMessage(chatId, `🔎 Analysis complete for ${repo}\nBranch: ${audit.defaultBranch}\nLanguage: ${audit.language}\nSource: ${audit.auditSource}`);
        return;
      }

      if (trimmed.startsWith("/improve")) {
        const repo = parseRepoArg(trimmed);
        if (!repo || !isValidRepo(repo)) {
          await this.messenger.sendMessage(chatId, structuredErrorMessage("Improve failed", "Invalid repo input.", true, "Use /improve owner/repo."));
          return;
        }

        const taskId = crypto.randomUUID();
        const preview = {
          taskId,
          repo,
          action: "improve",
          requestedAt: nowIso(),
          defaultMode: "dry-run"
        };

        await this.stateEngine.setPendingPreview(chatId, preview);
        await this.messenger.sendPreviewCard(chatId, {
          text: makePreviewText({ repo, mode: "dry-run" }),
          buttons: [
            [{ text: "Run dry-run", callback_data: `simba:run:${taskId}:dry` }],
            [{ text: "Run live", callback_data: `simba:run:${taskId}:live` }],
            [{ text: "Cancel", callback_data: `simba:cancel:${taskId}` }]
          ]
        });
        return;
      }

      if (trimmed.startsWith("/test")) {
        const repo = `${this.config.githubOwner}/simba-test-harness`;
        const taskId = crypto.randomUUID();
        await this.executeTask(chatId, { taskId, repo, dryRun: true, action: "test" });
        return;
      }

      if (trimmed.startsWith("/status")) {
        const task = await this.stateEngine.getActiveTask(chatId);
        await this.messenger.sendMessage(chatId, formatStatus(task));
        return;
      }

      if (trimmed.startsWith("/resume")) {
        const task = await this.stateEngine.getActiveTask(chatId);
        if (!task) {
          await this.messenger.sendMessage(chatId, "No task to resume.");
          return;
        }
        const newTaskId = crypto.randomUUID();
        await this.executeTask(chatId, { taskId: newTaskId, repo: task.repo, dryRun: task.mode !== "live", action: "resume" });
        return;
      }

      if (trimmed.startsWith("/task")) {
        const body = trimmed.slice("/task".length).trim();
        if (!body) {
          await this.messenger.sendMessage(chatId,
            "Usage:\n/task\nrepo: owner/repo\nmode: codex | claude | claude_repair | codex_then_claude\ntask: describe what to do\nconstraints: optional\ngoal: optional"
          );
          return;
        }
        await this.messenger.sendMessage(chatId, "⏳ Running orchestration task...");
        try {
          const parsed = parseTaskMessage(body);
          const result = await runTask(parsed, this.config);
          await this.messenger.sendMessage(chatId, formatTelegramResult(result));
        } catch (err) {
          await this.messenger.sendMessage(chatId, structuredErrorMessage(
            "Task failed",
            err.message,
            true,
            "Check repo: and task: fields and retry."
          ));
        }
        return;
      }

      await this.messenger.sendMessage(chatId, "Unknown command. Use /help.");
    } catch (error) {
      await this.messenger.sendMessage(
        chatId,
        structuredErrorMessage("Command processing failed", error.message, true, "Retry command or run /status.")
      );
    }
  }

  async handleCallback({ chatId, data }) {
    try {
      if (!data.startsWith("simba:")) return;

      const pending = (await this.stateEngine.getChatState(chatId)).pendingPreview;
      if (!pending) {
        await this.messenger.sendMessage(chatId, "Preview expired. Run /improve again.");
        return;
      }

      const parts = data.split(":");
      const command = parts[1];
      const taskId = parts[2];

      if (taskId !== pending.taskId) {
        await this.messenger.sendMessage(chatId, "Task preview mismatch. Run /improve again.");
        return;
      }

      if (command === "cancel") {
        await this.stateEngine.clearPendingPreview(chatId);
        await this.messenger.sendMessage(chatId, "Cancelled task preview.");
        return;
      }

      if (command === "run") {
        const mode = parts[3] === "live" ? "live" : "dry";
        await this.stateEngine.clearPendingPreview(chatId);
        await this.executeTask(chatId, { taskId, repo: pending.repo, dryRun: mode !== "live", action: pending.action });
      }
    } catch (error) {
      await this.messenger.sendMessage(
        chatId,
        structuredErrorMessage("Callback handling failed", error.message, true, "Run /improve again.")
      );
    }
  }

  async executeTask(chatId, { taskId, repo, dryRun, action }) {
    await this.messenger.sendMessage(chatId, `🚀 Starting ${action} for ${repo} (${dryRun ? "dry-run" : "live"})`);
    const task = await runExecutionPipeline({
      taskId,
      chatId,
      repo,
      dryRun,
      action,
      config: this.config,
      stateEngine: this.stateEngine,
      onStageUpdate: async ({ stage, details }) => {
        await this.messenger.sendMessage(chatId, `[${stage}] ${details}`);
      }
    });

    if (task.status === "success") {
      await this.messenger.sendMessage(
        chatId,
        `✅ Task complete\nRepo: ${task.repo}\nMode: ${task.mode}\nFinal stage: ${task.currentStage}\nPush: ${task.result.push}\nPR: ${task.result.prCreation}`
      );
    } else {
      await this.messenger.sendMessage(chatId, structuredErrorMessage(
        `${action} failed`,
        task.errorDetails?.likelyCause || "Unknown",
        task.errorDetails?.retryPossible ?? true,
        task.errorDetails?.nextAction || "Run /resume"
      ));
    }
  }
}
