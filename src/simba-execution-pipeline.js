import {
  inspectRepository,
  getBranchSha,
  createBranch,
  commitFile,
  createPullRequest
} from "./github.js";
import { writeArtifacts } from "./artifacts.js";
import {
  buildCodexPrompt,
  buildClaudeRepairPrompt,
  buildPrPackage,
  buildExecutionPacket
} from "./templates.js";
import path from "node:path";

export const STAGES = [
  "PLAN",
  "AUDIT",
  "GENERATE",
  "ARTIFACTS",
  "PUSH",
  "PR",
  "COMPLETE"
];

function buildStructuredError({ stage, error, retryPossible, nextAction }) {
  return {
    stage,
    failed: stage,
    likelyCause: error.message,
    retryPossible,
    nextAction
  };
}

/**
 * Unified execution pipeline.
 *
 * This replaces the old simulated pipeline. Each stage does real work:
 *   PLAN      → parse input, validate repo format
 *   AUDIT     → inspect repo via GitHub API (README, AGENTS, package.json)
 *   GENERATE  → build codex + claude prompts + PR package from templates
 *   ARTIFACTS → write artifacts to disk
 *   PUSH      → create branch + commit artifacts to GitHub (if live + allowed)
 *   PR        → open pull request (if live + allowed)
 *   COMPLETE  → finalize state
 */
