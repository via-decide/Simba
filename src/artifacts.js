import fs from "node:fs/promises";
import path from "node:path";

export async function writeArtifacts(baseDir, payload) {
  await fs.mkdir(baseDir, { recursive: true });

  const files = {
    "codex-task.md": payload.codexPrompt,
    "claude-repair-task.md": payload.claudePrompt,
    "pr-package.md": payload.prMarkdown,
    "execution.json": JSON.stringify(payload.executionPacket, null, 2)
  };

  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, name);
    await fs.writeFile(fullPath, content, "utf8");
    written.push(fullPath);
  }

  return written;
}
