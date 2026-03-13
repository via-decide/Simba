export function buildCodexPrompt(input) {
  return `You are working in repository ${input.targetRepo} on branch ${input.defaultBranch}.

MISSION
${input.taskDescription}

CONSTRAINTS
${input.constraints || "No additional constraints provided."}

PROCESS (MANDATORY)
1. Read README.md and AGENTS.md before editing.
2. Audit architecture before coding. Summarize current behavior.
3. Preserve unrelated working code. Prefer additive modular changes.
4. Implement the smallest safe change set for the stated goal.
5. Run validation commands and fix discovered issues.
6. Self-review for regressions, missing env wiring, and docs drift.
7. Return complete final file contents for every modified or created file.

REPO AUDIT CONTEXT
- Description: ${input.repoAudit.description}
- Primary language: ${input.repoAudit.language}
- README snippet:
${input.repoAudit.readmeSnippet}

- AGENTS snippet:
${input.repoAudit.agentsSnippet}

OUTPUT REQUIREMENTS
- Include: implementation summary, checks run, risks, rollback notes.
- Generate branch + PR package.
- Keep prompts deterministic and preservation-first.`;
}

export function buildClaudeRepairPrompt(input) {
  return `Repair mode for repository ${input.targetRepo}.

TARGET
Validate and repair only the files touched by the previous implementation.

TASK
${input.taskDescription}

RULES
1. Audit touched files first and identify regressions.
2. Preserve architecture and naming conventions.
3. Make minimal repairs only; do not expand scope.
4. Re-run checks and provide concise root-cause notes.
5. Return complete contents for changed files only.

REPO CONTEXT
- README snippet:
${input.repoAudit.readmeSnippet}
- AGENTS snippet:
${input.repoAudit.agentsSnippet}
- package.json snippet:
${input.repoAudit.packageSnippet}
- pyproject snippet:
${input.repoAudit.pyprojectSnippet}`;
}

export function buildPrPackage(input) {
  const branch = suggestBranchName(input.taskDescription);
  const title = suggestPrTitle(input.taskDescription);

  const body = [
    "## Summary",
    `- Repo orchestration task for ${input.targetRepo}`,
    `- Goal: ${input.goal}`,
    "",
    "## Testing Checklist",
    "- [ ] Run unit/integration tests",
    "- [ ] Validate Telegram command flow",
    "- [ ] Validate generated artifact files",
    "",
    "## Risks",
    "- Prompt quality depends on repository metadata completeness.",
    "- GitHub API limits/token scope can block deep inspection.",
    "",
    "## Rollback",
    "- Revert branch and remove generated artifact files if workflow output is invalid."
  ].join("\n");

  return { branch, title, body };
}

export function buildExecutionPacket(input, packageData) {
  return {
    repo: input.targetRepo,
    mode: input.mode,
    branch: packageData.branch,
    files_to_create: ["codex-task.md", "claude-repair-task.md", "pr-package.md", "execution.json"],
    files_to_modify: [],
    codex_prompt_path: "codex-task.md",
    claude_prompt_path: "claude-repair-task.md"
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
}

function suggestBranchName(taskDescription) {
  const stem = slugify(taskDescription || "repo-orchestration-update") || "repo-orchestration-update";
  return `simba/${stem}`;
}

function suggestPrTitle(taskDescription) {
  const trimmed = (taskDescription || "Repo orchestration update").trim();
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
}
