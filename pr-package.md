Branch: simba/add-a-new-standalone-tool-called-idea-remixer-in
Title: Add a new standalone tool called idea-remixer, integrate it safely in...

## Summary
- Repo orchestration task for via-decide/decide.engine-tools
- Goal: Produce codex-task.md, claude-repair-task.md, pr-package.md, and execution.json

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate Telegram command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.