/**
 * task-parser.js
 *
 * Robust task message parser for Simba.
 *
 * Handles all known Telegram input formats:
 *
 *   Format A — YAML-style (primary, multiline):
 *     repo: via-decide/decide.engine-tools
 *     mode: codex_then_claude
 *     task: create idea-remixer tool
 *     constraints: preserve existing tools
 *     goal: working standalone tool
 *
 *   Format B — JSON object:
 *     {"repo":"via-decide/decide.engine-tools","mode":"codex_then_claude","task":"create tool"}
 *
 *   Format C — Inline/single-line YAML (Telegram sometimes strips newlines):
 *     repo: via-decide/decide.engine-tools mode: codex_then_claude task: create tool
 *
 * Also provides:
 *   - extractJson(text)    → safely extract JSON from AI responses that contain extra text
 *   - safeJsonParse(text)  → JSON.parse with extraction fallback and structured errors
 *   - truncateForTelegram  → keep messages within Telegram's 4096-char limit
 *   - sanitizeTelegram     → strip invisible / non-ASCII-safe characters Telegram injects
 */

// ─── Telegram invisible/problematic characters ───────────────────────────────

const SANITIZE_MAP = [
  [/\u200B/g, ""],          // zero-width space
  [/\u200C/g, ""],          // zero-width non-joiner
  [/\u200D/g, ""],          // zero-width joiner
  [/\uFEFF/g, ""],          // BOM / zero-width no-break space
  [/\u00A0/g, " "],         // non-breaking space → regular space
  [/\u2011/g, "-"],         // non-breaking hyphen → hyphen
  [/\u2012/g, "-"],         // figure dash → hyphen
  [/\u2013/g, "-"],         // en dash → hyphen
  [/\u2014/g, "-"],         // em dash → hyphen
  [/\u2018/g, "'"],         // left single quote → apostrophe
  [/\u2019/g, "'"],         // right single quote → apostrophe
  [/\u201C/g, '"'],         // left double quote → quote
  [/\u201D/g, '"'],         // right double quote → quote
  [/\u2026/g, "..."],       // ellipsis
  [/\r\n/g, "\n"],          // Windows line endings → Unix
  [/\r/g, "\n"],            // bare CR → newline
];

const TASK_FIELD_KEYS = new Set([
  "repo",
  "target_repo",
  "mode",
  "task",
  "description",
  "constraints",
  "goal"
]);

const TASK_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_ -]{0,30}):\s*(.*)$/;
const USER_INSTRUCTIONS_MARKER = /(?:^|\n)(?:#\s*)?User-provided custom instructions\s*\n/i;

/**
 * Strip and normalize invisible/problematic characters that Telegram
 * often introduces in formatted messages.
 */
export function sanitizeTelegram(text) {
  if (typeof text !== "string") return "";
  let out = text;
  for (const [pattern, replacement] of SANITIZE_MAP) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ─── JSON extraction from AI responses ───────────────────────────────────────

/**
 * Extract a JSON object from a string that may contain surrounding text.
 *
 * Handles:
 *   - Plain JSON:   {"key":"val"}
 *   - JSON in markdown code block:  ```json\n{...}\n```
 *   - JSON with preamble:  "Here is the result:\n{...}"
 *   - JSON with postamble: "{...}\n\nLet me know if you need changes."
 *
 * Returns the raw JSON string, or null if nothing valid found.
 */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const sanitized = sanitizeTelegram(text);

  // 1. Try markdown code block first: ```json\n{...}\n```
  const codeBlock = sanitized.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlock) {
    const candidate = codeBlock[1].trim();
    if (isValidJson(candidate)) return candidate;
  }

  // 2. Find outermost { ... } span
  const first = sanitized.indexOf("{");
  const last = sanitized.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const candidate = sanitized.slice(first, last + 1).trim();
  if (isValidJson(candidate)) return candidate;

  // 3. Walk inward looking for a valid JSON sub-string (handles truncation)
  // Try progressively smaller windows
  for (let end = last; end > first; end = sanitized.lastIndexOf("}", end - 1)) {
    const sub = sanitized.slice(first, end + 1);
    if (isValidJson(sub)) return sub;
    if (end === first) break;
  }

  return null;
}

