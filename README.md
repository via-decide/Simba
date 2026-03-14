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
The bot implementation added in this upgrade is additive and does not remove those files.

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
- `TELEGRAM_BOT_TOKEN`
- `GITHUB_TOKEN`
- `GITHUB_OWNER`

Optional:

- `GITHUB_API_BASE_URL` (default `https://api.github.com`)
- `TELEGRAM_POLL_INTERVAL_MS` (default `3000`)
- `ARTIFACTS_DIR` (default `artifacts` for bot runtime, `.` for CLI packet generation if unset)
- `ARTIFACTS_DIR` (default `artifacts`)
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

## Notes about source-repo transfer audit

Direct network access to inspect specific upstream repositories may be restricted in some environments. When GitHub access is available, Simba still performs account/org repo discovery via `/repos` and task-time audit through GitHub APIs.

## Testing Simba through the Telegram bot

Simba now includes a bot execution test mode that can run a safe, stage-based dry-run pipeline from Telegram commands.

### Bot commands

- `/start` and `/help`: command help
- `/analyze <owner/repo>`: validates and inspects a repository
- `/improve <owner/repo>`: opens a preview card before execution
- `/status`: shows task id, current stage, retries, timestamp, and result
- `/resume`: retries the most recent task
- `/test`: runs a safe dry-run test task
- `/repos`: lists repos for configured owner/org

### Dry-run safety mode

`/improve` defaults to dry-run safety mode in bot testing.

In dry-run:
- no real push is performed
- no real PR is created
- commit/push/PR stages are simulated but still reported to Telegram

In live mode:
- push and PR creation are still gated by:
  - `SIMBA_ALLOW_LIVE_PUSH=true`
  - `SIMBA_ALLOW_LIVE_PR=true`

### Sample Telegram flow

1. `/start`
2. `/analyze octocat/Hello-World`
3. `/improve octocat/Hello-World`
4. tap **Run dry-run** in preview card
5. observe stage updates for: `PLAN`, `CODE_GENERATION`, `CODE_REPAIR`, `COMMIT`, `PUSH`, `PR_CREATION`, `COMPLETE`
6. `/status` to inspect the latest persisted execution state

### Local bot flow harness

Run the local harness to simulate command routing and execution without Telegram network polling:

```bash
node scripts/test-bot-flow.js
```

The harness feeds `/start`, `/analyze`, `/improve`, confirms dry-run via callback data, and then checks `/status` while capturing bot responses.

### Error handling format

Simba returns Telegram-safe structured errors containing:
- what failed
- likely cause
- whether retry is possible
- next action

Common errors covered:
- missing token (startup config validation)
- invalid repository format
- GitHub unreachable/fallback audit behavior
- live push/PR disabled by policy flags
