/**
 * decide-engine-bridge.js
 *
 * Bridges Simba's backend to the decide.engine-tools repo architecture.
 *
 * Provides:
 *   - CATEGORY_MAP  : canonical category aliases matching tool-registry.js
 *   - ENGINE_TOOL_IDS : set of known engine/simulation-layer tool IDs (from tool-registry.js)
 *   - fetchRegistryConfig : fetch a tool's config.json from the live GitHub repo
 *   - fetchAllRegisteredTools : load all importableToolDirs config.json entries
 *   - discoverMissingTools : compare live registry against a catalog
 *   - buildEngineAwareTask : build a Simba task description with engine-aware constraints
 *   - resolveToolCategory : normalise a raw category string the same way tool-registry.js does
 *   - formatRegistryReport : human-readable summary for Telegram
 */

// ─── Constants mirrored from shared/tool-registry.js ─────────────────────────

export const CATEGORY_MAP = {
  creators: "creators",
  coders: "coders",
  researchers: "researchers",
  operators: "business",
  founders: "business",
  students: "education",
  gamers: "games",
  engine: "simulations",
  system: "system",
  misc: "misc"
};

export const ENGINE_TOOL_IDS = new Set([
  "engine-state-manager",
  "llm-action-parser",
  "daily-weather-replenisher",
  "admin-moderation-panel",
  "simulation-runner",
  "player-signup",
  "orchard-profile-builder",
  "root-strength-calculator",
  "trunk-growth-calculator",
  "fruit-yield-engine",
  "daily-quest-generator",
  "weekly-harvest-engine",
  "thirty-day-promotion-engine",
  "fair-ranking-engine",
  "seed-exchange",
  "fruit-sharing",
  "circle-builder",
  "peer-validation-engine",
  "trust-score-engine",
  "recruiter-dashboard",
  "orchard-discovery-search",
  "hire-readiness-scorer",
  "four-direction-pipeline",
  "growth-path-recommender",
  "ai-coach-console",
  "seed-quality-scorer",
  "meta-health-dashboard",
  "synthetic-player-generator",
  "wave1-simulation-runner",
  "balance-dashboard",
  "growth-milestone-engine"
]);

// All tool directories registered in importableToolDirs in tool-registry.js
export const IMPORTABLE_TOOL_DIRS = [
  "tools/promptalchemy", "tools/script-generator", "tools/spec-builder",
  "tools/code-generator", "tools/code-reviewer", "tools/tool-router",
  "tools/export-studio", "tools/template-vault", "tools/idea-remixer",
  "tools/task-splitter", "tools/prompt-compare", "tools/repo-improvement-brief",
  "tools/workflow-template-gallery", "tools/tool-search-discovery",
  "tools/context-packager", "tools/output-evaluator",
  "tools/engine/player-signup", "tools/engine/orchard-profile-builder",
  "tools/engine/starter-farm-generator", "tools/engine/root-strength-calculator",
  "tools/engine/trunk-growth-calculator", "tools/engine/fruit-yield-engine",
  "tools/engine/daily-quest-generator", "tools/engine/weekly-harvest-engine",
  "tools/engine/thirty-day-promotion-engine", "tools/engine/fair-ranking-engine",
  "tools/engine/seed-exchange", "tools/engine/fruit-sharing",
  "tools/engine/circle-builder", "tools/engine/peer-validation-engine",
  "tools/engine/trust-score-engine", "tools/engine/recruiter-dashboard",
  "tools/engine/orchard-discovery-search", "tools/engine/hire-readiness-scorer",
  "tools/engine/four-direction-pipeline", "tools/engine/growth-path-recommender",
  "tools/engine/ai-coach-console", "tools/engine/simulation-runner",
  "tools/engine/seed-quality-scorer", "tools/engine/meta-health-dashboard",
  "tools/engine/synthetic-player-generator", "tools/engine/wave1-simulation-runner",
  "tools/engine/balance-dashboard", "tools/engine/growth-milestone-engine",
  "tools/games/hex-wars", "tools/games/wings-of-fire-quiz",
  "tools/engine/script-generator-files", "tools/engine/layer1-swipe-crucible"
];

// ─── Category resolution ───────────────────────────────────────────────────────

/**
 * Normalise a raw category string the same way tool-registry.js does.
 * @param {string} category
 * @returns {string}
 */