function isValidJson(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON.parse with automatic extraction fallback.
 *
 * If direct parse fails:
 *   1. Try extractJson to find JSON within the text
 *   2. Log the error with context
 *   3. Throw a structured error (never a raw SyntaxError)
 *
 * @param {string} text - raw text to parse
 * @param {string} [context] - label for logging (e.g. "AI response")
 * @returns {*} parsed value
 * @throws {Error} structured parse error
 */
export function safeJsonParse(text, context = "input") {
  const sanitized = sanitizeTelegram(text || "");

  // Attempt 1: direct parse
  try {
    return JSON.parse(sanitized);
  } catch (directErr) {
    // log raw parse failure
    console.warn(`[task-parser] JSON.parse failed for ${context}:`, directErr.message);
    console.warn(`[task-parser] raw (first 200):`, sanitized.slice(0, 200));
  }

  // Attempt 2: extract embedded JSON
  const extracted = extractJson(sanitized);
  if (extracted) {
    try {
      const result = JSON.parse(extracted);
      console.log(`[task-parser] JSON extraction succeeded for ${context}`);
      return result;
    } catch (extractErr) {
      console.warn(`[task-parser] Extracted JSON still invalid for ${context}:`, extractErr.message);
      console.warn(`[task-parser] extracted (first 200):`, extracted.slice(0, 200));
    }
  }

  // Attempt 3: attempt basic repair (trailing comma, missing closing brace)
  const repaired = attemptJsonRepair(sanitized);
  if (repaired && repaired !== sanitized) {
    try {
      const result = JSON.parse(repaired);
      console.log(`[task-parser] JSON repair succeeded for ${context}`);
      return result;
    } catch {
      // repair didn't help
    }
  }

  throw new Error(
    `Could not parse ${context} as JSON. ` +
    `Input starts with: "${sanitized.slice(0, 60).replace(/\n/g, "\\n")}"`
  );
}

/**
 * Attempt basic JSON repair:
 *   - Remove trailing commas before } or ]
 *   - Add missing closing braces/brackets
 */
function attemptJsonRepair(text) {
  try {
    let s = text.trim();
    // Remove trailing commas
    s = s.replace(/,\s*([}\]])/g, "$1");
    // If starts with { but doesn't end with }, add it
    if (s.startsWith("{") && !s.endsWith("}")) s += "}";
    // If starts with [ but doesn't end with ], add it
    if (s.startsWith("[") && !s.endsWith("]")) s += "]";
    return s;
  } catch {
    return text;
  }
}

// ─── Task message parser ──────────────────────────────────────────────────────

/**
 * Parse a /task body into a normalized task object.
 *
 * Supports three input formats (auto-detected):
 *
 *   A) YAML-style multiline (primary format):
 *      repo: via-decide/decide.engine-tools
 *      mode: codex_then_claude
 *      task: create idea-remixer tool
 *
 *   B) JSON object:
 *      {"repo":"via-decide/decide.engine-tools","task":"create idea-remixer tool"}
 *
 *   C) Inline YAML (single line, space-separated fields):
 *      repo: via-decide/decide.engine-tools mode: codex_then_claude task: create tool
 *
 * Returns a normalized task object:
 * {
 *   targetRepo: string,
 *   mode: string,
 *   taskDescription: string,
 *   constraints: string,
 *   goal: string
 * }
 *
 * Throws a descriptive error if repo or task cannot be determined.
 */
export function parseTaskMessage(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Task message is empty.");
  }

  const cleaned = sanitizeTelegram(stripTaskCommandPrefix(text)).trim();

  if (!cleaned) {
    throw new Error("Task message is empty after sanitization.");
  }

  console.log(`[task-parser] parsing (first 120): ${cleaned.slice(0, 120).replace(/\n/g, "\\n")}`);

  // ── Format B: JSON object ──
  if (cleaned.startsWith("{")) {
    return parseJsonTask(cleaned);
  }

  // ── Formats A + C: YAML-style ──
  // Detect inline: no newlines but multiple "key:" tokens on one line
  const hasNewlines = cleaned.includes("\n");
  if (!hasNewlines && looksLikeInlineYaml(cleaned)) {
    return parseInlineYaml(cleaned);
  }

  // Standard multiline YAML
  return parseYamlTask(cleaned);
}

