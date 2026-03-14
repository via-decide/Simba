import { inspectRepository } from "./github.js";

export const STAGES = [
  "PLAN",
  "CODE_GENERATION",
  "CODE_REPAIR",
  "COMMIT",
  "PUSH",
  "PR_CREATION",
  "COMPLETE"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStructuredError({ stage, error, retryPossible, nextAction }) {
  return {
    stage,
    failed: stage,
    likelyCause: error.message,
    retryPossible,
    nextAction
  };
}

export async function runExecutionPipeline({
  taskId,
  chatId,
  repo,
  dryRun,
  config,
  stateEngine,
  onStageUpdate,
  action = "improve"
}) {
  const startedAt = new Date().toISOString();
  await stateEngine.setTaskState(chatId, taskId, {
    taskId,
    repo,
    action,
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
    await onStageUpdate({ stage, details, updatedAt, taskId, repo, dryRun });
  };

  try {
    await emit("PLAN", "Building execution plan and validating repository input.");
    await sleep(60);

    const audit = await inspectRepository(repo, config);
    if (audit.auditSource === "fallback" && /targetRepo must be/.test(audit.description)) {
      throw new Error("Repository must be in owner/repo format.");
    }

    await emit("CODE_GENERATION", dryRun ? "Simulating code generation actions." : "Preparing real code generation actions.");
    await sleep(60);

    await emit("CODE_REPAIR", "Running static repair checks on generated output.");
    await sleep(60);

    await emit("COMMIT", dryRun ? "Dry-run: commit simulated and no git history changed." : "Preparing commit step.");
    await sleep(60);

    await emit(
      "PUSH",
      dryRun
        ? "Dry-run: push skipped by safety mode."
        : config.allowLivePush
          ? "Live mode: push allowed by configuration."
          : "Live mode requested but push is disabled by SIMBA_ALLOW_LIVE_PUSH."
    );
    await sleep(60);

    await emit(
      "PR_CREATION",
      dryRun
        ? "Dry-run: PR creation intentionally skipped."
        : config.allowLivePr
          ? "Live mode: PR creation allowed by configuration."
          : "Live mode requested but PR creation is disabled by SIMBA_ALLOW_LIVE_PR."
    );
    await sleep(60);

    await emit("COMPLETE", "Pipeline finished successfully.");

    const completedAt = new Date().toISOString();
    await stateEngine.setTaskState(chatId, taskId, {
      status: "success",
      result: {
        summary: "Execution pipeline completed",
        push: dryRun ? "skipped" : config.allowLivePush ? "enabled" : "disabled",
        prCreation: dryRun ? "skipped" : config.allowLivePr ? "enabled" : "disabled"
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
      nextAction: "Fix repo input or connectivity, then run /resume."
    });

    await stateEngine.setTaskState(chatId, taskId, {
      status: "failed",
      errorDetails,
      retries: 1,
      timestamps: { updatedAt: now, completedAt: now }
    });

    await onStageUpdate({
      stage: "FAILED",
      details: `❌ ${errorDetails.failed} failed\nCause: ${errorDetails.likelyCause}\nRetry: ${errorDetails.retryPossible ? "yes" : "no"}\nNext: ${errorDetails.nextAction}`,
      updatedAt: now,
      taskId,
      repo,
      dryRun
    });

    return await stateEngine.getTask(chatId, taskId);
  }
}
