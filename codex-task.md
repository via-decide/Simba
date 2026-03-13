You are working in repository via-decide/decide.engine-tools on branch main.

MISSION
Add a new standalone tool called idea-remixer, integrate it safely into the current repo, and generate a PR package.

CONSTRAINTS
preserve all existing tool folders; preserve standalone behavior; no unrelated deletions; update router/index/README only if needed

PROCESS (MANDATORY)
1. Read README.md and AGENTS.md before editing.
2. Audit architecture before coding. Summarize current behavior.
3. Preserve unrelated working code. Prefer additive modular changes.
4. Implement the smallest safe change set for the stated goal.
5. Run validation commands and fix discovered issues.
6. Self-review for regressions, missing env wiring, and docs drift.
7. Return complete final file contents for every modified or created file.

REPO AUDIT CONTEXT
- Description: Repository audit fallback used: fetch failed
- Primary language: unknown
- README snippet:
not found

- AGENTS snippet:
not found

OUTPUT REQUIREMENTS
- Include: implementation summary, checks run, risks, rollback notes.
- Generate branch + PR package.
- Keep prompts deterministic and preservation-first.