export function resolveToolCategory(category) {
  return CATEGORY_MAP[category] || category || "misc";
}

/**
 * Returns true if a tool ID is an engine/simulation-layer internal tool.
 * @param {string} id
 * @param {string} [category]
 * @param {string} [entryPath]
 * @returns {boolean}
 */
export function isEngineTool(id, category, entryPath = "") {
  if (ENGINE_TOOL_IDS.has(id)) return true;
  const normalized = resolveToolCategory(category);
  if (normalized === "simulations" || normalized === "system") return true;
  return entryPath.toLowerCase().startsWith("tools/engine/");
}

// ─── Live repo fetching ───────────────────────────────────────────────────────

const ENGINE_TOOLS_REPO = "via-decide/decide.engine-tools";

/**
 * Fetch a single tool's config.json from the live GitHub repo.
 * Returns null if not found or parse fails.
 *
 * @param {string} toolDir - e.g. "tools/promptalchemy"
 * @param {object} config  - Simba config (needs githubToken, githubApiBaseUrl)
 * @returns {Promise<object|null>}
 */
export async function fetchRegistryConfig(toolDir, config) {
  const [owner, repo] = ENGINE_TOOLS_REPO.split("/");
  const filePath = `${toolDir}/config.json`.replace(/^\//, "");
  const url = `${config.githubApiBaseUrl}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.encoding !== "base64" || !data.content) return null;

    const raw = Buffer.from(data.content, "base64").toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Load all tool config.json files from the live decide.engine-tools repo.
 * Mirrors ToolRegistry.loadImportedTools() from the browser side.
 *
 * @param {object} config - Simba config
 * @returns {Promise<Array<{ dir: string, meta: object }>>}
 */
export async function fetchAllRegisteredTools(config) {
  const results = await Promise.all(
    IMPORTABLE_TOOL_DIRS.map(async (dir) => {
      const meta = await fetchRegistryConfig(dir, config);
      if (!meta) return null;
      const id = meta.id || dir.split("/").pop();
      return {
        dir,
        id,
        name: meta.name || id,
        description: meta.description || "",
        category: resolveToolCategory(meta.category),
        isEngineTool: isEngineTool(id, meta.category, meta.entry || `${dir}/index.html`),
        tags: Array.isArray(meta.tags) ? meta.tags : []
      };
    })
  );

  return results.filter(Boolean);
}

// ─── Tool gap discovery ───────────────────────────────────────────────────────

/**
 * Compares a local tool catalog (like TOOL_CATALOG in task-generator.js)
 * against the live registered tools in the engine repo.
 *
 * Returns tools that are catalogued but not yet registered.
 *
 * @param {object} catalog   - { category: [{ id, title, description }] }
 * @param {object} config    - Simba config
 * @returns {Promise<Array<{ category, id, title, description, rationale }>>}
 */
export async function discoverMissingTools(catalog, config) {
  let liveIds;
  try {
    const liveTools = await fetchAllRegisteredTools(config);
    liveIds = new Set(liveTools.map((t) => t.id));
  } catch {
    liveIds = new Set();
  }

  // Also include the dirs themselves as known ids (dir basename)
  for (const dir of IMPORTABLE_TOOL_DIRS) {
    liveIds.add(dir.split("/").pop());
  }

  const missing = [];
  for (const [category, tools] of Object.entries(catalog)) {
    for (const tool of tools) {
      if (!liveIds.has(tool.id)) {
        missing.push({ category, ...tool });
      }
    }
  }

  return missing;
}

// ─── Engine-aware task builder ────────────────────────────────────────────────

/**
 * Build a Simba task description that is aware of the decide.engine-tools
 * architecture (registry, router, shared modules, category dirs).
 *
 * This is a richer replacement for buildTaskDefinition() in task-generator.js,
 * adding explicit registration, routing, shared CSS/storage usage, and
 * engine-layer guidance.
 *
 * @param {{ id, title, description, category, isGame?, isEngine? }} tool
 * @returns {object} - compatible with runExecutionPipeline()
 */
export function buildEngineAwareTask({ id, title, description, category, isGame = false, isEngine = false }) {
  const categoryNorm = resolveToolCategory(category);
  const isEngineLayer = isEngine || isEngineTool(id, category);

  let toolDir;
  if (isEngineLayer) {
    toolDir = `tools/engine/${id}`;
  } else if (isGame || categoryNorm === "games") {
    toolDir = `tools/games/${id}`;
  } else {
    toolDir = `tools/${id}`;
  }

  const sharedDeps = isEngineLayer
    ? "shared/engine-utils.js, shared/engine-models.js, shared/tool-storage.js, shared/shared.css"
    : "shared/tool-storage.js, shared/shared.css";

  const taskDescription = [
    `Add a new standalone tool "${title}" (id: ${id}) at ${toolDir}/.`,
    `Description: "${description}".`,
    `Category: "${category}" (normalized: "${categoryNorm}").`,
    `Required files: ${toolDir}/config.json, ${toolDir}/index.html, ${toolDir}/tool.js.`,
    `config.json must include: id, name, description, category ("${category}"), audience, inputs, outputs, tags.`,
    isEngineLayer
      ? `This is an engine layer tool. Load ${sharedDeps}. Follow engine-models.js template() and baseMetrics() patterns.`
      : `Load ${sharedDeps}. Use ToolStorage for persistence. Do not use external frameworks.`,
    `Register in shared/tool-registry.js: add "${toolDir}" to importableToolDirs array.`,
    `Register in router.js: add to the tool path static map and modularTools if present.`,
    `Update index.html: confirm the categorized tool grid will discover the tool via registry.`,
    `Update README.md: add tool entry under the correct category section.`,
    `Do NOT modify any existing tool folder. Do NOT break existing shared utilities.`
  ].join(" ");

  const constraints = [
    "preserve all existing tool folders and shared modules",
    "additive changes only — never remove or overwrite existing files",
    "do not break category routing or tool discovery",
    "shared/tool-registry.js importableToolDirs: append only, do not reorder",
    "router.js: add to static map only, do not restructure",
    "config.json must pass normalizeTool() without errors",
    "tool.js must work standalone in browser without bundler",
    "use minimal corrective edits — prefer smallest safe changeset"
  ].join("; ");

  return {
    targetRepo: ENGINE_TOOLS_REPO,
    mode: "codex_then_claude",
    taskDescription,
    constraints,
    goal: `Produce working ${id} tool with config.json, index.html, tool.js — registered in tool-registry.js and router.js, categorized under "${categoryNorm}".`,
    metadata: {
      category: categoryNorm,
      toolId: id,
      toolTitle: title,
      toolDir,
      isEngineLayer,
      isGame: isGame || categoryNorm === "games",
      generatedAt: new Date().toISOString(),
      source: "decide-engine-bridge"
    }
  };
}

// ─── Telegram report formatting ───────────────────────────────────────────────

/**
 * Format a live registry report for Telegram.
 *
 * @param {Array<{ dir, id, name, category, isEngineTool }>} tools
 * @returns {string}
 */
export function formatRegistryReport(tools) {
  if (!tools.length) return "⚠ No tools discovered from live registry.";

  const byCategory = {};
  for (const tool of tools) {
    const cat = tool.category || "misc";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(tool);
  }

  const lines = [`📦 decide.engine-tools registry (${tools.length} tools):\n`];
  for (const [cat, list] of Object.entries(byCategory).sort()) {
    lines.push(`[${cat}] (${list.length})`);
    for (const t of list.slice(0, 5)) {
      lines.push(`  • ${t.id}${t.isEngineTool ? " 🔧" : ""}`);
    }
    if (list.length > 5) lines.push(`  ... +${list.length - 5} more`);
  }

  return lines.join("\n");
}

/**
 * Format the missing tool gap report for Telegram.
 *
 * @param {Array<{ category, id, title, description }>} missing
 * @returns {string}
 */
export function formatMissingToolsReport(missing) {
  if (!missing.length) return "✅ All catalogued tools are registered in the live repo.";

  const lines = [`🔍 Missing tools (${missing.length} gaps found):\n`];
  for (const t of missing.slice(0, 15)) {
    lines.push(`[${t.category}] ${t.id} — ${t.title}`);
  }
  if (missing.length > 15) lines.push(`... +${missing.length - 15} more`);
  lines.push("\nUse /generate to queue tasks for these tools.");

  return lines.join("\n");
}
