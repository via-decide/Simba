/**
 * task-loop.js
 *
 * Continuous task execution loop.
 * Generates tasks → executes via pipeline → records results → generates next.
 *
 * The loop is controlled per-chat via Telegram commands:
 *   /loop start   — begin continuous execution
 *   /loop stop    — stop after current task
 *   /loop status  — show loop state
 *
 * Safety:
 *   - Configurable delay between tasks (default 10s)
 *   - Max consecutive failures before auto-stop
 *   - Dry-run mode available
 *   - All tasks logged to state
 */

import crypto from "node:crypto";
import { generateNextTask, formatTaskForTelegram } from "./task-generator.js";
import { runExecutionPipeline } from "./simba-execution-pipeline.js";

const DEFAULT_DELAY_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// Active loops per chatId
const activeLoops = new Map();

export function isLoopRunning(chatId) {
  return activeLoops.get(String(chatId))?.running === true;
}

export function getLoopStatus(chatId) {
  const loop = activeLoops.get(String(chatId));
  if (!loop) return null;
  return {
    running: loop.running,
    tasksCompleted: loop.tasksCompleted,
    tasksFailed: loop.tasksFailed,
    currentTask: loop.currentTaskId,
    startedAt: loop.startedAt,
    dryRun: loop.dryRun
  };
}

export function stopLoop(chatId) {
  const key = String(chatId);
  const loop = activeLoops.get(key);
  if (loop) {
    loop.running = false;
    return true;
  }
  return false;
}

export async function startLoop({
  chatId,
  config,
  stateEngine,
  messenger,
  dryRun = true,
  delayMs = DEFAULT_DELAY_MS,
  maxTasks = 50,
  categories = null
}) {
  const key = String(chatId);

  if (activeLoops.get(key)?.running) {
    await messenger.sendMessage(chatId, "Loop already running. Use /loop stop first.");
    return;
  }

  const loopState = {
    running: true,
    tasksCompleted: 0,
    tasksFailed: 0,
    consecutiveFailures: 0,
    currentTaskId: null,
    startedAt: new Date().toISOString(),
    dryRun
  };
  activeLoops.set(key, loopState);

  // Clear stale pending tasks from previous runs
  await stateEngine.clearStalePending(chatId);

  const preQueue = await stateEngine.getTaskQueue(chatId);
  const alreadyDone = preQueue.completed.length;

  await messenger.sendMessage(
    chatId,
    [
      `🔄 Task loop started`,
      `Mode: ${dryRun ? "dry-run" : "LIVE"}`,
      `Delay: ${delayMs / 1000}s between tasks`,
      `Max tasks: ${maxTasks}`,
      categories ? `Categories: ${categories.join(", ")}` : "Categories: all",
      alreadyDone > 0 ? `Skipping ${alreadyDone} already-completed tools.` : "",
      `Use /loop stop to halt.`
    ].filter(Boolean).join("\n")
  );

  await stateEngine.appendLog(chatId, {
    stage: "LOOP",
    details: `Loop started (${dryRun ? "dry-run" : "live"}, max ${maxTasks})`
  });

  try {
    while (loopState.running && loopState.tasksCompleted + loopState.tasksFailed < maxTasks) {
      // Only exclude completed tasks — NOT stale pending ones
      const taskQueue = await stateEngine.getTaskQueue(chatId);
      const completedIds = taskQueue.completed.map((t) => t.toolId).filter(Boolean);

      // Generate next task
      const nextTask = await generateNextTask(config, completedIds, []);

      if (!nextTask) {
        await messenger.sendMessage(chatId, "✅ No more tasks to generate. All catalog tools exist or are queued.");
        break;
      }

      const taskId = crypto.randomUUID();
      const toolId = nextTask.metadata.toolId;
      loopState.currentTaskId = taskId;

      await messenger.sendMessage(
        chatId,
        `📋 Task ${loopState.tasksCompleted + loopState.tasksFailed + 1}: [${nextTask.metadata.category}] ${toolId}\n${nextTask.metadata.toolTitle}`
      );

      // Record as pending
      await stateEngine.addToTaskQueue(chatId, {
        taskId,
        toolId,
        category: nextTask.metadata.category,
        title: nextTask.metadata.toolTitle,
        status: "pending",
        startedAt: new Date().toISOString()
      });

      // Execute
      try {
        const result = await runExecutionPipeline({
          taskId,
          chatId,
          repo: nextTask.targetRepo,
          taskDescription: nextTask.taskDescription,
          constraints: nextTask.constraints,
          goal: nextTask.goal,
          mode: nextTask.mode,
          dryRun,
          config,
          stateEngine,
          onStageUpdate: async ({ stage, details }) => {
            // Throttle stage updates in loop mode — only key stages
            if (["AUDIT", "PUSH", "PR", "COMPLETE", "FAILED"].includes(stage)) {
              await messenger.sendMessage(chatId, `  [${stage}] ${details}`);
            }
          }
        });

        if (result?.status === "success") {
          loopState.tasksCompleted++;
          loopState.consecutiveFailures = 0;

          await stateEngine.updateTaskQueueItem(chatId, taskId, {
            status: "completed",
            completedAt: new Date().toISOString(),
            prUrl: result.result?.prUrl || null
          });

          const prLine = result.result?.prUrl ? `PR: ${result.result.prUrl}` : "PR: skipped";
          await messenger.sendMessage(chatId, `  ✅ ${toolId} complete. ${prLine}`);
        } else {
          loopState.tasksFailed++;
          loopState.consecutiveFailures++;

          await stateEngine.updateTaskQueueItem(chatId, taskId, {
            status: "failed",
            failedAt: new Date().toISOString(),
            error: result?.errorDetails?.likelyCause || "unknown"
          });

          await messenger.sendMessage(
            chatId,
            `  ❌ ${toolId} failed: ${result?.errorDetails?.likelyCause || "unknown"}`
          );
        }
      } catch (err) {
        loopState.tasksFailed++;
        loopState.consecutiveFailures++;

        await stateEngine.updateTaskQueueItem(chatId, taskId, {
          status: "failed",
          failedAt: new Date().toISOString(),
          error: err.message
        });

        await messenger.sendMessage(chatId, `  ❌ ${toolId} error: ${err.message}`);
      }

      // Check consecutive failure limit
      if (loopState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await messenger.sendMessage(
          chatId,
          `⚠ ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Loop auto-stopped.`
        );
        break;
      }

      // Delay before next task
      if (loopState.running) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } finally {
    loopState.running = false;
    loopState.currentTaskId = null;

    await messenger.sendMessage(
      chatId,
      [
        `🏁 Loop finished`,
        `Completed: ${loopState.tasksCompleted}`,
        `Failed: ${loopState.tasksFailed}`,
        `Total: ${loopState.tasksCompleted + loopState.tasksFailed}`
      ].join("\n")
    );

    await stateEngine.appendLog(chatId, {
      stage: "LOOP",
      details: `Loop finished: ${loopState.tasksCompleted} ok, ${loopState.tasksFailed} failed`
    });
  }
}
