/**
 * Orchestrator — backward-compatible module.
 *
 * The /task command in simba-command-router now routes through
 * runExecutionPipeline directly. This module is retained for
 * the generate-task-packet CLI script and any external callers.
 */

import path from "node:path";
import { inspectRepository, listOwnerRepos } from "./github.js";
import { writeArtifacts } from "./artifacts.js";
import {
  buildClaudeRepairPrompt,
  buildCodexPrompt,
  buildExecutionPacket,
  buildPrPackage
} from "./templates.js";

export async function runTask(task, config) {
  const repoAudit = await inspectRepository(task.targetRepo, config);
  const relatedRepos = await listOwnerRepos(config);
  const transferAudit = classifyTransferCandidates(relatedRepos);

  const input = {
    ...task,
    repoAudit,
    defaultBranch: repoAudit.defaultBranch,
    goal: task.goal || task.taskDescription
  };

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

  const outputDir = path.join(config.artifactsDir, task.targetRepo.replace("/", "__"));
  const artifactPaths = await writeArtifacts(outputDir, {
    codexPrompt,
    claudePrompt,
    prMarkdown,
    executionPacket
  });

  return {
    taskUnderstanding: {
      targetRepo: task.targetRepo,
      mode: task.mode,
      taskDescription: task.taskDescription,
      constraints: task.constraints,
      goal: task.goal
    },
    repoAudit,
    transferAudit,
    codexPrompt,
    claudePrompt,
    prPackage,
    executionPacket,
    artifactPaths,
    patchPath: artifactPaths.find((p) => p.endsWith("changes.patch")) || null
  };
}

function classifyTransferCandidates(repos) {
  const preferred = ["decide.engine-tools", "qaz"];
  return repos
    .filter((r) => preferred.includes(r.name) || /tool|engine|prompt|agent|orchestr/i.test(r.name))
    .slice(0, 10)
    .map((r) => ({
      repo: r.fullName,
      rationale: "Potential reusable orchestration logic.",
      classification: preferred.includes(r.name) ? "adapt" : "document only"
    }));
}