function stripTaskCommandPrefix(text) {
  return text.replace(/^\/task\b\s*/i, "");
}

// ─── Format B: JSON ───────────────────────────────────────────────────────────

function parseJsonTask(text) {
  let obj;
  try {
    obj = safeJsonParse(text, "task message");
  } catch (err) {
    throw new Error(`JSON task parse failed: ${err.message}`);
  }

  const targetRepo = String(obj.repo || obj.targetRepo || obj.target_repo || "").trim();
  const taskDescription = String(obj.task || obj.taskDescription || obj.task_description || obj.description || "").trim();
  const mode = String(obj.mode || "codex_then_claude").trim().toLowerCase();
  const constraints = String(obj.constraints || obj.customInstructions || "").trim();
  const goal = String(obj.goal || "").trim();

  validateRequired({ targetRepo, taskDescription });
  return { targetRepo, mode: normalizeMode(mode), taskDescription, constraints, goal };
}

// ─── Format A: Multiline YAML ────────────────────────────────────────────────

/**
 * Parse multiline YAML-style task body.
 *
 * Supports block scalars like `task: >` / `task: |`, indented continuations,
 * and appended custom-instruction sections often pasted after the main task.
 */
function parseYamlTask(text) {
  const { body, customInstructions } = splitCustomInstructions(text);
  const lines = body.split("\n");
  const map = {};
  let lastKey = null;
  let blockKey = null;
  let blockStyle = null;
  let blockIndent = 0;
  let blockLines = [];

  const flushBlock = () => {
    if (!blockKey) return;
    map[blockKey] = normalizeBlockValue(blockLines, blockStyle);
    lastKey = blockKey;
    blockKey = null;
    blockStyle = null;
    blockIndent = 0;
    blockLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    const trimmed = line.trim();

    if (blockKey) {
      const indent = leadingWhitespace(line);
      const nextKey = indent === 0 ? parseTaskKeyLine(trimmed) : null;
      if (trimmed && nextKey && TASK_FIELD_KEYS.has(nextKey.key)) {
        flushBlock();
      } else {
        if (!trimmed) {
          blockLines.push("");
          continue;
        }
        if (blockIndent === null) {
          blockIndent = indent;
        }
        const normalizedLine = indent >= blockIndent ? line.slice(blockIndent) : trimmed;
        blockLines.push(normalizedLine);
        continue;
      }
    }

    if (!trimmed) {
      if (lastKey && map[lastKey]) {
        map[lastKey] = `${map[lastKey]}\n`;
      }
      continue;
    }

    const parsed = parseTaskKeyLine(trimmed);
    if (parsed && TASK_FIELD_KEYS.has(parsed.key)) {
      const { key, value } = parsed;
      if (value === ">" || value === "|") {
        blockKey = key;
        blockStyle = value;
        blockIndent = null;
        blockLines = [];
      } else {
        map[key] = value;
        lastKey = key;
      }
      continue;
    }

    if (lastKey) {
      const joiner = map[lastKey]?.endsWith("\n") ? "" : " ";
      map[lastKey] = `${map[lastKey] || ""}${joiner}${trimmed}`.trim();
    }
  }

  flushBlock();

  const task = buildTaskFromMap(map);
  task.constraints = appendSection(task.constraints, customInstructions);
  return task;
}

function splitCustomInstructions(text) {
  const match = USER_INSTRUCTIONS_MARKER.exec(text);
  if (!match) {
    return { body: text, customInstructions: "" };
  }

  const markerStart = match.index;
  const markerText = match[0].trim();
  const body = text.slice(0, markerStart).trimEnd();
  const customInstructions = [markerText, text.slice(markerStart + match[0].length).trim()].filter(Boolean).join("\n");
  return { body, customInstructions };
}

function parseTaskKeyLine(line) {
  const match = line.match(TASK_KEY_PATTERN);
  if (!match) return null;
  const key = match[1].trim().toLowerCase().replace(/[\s-]+/g, "_");
  return { key, value: match[2].trim() };
}