export async function runExecutionPipeline({
  taskId,
  chatId,
  repo,
  taskDescription,
  constraints,
  goal,
  mode,
  dryRun,
  config,
  stateEngine,
  onStageUpdate
}) {
  const startedAt = new Date().toISOString();

  await stateEngine.setTaskState(chatId, taskId, {
    taskId,
    repo,
    mode: dryRun ? "dry-run" : "live",
    currentStage: "PLAN",
    retries: 0,
    status: "running",
    result: null,
    errorDetails: null,
    timestamps: { startedAt, updatedAt: startedAt }
  });

  const emit = async (stage, details) => {
    const updatedAt = new Date().toISOString();
    await stateEngine.setTaskState(chatId, taskId, {
      currentStage: stage,
      timestamps: { updatedAt }
    });
    await stateEngine.appendLog(chatId, { taskId, stage, details });
    await onStageUpdate({ stage, details, updatedAt, taskId, repo, dryRun });
  };

  try {
    // ── PLAN ──
    await emit("PLAN", "Validating inputs and building task context.");
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      throw new Error("Repository must be in owner/repo format.");
    }

    const taskInput = {
      targetRepo: repo,
      mode: mode || "codex_then_claude",
      taskDescription: taskDescription || `Improve repository ${repo} via Simba pipeline`,
      constraints: constraints || "Preserve existing code; prefer additive changes.",
      goal: goal || taskDescription || `Improve ${repo}`
    };

    // ── AUDIT ──
    await emit("AUDIT", `Inspecting ${repo} via GitHub API.`);
    const repoAudit = await inspectRepository(repo, config);

    if (repoAudit.auditSource === "fallback") {
      await emit("AUDIT", `⚠ Audit used fallback: ${repoAudit.description}`);
    } else {
      await emit("AUDIT", `Branch: ${repoAudit.defaultBranch} | Lang: ${repoAudit.language} | README: ${repoAudit.readmeSnippet !== "not found" ? "found" : "missing"}`);
    }

    const input = {
      ...taskInput,
      repoAudit,
      defaultBranch: repoAudit.defaultBranch,
      goal: taskInput.goal
    };

    // ── GENERATE ──
    await emit("GENERATE", "Building codex prompt, claude repair prompt, and PR package.");
    const codexPrompt = buildCodexPrompt(input);
    const claudePrompt = buildClaudeRepairPrompt(input);
    const prPackage = buildPrPackage(input);
    const executionPacket = buildExecutionPacket(input, prPackage);

    const prMarkdown = [
      `Branch: ${prPackage.branch}`,
      `Title: ${prPackage.title}`,
      "",
      prPackage.body
    ].join("\n");

    // ── ARTIFACTS ──
    await emit("ARTIFACTS", "Writing artifacts to disk.");
    const outputDir = path.join(config.artifactsDir, repo.replace("/", "__"));
    const artifactPaths = await writeArtifacts(outputDir, {
      codexPrompt,
      claudePrompt,
      prMarkdown,
      executionPacket
    });
    await emit("ARTIFACTS", `Wrote ${artifactPaths.length} files to ${outputDir}`);

    // ── PUSH ──
    let pushResult = "skipped";
    if (dryRun) {
      await emit("PUSH", "Dry-run: branch creation and commit skipped.");
    } else if (!config.allowLivePush) {
      await emit("PUSH", "Live push disabled (SIMBA_ALLOW_LIVE_PUSH != true). Artifacts saved locally only.");
    } else {
      await emit("PUSH", `Creating branch ${prPackage.branch} from ${repoAudit.defaultBranch}...`);
      try {
        const baseSha = await getBranchSha(owner, repoName, repoAudit.defaultBranch, config);
        await createBranch(owner, repoName, prPackage.branch, baseSha, config);

        const artifactDir = `artifacts/${repo.replace("/", "__")}`;
        const files = {
          [`${artifactDir}/codex-task.md`]: codexPrompt,
          [`${artifactDir}/claude-repair-task.md`]: claudePrompt,
          [`${artifactDir}/pr-package.md`]: prMarkdown,
          [`${artifactDir}/execution.json`]: JSON.stringify(executionPacket, null, 2)
        };

        for (const [filePath, content] of Object.entries(files)) {
          await commitFile(owner, repoName, filePath, content, `simba: add orchestration artifacts`, prPackage.branch, config);
        }
        pushResult = "pushed";
        await emit("PUSH", `Branch ${prPackage.branch} created with ${Object.keys(files).length} commits.`);
      } catch (pushErr) {
        pushResult = `failed: ${pushErr.message}`;
        await emit("PUSH", `⚠ Push failed: ${pushErr.message}`);
      }
    }

    // ── PR ──
    let prUrl = null;
    let prError = null;
    if (dryRun) {
      await emit("PR", "Dry-run: PR creation skipped.");
    } else if (!config.allowLivePr) {
      await emit("PR", "Live PR disabled (SIMBA_ALLOW_LIVE_PR != true).");
    } else if (pushResult !== "pushed") {
      await emit("PR", "PR skipped because push did not succeed.");
    } else {
      await emit("PR", "Opening pull request...");
      try {
        const pr = await createPullRequest(
          owner,
          repoName,
          prPackage.branch,
          repoAudit.defaultBranch,
          prPackage.title,
          prPackage.body,
          config
        );
        prUrl = pr.url;
        await emit("PR", `PR opened: ${pr.url}`);
      } catch (prErr) {
        prError = prErr.message;
        await emit("PR", `⚠ PR creation failed: ${prErr.message}`);
      }
    }

    // ── COMPLETE ──
    const completedAt = new Date().toISOString();
    await emit("COMPLETE", "Pipeline finished.");

    await stateEngine.setTaskState(chatId, taskId, {
      status: "success",
      result: {
        summary: "Execution pipeline completed",
        push: pushResult,
        prCreation: prUrl ? "created" : prError ? `failed: ${prError}` : "skipped",
        prUrl: prUrl || null,
        artifactPaths,
        prPackage: { branch: prPackage.branch, title: prPackage.title },
        repoAudit: {
          defaultBranch: repoAudit.defaultBranch,
          language: repoAudit.language,
          auditSource: repoAudit.auditSource
        }
      },
      timestamps: { completedAt, updatedAt: completedAt }
    });

    return await stateEngine.getTask(chatId, taskId);
  } catch (error) {
    const now = new Date().toISOString();
    const errorDetails = buildStructuredError({
      stage: "PLAN",
      error,
      retryPossible: true,
      nextAction: "Fix inputs or connectivity, then /resume."
    });

    await stateEngine.setTaskState(chatId, taskId, {
      status: "failed",
      errorDetails,
      retries: 1,
      timestamps: { updatedAt: now, completedAt: now }
    });

    await stateEngine.appendLog(chatId, { taskId, stage: "FAILED", details: error.message });
    await onStageUpdate({
      stage: "FAILED",
      details: `❌ ${error.message}`,
      updatedAt: now,
      taskId,
      repo,
      dryRun
    });

    return await stateEngine.getTask(chatId, taskId);
  }
}
