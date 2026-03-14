import crypto from "node:crypto";
import { listOwnerRepos, inspectRepository, listRepoBranches, deleteBranch } from "./github.js";
import { runExecutionPipeline, STAGES } from "./simba-execution-pipeline.js";
import {
  generateTasks,
  getCatalogSummary,
  formatTaskListForTelegram,
  formatTaskForTelegram
} from "./task-generator.js";
import { startLoop, stopLoop, getLoopStatus, isLoopRunning } from "./task-loop.js";
import { parseTaskMessage, sanitizeTelegram, truncateForTelegram } from "./task-parser.js";

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

function errMsg(title, cause, retryPossible, nextAction) {
  return [
    `❌ ${title}`,
    `Cause: ${cause}`,
    `Retry: ${retryPossible ? "yes" : "no"}`,
    `Next: ${nextAction}`
  ].join("\n");
}

function formatStatus(task) {
  if (!task) return "No active task. Use /improve <repo> or /task.";
  const lines = [
    `Task: ${task.taskId?.slice(0, 8) || "?"}`,
    `Repo: ${task.repo || "?"}`,
    `Mode: ${task.mode || "?"}`,
    `Stage: ${task.currentStage || "?"}`,
    `Status: ${task.status || "?"}`
  ];
  if (task.result?.prUrl) lines.push(`PR: ${task.result.prUrl}`);
  if (task.result?.push) lines.push(`Push: ${task.result.push}`);
  if (task.errorDetails) lines.push(`Error: ${task.errorDetails.likelyCause}`);
  lines.push(`Updated: ${task.timestamps?.updatedAt || "n/a"}`);
  return lines.join("\n");
}

function formatHistory(tasks) {
  if (!tasks.length) return "No task history.";
  return tasks
    .map((t, i) => {
      const id = (t.taskId || "?").slice(0, 8);
      const status = t.status || "?";
      const repo = t.repo || "?";
      const time = t.timestamps?.startedAt?.slice(0, 16) || "?";
      return `${i + 1}. [${status}] ${repo} (${id}) — ${time}`;
    })
    .join("\n");
}

const HELP_TEXT = `Simba Bot v2 Commands:

/help — this message
/repos — list owner repositories
/analyze <owner/repo> — inspect repo metadata
/improve <owner/repo> — full pipeline (audit → artifacts → push → PR)
/task — structured task input (multiline)
/status — active task status
/history — recent task history
/logs [n] — last n log entries (default 20)
/cancel — cancel active task
/branches <owner/repo> — list simba/* branches
/cleanup <owner/repo> — delete stale simba/* branches
/resume — re-run last failed task

Task Generation:
/catalog — show tool catalog by category
/generate [category] — generate task list (games, business, etc)
/queue — show pending/completed/failed task queue
/queue clear — reset task queue
/loop start [dry|live] — start continuous task execution
/loop stop — stop loop after current task
/loop status — show loop state`;

export class SimbaCommandRouter {
  constructor({ config, stateEngine, messenger }) {
    this.config = config;
    this.stateEngine = stateEngine;
    this.messenger = messenger;
  }

  _isAdmin(chatId) {
    if (!this.config.enforceAdminOnly) return true;
    if (!this.config.adminChatIds.length) return true;
    return this.config.adminChatIds.includes(String(chatId));
  }

