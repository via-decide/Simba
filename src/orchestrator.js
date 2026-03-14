import path from "node:path";
import { inspectRepository, listOwnerRepos, getBranchSha, createBranch, commitFile, createPullRequest } from "./github.js";
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

  // Attempt to create a real GitHub PR branch and PR
  let prUrl = null;
  let prError = null;
  try {
    prUrl = await pushPrToGitHub({
      task,
      repoAudit,
      prPackage,
      codexPrompt,
      claudePrompt,
      prMarkdown,
      outputDir,
      config
    });
  } catch (err) {
    prError = err.message;
  }

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
    assumptions: [
      "GitHub token has read/write access to target repo.",
      "Telegram delivery can include markdown text and short file path references."
    ],
    codexPrompt,
    claudePrompt,
    prPackage,
    executionPacket,
    artifactPaths,
    prUrl,
    prError,
    patchPath: artifactPaths.find((p) => p.endsWith("changes.patch")) || null
  };
}

/**
 * Create a branch in the target repo, commit all artifact files to it,
 * then open a pull request. Returns the PR HTML URL.
 */
async function pushPrToGitHub({ task, repoAudit, prPackage, codexPrompt, claudePrompt, prMarkdown, outputDir, config }) {
  const [owner, repo] = task.targetRepo.split("/");
  const base = repoAudit.defaultBranch || "main";
  const branch = prPackage.branch;

  // Get SHA of the base branch HEAD
  const baseSha = await getBranchSha(owner, repo, base, config);

  // Create the new branch
  await createBranch(owner, repo, branch, baseSha, config);

  // Commit artifact files onto the branch
  const artifactDir = `artifacts/${task.targetRepo.replace("/", "__")}`;
  const files = {
    [`${artifactDir}/codex-task.md`]: codexPrompt,
    [`${artifactDir}/claude-repair-task.md`]: claudePrompt,
    [`${artifactDir}/pr-package.md`]: prMarkdown
  };

  for (const [filePath, content] of Object.entries(files)) {
    await commitFile(owner, repo, filePath, content, `simba: add orchestration artifacts for task`, branch, config);
  }

  // Create the PR
  const pr = await createPullRequest(owner, repo, branch, base, prPackage.title, prPackage.body, config);
  return pr.url;
}

function classifyTransferCandidates(repos) {
  const preferred = ["decide.engine-tools", "qaz"];
  return repos
    .filter((repo) => preferred.includes(repo.name) || /tool|engine|prompt|agent|orchestr/i.test(repo.name))
    .slice(0, 10)
    .map((repo) => ({
      repo: repo.fullName,
      rationale: "Potential reusable orchestration or prompt logic based on repository name.",
      classification: preferred.includes(repo.name) ? "adapt" : "document only"
    }));
}

export function parseTaskMessage(message) {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const map = {};

  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    map[key] = value;
  }

  const parsed = {
    targetRepo: map.repo || map.target_repo || "",
    mode: (map.mode || "codex_then_claude").toLowerCase(),
    taskDescription: map.task || map.description || "",
    constraints: map.constraints || "",
    goal: map.goal || ""
  };

  if (!parsed.targetRepo || !parsed.taskDescription) {
    throw new Error("Task message must include at least repo: owner/name and task: description");
  }

  return parsed;
}

export function formatTelegramResult(result) {
  const lines = [
    "✅ Simba orchestration packet created",
    `Repo: ${result.taskUnderstanding.targetRepo}`,
    `Mode: ${result.taskUnderstanding.mode}`,
    "",
    "Repo audit:",
    `- Branch: ${result.repoAudit.defaultBranch}`,
    `- Language: ${result.repoAudit.language}`,
    `- README found: ${result.repoAudit.readmeSnippet !== "not found" ? "yes" : "no"}`,
    `- AGENTS found: ${result.repoAudit.agentsSnippet !== "not found" ? "yes" : "no"}`,
    "",
    "PR package:",
    `- Branch: ${result.prPackage.branch}`,
    `- Title: ${result.prPackage.title}`,
    result.prUrl
      ? `- PR URL: ${result.prUrl}`
      : result.prError
        ? `- PR creation failed: ${result.prError}`
        : "- PR URL: not created (check SIMBA_ALLOW_LIVE_PR)",
    "",
    "Artifacts:",
    ...result.artifactPaths.map((p) => `- ${p}`)
  ];

  if (result.patchPath) {
    lines.push("");
    lines.push("Apply patch:");
    lines.push(`  git apply ${result.patchPath}`);
  }

  return lines.join("\n");
}
