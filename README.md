# Simba v2

Telegram bot that orchestrates repository improvements via Codex/Claude prompt generation, GitHub branch creation, and automated PR opening.

## What Changed in v2

| Area | v1 | v2 |
|---|---|---|
| Pipeline stages | Simulated `sleep()` calls | Real GitHub API work at each stage |
| `/improve` flow | Fake progress messages | Audit → generate → commit → push → PR |
| `/task` flow | Separate orchestrator path | Unified through same pipeline |
| State engine | No write locking | Promise-chain lock + atomic writes |
| Commands | 8 commands | 13 commands (+/logs, /history, /cancel, /branches, /cleanup) |
| Security | None | Optional admin chat ID whitelist |
| Telegram | No message splitting | Auto-splits messages >4000 chars |
| Logging | Console only | Persistent per-chat log buffer |

## Commands

```
/help                  — command reference
/repos                 — list owner repositories
/analyze <owner/repo>  — inspect repo metadata
/improve <owner/repo>  — full pipeline with preview card
/task                  — structured multiline task input
/status                — active task status
/history               — recent task history
/logs [n]              — last n log entries
/cancel                — cancel active task
/branches <owner/repo> — list simba/* branches
/cleanup <owner/repo>  — delete stale simba/* branches
/resume                — re-run last failed task
```

## Setup

```bash
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_OWNER
# Set SIMBA_ALLOW_LIVE_PUSH=true and SIMBA_ALLOW_LIVE_PR=true for real pushes
node src/index.js
```

## Architecture

```
Telegram → simba-telegram-bot.js (polling)
         → simba-command-router.js (command dispatch)
         → simba-execution-pipeline.js (PLAN → AUDIT → GENERATE → ARTIFACTS → PUSH → PR → COMPLETE)
         → github.js (GitHub REST API)
         → templates.js (prompt/PR generation)
         → artifacts.js (disk writes)
         → simba-state-engine.js (file-based state with write lock)
```