  async handleMessage({ chatId, text }) {
    const trimmed = text.trim();

    if (this.config.enforceAdminOnly && !this._isAdmin(chatId)) {
      await this.messenger.sendMessage(chatId, "🔒 Access restricted. Your chat ID is not in SIMBA_ADMIN_CHAT_IDS.");
      return;
    }

    try {
      // ── /start, /help ──
      if (trimmed.startsWith("/start") || trimmed.startsWith("/help")) {
        await this.messenger.sendMessage(chatId, HELP_TEXT);
        return;
      }

      // ── /repos ──
      if (trimmed.startsWith("/repos")) {
        const repos = await listOwnerRepos(this.config);
        const out = repos
          .slice(0, 20)
          .map((r) => `- ${r.fullName} (${r.language})`)
          .join("\n");
        await this.messenger.sendMessage(chatId, `Repos:\n${out}`);
        return;
      }

      // ── /analyze ──
      if (trimmed.startsWith("/analyze")) {
        const repo = parseRepoArg(trimmed);
        if (!repo || !isValidRepo(repo)) {
          await this.messenger.sendMessage(chatId, errMsg("Analyze failed", "Invalid repo.", true, "/analyze owner/repo"));
          return;
        }
        await this.messenger.sendMessage(chatId, `🔎 Inspecting ${repo}...`);
        const audit = await inspectRepository(repo, this.config);
        const taskId = `analysis-${Date.now()}`;
        await this.stateEngine.setTaskState(chatId, taskId, {
          taskId,
          repo,
          action: "analyze",
          currentStage: "COMPLETE",
          mode: "dry-run",
          status: "success",
          result: audit,
          timestamps: { updatedAt: nowIso() }
        });
        await this.stateEngine.appendLog(chatId, { taskId, stage: "ANALYZE", details: `Inspected ${repo}` });
        await this.messenger.sendMessage(
          chatId,
          `✅ ${repo}\nBranch: ${audit.defaultBranch}\nLang: ${audit.language}\nSource: ${audit.auditSource}\nREADME: ${audit.readmeSnippet !== "not found" ? "found" : "missing"}\nAGENTS: ${audit.agentsSnippet !== "not found" ? "found" : "missing"}`
        );
        return;
      }

      // ── /improve ──
      if (trimmed.startsWith("/improve")) {
        const repo = parseRepoArg(trimmed);
        if (!repo || !isValidRepo(repo)) {
          await this.messenger.sendMessage(chatId, errMsg("Improve failed", "Invalid repo.", true, "/improve owner/repo"));
          return;
        }

        const taskId = crypto.randomUUID();
        const preview = { taskId, repo, action: "improve", requestedAt: nowIso() };
        await this.stateEngine.setPendingPreview(chatId, preview);

        await this.messenger.sendPreviewCard(chatId, {
          text: [
            "🧪 Simba Task Preview",
            `Repo: ${repo}`,
            `Stages: ${STAGES.join(" → ")}`,
            `Push: ${this.config.allowLivePush ? "enabled" : "disabled"}`,
            `PR: ${this.config.allowLivePr ? "enabled" : "disabled"}`
          ].join("\n"),
          buttons: [
            [{ text: "▶ Run dry-run", callback_data: `simba:run:${taskId}:dry` }],
            [{ text: "🚀 Run live", callback_data: `simba:run:${taskId}:live` }],
            [{ text: "✕ Cancel", callback_data: `simba:cancel:${taskId}` }]
          ]
        });
        return;
      }

      // ── /task ──
      if (trimmed.startsWith("/task")) {
        const body = sanitizeTelegram(trimmed.slice("/task".length).trim());
        if (!body) {
          await this.messenger.sendMessage(
            chatId,
            "Usage:\n/task\nrepo: owner/repo\nmode: codex | claude | claude_repair | codex_then_claude\ntask: what to do\nconstraints: optional\ngoal: optional\n\nOr JSON:\n/task {\"repo\":\"owner/repo\",\"task\":\"what to do\"}"
          );
          return;
        }
        await this.messenger.sendMessage(chatId, "⏳ Running task...");

        let parsed;
        try {
          parsed = parseTaskMessage(body);
        } catch (parseErr) {
          console.error(`[${chatId}] /task parse error:`, parseErr.message);
          await this.messenger.sendMessage(
            chatId,
            errMsg("Task parse failed", parseErr.message, true, "Check formatting and retry.")
          );
          return;
        }

        const taskId = crypto.randomUUID();
        try {
          const task = await runExecutionPipeline({
            taskId,
            chatId,
            repo: parsed.targetRepo,
            taskDescription: parsed.taskDescription,
            constraints: parsed.constraints,
            goal: parsed.goal,
            mode: parsed.mode,
            dryRun: false,
            config: this.config,
            stateEngine: this.stateEngine,
            onStageUpdate: async ({ stage, details }) => {
              await this.messenger.sendMessage(chatId, `[${stage}] ${truncateForTelegram(details)}`);
            }
          });
          await this._sendTaskResult(chatId, task);
        } catch (err) {
          console.error(`[${chatId}] /task pipeline error:`, err.message);
          await this.messenger.sendMessage(chatId, errMsg("Task failed", err.message, true, "Check repo/task fields or /resume."));
        }
        return;
      }

      // ── /status ──
      if (trimmed.startsWith("/status")) {
        const task = await this.stateEngine.getActiveTask(chatId);
        await this.messenger.sendMessage(chatId, formatStatus(task));
        return;
      }

      // ── /history ──
      if (trimmed.startsWith("/history")) {
        const tasks = await this.stateEngine.getTaskHistory(chatId, 10);
        await this.messenger.sendMessage(chatId, `📋 Recent tasks:\n${formatHistory(tasks)}`);
        return;
      }

      // ── /logs ──
      if (trimmed.startsWith("/logs")) {
        const countStr = trimmed.split(/\s+/)[1];
        const count = Number(countStr) || 20;
        const logs = await this.stateEngine.getLogs(chatId, count);
        if (!logs.length) {
          await this.messenger.sendMessage(chatId, "No logs yet.");
          return;
        }
        const text = logs
          .map((l) => `[${l.ts?.slice(11, 19) || "?"}] ${l.stage || "?"}: ${l.details || ""}`)
          .join("\n");
        await this.messenger.sendMessage(chatId, `📝 Logs (${logs.length}):\n${text}`);
        return;
      }

      // ── /cancel ──
      if (trimmed.startsWith("/cancel")) {
        const cancelled = await this.stateEngine.cancelActiveTask(chatId);
        await this.messenger.sendMessage(
          chatId,
          cancelled ? `Cancelled task ${cancelled.slice(0, 8)}.` : "No active task to cancel."
        );
        return;
      }

      // ── /branches ──
      if (trimmed.startsWith("/branches")) {
        const repo = parseRepoArg(trimmed);
        if (!repo || !isValidRepo(repo)) {
          await this.messenger.sendMessage(chatId, errMsg("Branches", "Invalid repo.", true, "/branches owner/repo"));
          return;
        }
        const [owner, repoName] = repo.split("/");
        const branches = await listRepoBranches(owner, repoName, this.config, "simba/");
        await this.messenger.sendMessage(
          chatId,
          branches.length
            ? `Simba branches on ${repo}:\n${branches.map((b) => `- ${b}`).join("\n")}`
            : `No simba/* branches on ${repo}.`
        );
        return;
      }

      // ── /cleanup ──
      if (trimmed.startsWith("/cleanup")) {
        const repo = parseRepoArg(trimmed);
        if (!repo || !isValidRepo(repo)) {
          await this.messenger.sendMessage(chatId, errMsg("Cleanup", "Invalid repo.", true, "/cleanup owner/repo"));
          return;
        }
        const [owner, repoName] = repo.split("/");
        const branches = await listRepoBranches(owner, repoName, this.config, "simba/");
        if (!branches.length) {
          await this.messenger.sendMessage(chatId, `No simba/* branches to clean on ${repo}.`);
          return;
        }
        await this.messenger.sendMessage(chatId, `🧹 Deleting ${branches.length} simba/* branches on ${repo}...`);
        let deleted = 0;
        for (const branch of branches) {
          try {
            await deleteBranch(owner, repoName, branch, this.config);
            deleted++;
          } catch {
            // continue on failure
          }
        }
        await this.messenger.sendMessage(chatId, `Deleted ${deleted}/${branches.length} branches.`);
        return;
      }

      // ── /resume ──
      if (trimmed.startsWith("/resume")) {
        const task = await this.stateEngine.getActiveTask(chatId);
        if (!task) {
          await this.messenger.sendMessage(chatId, "No task to resume.");
          return;
        }
        const taskId = crypto.randomUUID();
        await this.messenger.sendMessage(chatId, `🔄 Resuming pipeline for ${task.repo}...`);
        const result = await runExecutionPipeline({
          taskId,
          chatId,
          repo: task.repo,
          taskDescription: task.taskDescription || `Resume improvement for ${task.repo}`,
          constraints: task.constraints || "",
          goal: task.goal || "",
          mode: task.mode,
          dryRun: task.mode === "dry-run",
          config: this.config,
          stateEngine: this.stateEngine,
          onStageUpdate: async ({ stage, details }) => {
            await this.messenger.sendMessage(chatId, `[${stage}] ${details}`);
          }
        });
        await this._sendTaskResult(chatId, result);
        return;
      }

      // ── /catalog ──
      if (trimmed.startsWith("/catalog")) {
        const summary = getCatalogSummary();
        const lines = Object.entries(summary).map(
          ([cat, info]) => `${cat} (${info.total}): ${info.tools.join(", ")}`
        );
        await this.messenger.sendMessage(chatId, `📦 Tool Catalog:\n${lines.join("\n")}`);
        return;
      }

      // ── /generate ──
      if (trimmed.startsWith("/generate")) {
        const arg = trimmed.slice("/generate".length).trim();
        const categories = arg ? arg.split(/[\s,]+/).filter(Boolean) : null;

        await this.messenger.sendMessage(chatId, "🔍 Analyzing repo and generating tasks...");

        const taskQueue = await this.stateEngine.getTaskQueue(chatId);
        const excludeIds = new Set([
          ...taskQueue.completed.map((t) => t.toolId),
          ...taskQueue.pending.map((t) => t.toolId)
        ].filter(Boolean));

        const tasks = await generateTasks(this.config, {
          categories,
          maxTasks: 20,
          excludeIds
        });

        const list = formatTaskListForTelegram(tasks);
        await this.messenger.sendMessage(chatId, `📋 Generated ${tasks.length} tasks:\n${list}`);

        if (tasks.length > 0) {
          await this.messenger.sendMessage(
            chatId,
            "Use /loop start dry to execute in dry-run, or /loop start live for real PRs."
          );
        }
        return;
      }

      // ── /queue ──
      if (trimmed.startsWith("/queue")) {
        const arg = trimmed.slice("/queue".length).trim();

        if (arg === "clear") {
          await this.stateEngine.clearTaskQueue(chatId);
          await this.messenger.sendMessage(chatId, "Task queue cleared.");
          return;
        }

        const q = await this.stateEngine.getTaskQueue(chatId);
        const lines = [
          `📊 Task Queue`,
          `Pending: ${q.pending.length}`,
          `Completed: ${q.completed.length}`,
          `Failed: ${q.failed.length}`
        ];

        if (q.completed.length > 0) {
          lines.push("\n✅ Completed:");
          for (const t of q.completed.slice(-10)) {
            const pr = t.prUrl ? ` → ${t.prUrl}` : "";
            lines.push(`  ${t.toolId || t.taskId?.slice(0, 8)}${pr}`);
          }
        }

        if (q.failed.length > 0) {
          lines.push("\n❌ Failed:");
          for (const t of q.failed.slice(-5)) {
            lines.push(`  ${t.toolId || t.taskId?.slice(0, 8)}: ${t.error || "unknown"}`);
          }
        }

        if (q.pending.length > 0) {
          lines.push("\n⏳ Pending:");
          for (const t of q.pending.slice(-10)) {
            lines.push(`  ${t.toolId || t.taskId?.slice(0, 8)} [${t.category || "?"}]`);
          }
        }

        await this.messenger.sendMessage(chatId, lines.join("\n"));
        return;
      }

      // ── /loop ──
      if (trimmed.startsWith("/loop")) {
        const args = trimmed.slice("/loop".length).trim().split(/\s+/);
        const subCommand = args[0] || "";

        if (subCommand === "stop") {
          const stopped = stopLoop(chatId);
          await this.messenger.sendMessage(
            chatId,
            stopped ? "⏹ Loop will stop after current task." : "No loop running."
          );
          return;
        }

        if (subCommand === "status") {
          const status = getLoopStatus(chatId);
          if (!status) {
            await this.messenger.sendMessage(chatId, "No loop active.");
          } else {
            await this.messenger.sendMessage(chatId, [
              `🔄 Loop Status`,
              `Running: ${status.running}`,
              `Completed: ${status.tasksCompleted}`,
              `Failed: ${status.tasksFailed}`,
              `Mode: ${status.dryRun ? "dry-run" : "live"}`,
              `Started: ${status.startedAt}`
            ].join("\n"));
          }
          return;
        }

        if (subCommand === "start") {
          const mode = args[1] || "dry";
          const dryRun = mode !== "live";
          const categoryArg = args[2];
          const categories = categoryArg ? categoryArg.split(",") : null;

          // Run loop asynchronously (don't await — it runs in background)
          startLoop({
            chatId,
            config: this.config,
            stateEngine: this.stateEngine,
            messenger: this.messenger,
            dryRun,
            delayMs: 10_000,
            maxTasks: 50,
            categories
          }).catch(async (err) => {
            await this.messenger.sendMessage(
              chatId,
              errMsg("Loop crashed", err.message, true, "/loop start")
            );
          });

          return;
        }

        await this.messenger.sendMessage(
          chatId,
          "Usage: /loop start [dry|live] [category] | /loop stop | /loop status"
        );
        return;
      }

      await this.messenger.sendMessage(chatId, "Unknown command. /help for options.");
    } catch (error) {
      console.error(`[${chatId}] Error:`, error.message);
      await this.messenger.sendMessage(chatId, errMsg("Command failed", error.message, true, "Retry or /status."));
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
        await this.messenger.sendMessage(chatId, "Task mismatch. Run /improve again.");
        return;
      }

      if (command === "cancel") {
        await this.stateEngine.clearPendingPreview(chatId);
        await this.messenger.sendMessage(chatId, "Cancelled.");
        return;
      }

      if (command === "run") {
        const dryRun = parts[3] !== "live";
        await this.stateEngine.clearPendingPreview(chatId);
        await this.messenger.sendMessage(chatId, `🚀 Starting ${dryRun ? "dry-run" : "live"} pipeline for ${pending.repo}...`);

        const task = await runExecutionPipeline({
          taskId,
          chatId,
          repo: pending.repo,
          taskDescription: `Improve repository ${pending.repo}`,
          constraints: "Preserve existing code; prefer additive changes.",
          goal: `Improve ${pending.repo} via Simba pipeline`,
          mode: "codex_then_claude",
          dryRun,
          config: this.config,
          stateEngine: this.stateEngine,
          onStageUpdate: async ({ stage, details }) => {
            await this.messenger.sendMessage(chatId, `[${stage}] ${details}`);
          }
        });

        await this._sendTaskResult(chatId, task);
      }
    } catch (error) {
      console.error(`[${chatId}] Callback error:`, error.message);
      await this.messenger.sendMessage(chatId, errMsg("Callback failed", error.message, true, "Run /improve again."));
    }
  }

  async _sendTaskResult(chatId, task) {
    if (!task) {
      await this.messenger.sendMessage(chatId, "No task result available.");
      return;
    }

    if (task.status === "success") {
      const lines = [
        `✅ Pipeline complete`,
        `Repo: ${task.repo}`,
        `Mode: ${task.mode}`,
        `Push: ${task.result?.push || "n/a"}`,
        `PR: ${task.result?.prCreation || "n/a"}`
      ];
      if (task.result?.prUrl) lines.push(`🔗 ${task.result.prUrl}`);
      if (task.result?.prPackage?.branch) lines.push(`Branch: ${task.result.prPackage.branch}`);
      await this.messenger.sendMessage(chatId, lines.join("\n"));
    } else {
      await this.messenger.sendMessage(chatId, errMsg(
        "Pipeline failed",
        task.errorDetails?.likelyCause || "Unknown",
        task.errorDetails?.retryPossible ?? true,
        task.errorDetails?.nextAction || "/resume"
      ));
    }
  }
}


