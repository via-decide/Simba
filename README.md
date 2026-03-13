# Simba

Simba is an execution-focused Telegram bot for repository orchestration. It accepts structured tasks from Telegram, audits a target repository through the GitHub API, and generates:

- preservation-first Codex task prompt
- narrow Claude repair prompt
- PR package (branch, title, description, risks, rollback)
- machine-readable execution packet JSON
- artifact files for manual or automated execution

## Current repository audit (baseline)

This repository originally contained:

- `index.html`: a static prompt/config builder page.
- `CLAUDBOT_SETUP_STATUS.md`: previous environment setup notes.

The bot implementation is additive and does not remove those files.

## Features

- Telegram commands:
  - `/start` and `/help`
  - `/repos` to inspect repos in the configured owner/org
  - `/task` for orchestration packet generation
- Target repo inspection:
  - reads repo metadata
  - attempts to read `README.md`, `AGENTS.md`, `package.json`, `pyproject.toml`
  - gracefully falls back when API/network access is restricted
- Prompt generation:
  - Codex prompt enforces audit-first, preservation-first behavior
  - Claude repair prompt enforces minimal-change repair flow
- PR package generation:
  - branch name suggestion
  - PR title/body
  - testing checklist, risks, rollback notes
- Artifacts output:
  - `codex-task.md`
  - `claude-repair-task.md`
  - `pr-package.md`
  - `execution.json`

## Telegram task format

Use `/task` followed by lines:

```text
repo: owner/repo
mode: codex | claude | codex_then_claude
task: describe the requested implementation
constraints: optional constraints
goal: optional desired outcome
```

## Environment

Copy `.env.example` and set real values.

Required:

- `TELEGRAM_BOT_TOKEN` (Telegram runtime only)
- `GITHUB_TOKEN`
- `GITHUB_OWNER`

Optional:

- `GITHUB_API_BASE_URL` (default `https://api.github.com`)
- `TELEGRAM_POLL_INTERVAL_MS` (default `3000`)
- `ARTIFACTS_DIR` (default `artifacts` for bot runtime, `.` for CLI packet generation if unset)
- `GITHUB_REPO_SCAN_LIMIT` (default `30`)

## Run

```bash
npm run check
npm start
```

## One-shot packet generation (no Telegram interaction)

This repository also includes a direct packet generator for a single task.

```bash
export GITHUB_TOKEN=...
export GITHUB_OWNER=via-decide
npm run generate:packet
```

Override defaults if needed:

```bash
TASK_REPO=via-decide/decide.engine-tools \
TASK_MODE=codex_then_claude \
TASK_DESCRIPTION="Add a new standalone tool called idea-remixer, integrate it safely into the current repo, and generate a PR package." \
TASK_CONSTRAINTS="preserve all existing tool folders; preserve standalone behavior; no unrelated deletions; update router/index/README only if needed" \
TASK_GOAL="Produce codex-task.md, claude-repair-task.md, pr-package.md, and execution.json" \
npm run generate:packet
```

## Telegram deployment readiness

- Uses long polling through Telegram Bot API (`getUpdates`) with no extra framework dependencies.
- Uses native Node.js `fetch` (Node 20+) and filesystem writes for artifact persistence.
- Works in container or VM deployment as long as environment variables are configured.