function leadingWhitespace(line) {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function normalizeBlockValue(lines, style) {
  if (!lines.length) return "";
  const minIndent = lines
    .filter((line) => line.trim())
    .reduce((min, line) => Math.min(min, leadingWhitespace(line)), Infinity);

  const normalizedLines = lines.map((line) => {
    if (!line.trim()) return "";
    if (Number.isFinite(minIndent) && minIndent > 0) {
      return line.slice(minIndent);
    }
    return line;
  });

  if (style === "|") {
    return normalizedLines.join("\n").trim();
  }

  return normalizedLines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function appendSection(existing, addition) {
  const left = (existing || "").trim();
  const right = (addition || "").trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

// ─── Format C: Inline YAML ───────────────────────────────────────────────────

/**
 * Detect if the text looks like space-separated inline YAML keys.
 * e.g.: "repo: via-decide/x mode: codex task: create tool"
 */
function looksLikeInlineYaml(text) {
  return /\brepo\s*:/.test(text) || /\btask\s*:/.test(text);
}

/**
 * Parse a single-line YAML-style message by splitting on key: patterns.
 * e.g.: "repo: owner/repo mode: codex task: create thing constraints: ..."
 */
function parseInlineYaml(text) {
  // Split on known key tokens followed by ":"
  const KEY_PATTERN = /\b(repo|target_repo|mode|task|description|constraints|goal)\s*:/gi;

  const map = {};
  const segments = [];
  let match;

  while ((match = KEY_PATTERN.exec(text)) !== null) {
    if (segments.length > 0) {
      segments[segments.length - 1].end = match.index;
    }
    segments.push({ key: match[1].toLowerCase(), start: match.index + match[0].length, end: text.length });
  }

  for (const seg of segments) {
    map[seg.key] = text.slice(seg.start, seg.end).trim();
  }

  return buildTaskFromMap(map);
}

// ─── Shared normalization ─────────────────────────────────────────────────────

function buildTaskFromMap(map) {
  const targetRepo = (map.repo || map.target_repo || "").trim();
  const mode = (map.mode || "codex_then_claude").trim().toLowerCase();
  const taskDescription = (map.task || map.description || "").trim();
  const constraints = (map.constraints || "").trim();
  const goal = (map.goal || "").trim();

  validateRequired({ targetRepo, taskDescription });

  return {
    targetRepo,
    mode: normalizeMode(mode),
    taskDescription,
    constraints,
    goal
  };
}

function normalizeMode(mode) {
  if (!mode) return "codex_then_claude";
  const aliases = new Map([
    ["repair", "claude_repair"],
    ["both", "codex_then_claude"]
  ]);
  return aliases.get(mode) || mode;
}

function validateRequired({ targetRepo, taskDescription }) {
  const errors = [];
  if (!targetRepo) errors.push("repo: (e.g. repo: owner/repo-name)");
  if (targetRepo && !targetRepo.includes("/")) errors.push("repo must be in owner/repo format");
  if (!taskDescription) errors.push("task: (e.g. task: describe what to do)");

  if (errors.length) {
    throw new Error(
      `Task message missing required fields:\n${errors.map((e) => `  • ${e}`).join("\n")}\n\n` +
      `Example:\nrepo: via-decide/decide.engine-tools\nmode: codex_then_claude\ntask: create idea-remixer tool`
    );
  }
}

// ─── Telegram message safety ──────────────────────────────────────────────────

const TELEGRAM_MAX_CHARS = 4000; // Telegram limit is 4096; keep buffer

/**
 * Truncate a string to fit within Telegram's message limit.
 * Appends a truncation notice if the text was cut.
 */
export function truncateForTelegram(text, maxLen = TELEGRAM_MAX_CHARS) {
  if (!text || text.length <= maxLen) return text;
  const notice = "\n… (truncated)";
  return text.slice(0, maxLen - notice.length) + notice;
}

/**
 * Split a long text into Telegram-safe chunks at natural boundaries
 * (newlines preferred over mid-word splits).
 */
export function chunksForTelegram(text, maxLen = TELEGRAM_MAX_CHARS) {
  if (!text) return [""];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within limit
    const window = remaining.slice(0, maxLen);
    const lastNl = window.lastIndexOf("\n");
    const cutAt = lastNl > maxLen / 2 ? lastNl + 1 : maxLen;

    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }

  return chunks;
}
