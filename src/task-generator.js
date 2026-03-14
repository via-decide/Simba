/**
 * task-generator.js
 *
 * Analyzes the decide.engine-tools repository structure,
 * identifies missing tools by category, and generates
 * safe task definitions that Simba can execute sequentially.
 */

import { inspectRepository } from "./github.js";

// ─── Tool catalog: what SHOULD exist ───

const TOOL_CATALOG = {
  games: [
    {
      id: "snake-game",
      title: "Snake Game",
      description: "Classic snake game — eat, grow, avoid walls.",
      rationale: "Zero game tools exist. Snake is the simplest starting point."
    },
    {
      id: "tetris-game",
      title: "Tetris Game",
      description: "Falling block puzzle with rotation and line clears.",
      rationale: "High engagement, universally known, tests spatial logic."
    },
    {
      id: "puzzle-generator",
      title: "Puzzle Generator",
      description: "Generate simple logic puzzles with answer checking.",
      rationale: "Reusable puzzle framework for education and engagement."
    },
    {
      id: "memory-match",
      title: "Memory Match",
      description: "Card flip memory game with scoring and timer.",
      rationale: "Simple, addictive, works well on mobile."
    },
    {
      id: "typing-speed",
      title: "Typing Speed Test",
      description: "Measure words-per-minute with accuracy tracking.",
      rationale: "Practical utility game, good for students."
    },
    {
      id: "quiz-engine",
      title: "Quiz Engine",
      description: "Configurable quiz tool with JSON-driven questions.",
      rationale: "Foundation for any topic-specific quiz tool."
    }
  ],

  business: [
    {
      id: "swot-analyzer",
      title: "SWOT Analyzer",
      description: "Structured SWOT analysis with export.",
      rationale: "No business tools under tools/. SWOT is the simplest entry."
    },
    {
      id: "okr-planner",
      title: "OKR Planner",
      description: "Define objectives and key results with progress tracking.",
      rationale: "Essential planning tool for founders and operators."
    },
    {
      id: "pricing-calculator",
      title: "Pricing Calculator",
      description: "Compare pricing models: freemium, tiered, usage-based.",
      rationale: "High-value decision tool for SaaS founders."
    },
    {
      id: "lean-canvas",
      title: "Lean Canvas Builder",
      description: "One-page business model canvas with export.",
      rationale: "Standard founder tool, highly shareable."
    }
  ],

  education: [
    {
      id: "flashcard-engine",
      title: "Flashcard Engine",
      description: "Spaced repetition flashcard tool with JSON decks.",
      rationale: "No education tools under tools/. Flashcards are universal."
    },
    {
      id: "study-timer",
      title: "Study Timer",
      description: "Pomodoro-style study timer with session tracking.",
      rationale: "Simple utility, high daily use for students."
    },
    {
      id: "note-summarizer",
      title: "Note Summarizer",
      description: "Paste notes, get structured summary with key points.",
      rationale: "Practical study tool with immediate utility."
    }
  ],

  researchers: [
    {
      id: "citation-formatter",
      title: "Citation Formatter",
      description: "Format citations in APA, MLA, Chicago styles.",
      rationale: "Fills a gap in research tooling."
    },
    {
      id: "data-visualizer",
      title: "Data Visualizer",
      description: "Paste CSV data, get chart visualizations.",
      rationale: "Makes research data accessible without setup."
    }
  ],

  creators: [
    {
      id: "color-palette-generator",
      title: "Color Palette Generator",
      description: "Generate harmonious color palettes from a seed color.",
      rationale: "Useful for all creators, highly visual."
    },
    {
      id: "social-post-planner",
      title: "Social Post Planner",
      description: "Plan social media posts across platforms with copy variants.",
      rationale: "Practical daily-use tool for content creators."
    }
  ],

  coders: [
    {
      id: "regex-tester",
      title: "Regex Tester",
      description: "Test regex patterns with live matching and group highlights.",
      rationale: "Daily-use developer tool."
    },
    {
      id: "json-formatter",
      title: "JSON Formatter",
      description: "Paste JSON, get formatted and validated output.",
      rationale: "Simple utility with high repeat use."
    },
    {
      id: "api-request-builder",
      title: "API Request Builder",
      description: "Build and test HTTP requests with headers and body.",
      rationale: "Fills a gap in the coders category."
    }
  ],

  system: [
    {
      id: "health-check-dashboard",
      title: "Health Check Dashboard",
      description: "Monitor tool ecosystem health: registry, router, broken links.",
      rationale: "Meta-tool that validates the entire ecosystem."
    }
  ]
};

// ─── Task template builder ───

function buildTaskDefinition({ id, title, description, category }) {
  const gamePrefix = category === "games" ? "tools/games/" : "tools/";

  return {
    targetRepo: "via-decide/decide.engine-tools",
    mode: "codex_then_claude",
    taskDescription: [
      `Add a new standalone tool called ${id} in ${gamePrefix}${id}/.`,
      `Title: "${title}".`,
      `Description: "${description}".`,
      `Category: "${category}".`,
      `The tool must contain: config.json, index.html, tool.js.`,
      category === "games"
        ? "The game must run in browser, use vanilla JS, have simple UI, no external frameworks."
        : "The tool must be standalone, use vanilla JS, load shared.css and tool-storage.js.",
      "Register in shared/tool-registry.js importableToolDirs array.",
      "Add to router.js modularTools map.",
      "Ensure index.html dynamic render picks it up.",
      "Add to README.md tool list."
    ].join(" "),
    constraints: [
      "preserve all existing tool folders",
      "preserve standalone behavior",
      "do not break category routing",
      "update router/index/registry/README only as needed",
      "use minimal corrective edits"
    ].join("; "),
    goal: `Produce working ${id} tool with config.json, index.html, tool.js, registered and routed.`,
    metadata: {
      category,
      toolId: id,
      toolTitle: title,
      generatedAt: new Date().toISOString(),
      source: "task-generator"
    }
  };
}

function buildTelegramTaskString(taskDef) {
  return [
    `repo: ${taskDef.targetRepo}`,
    `mode: ${taskDef.mode}`,
    `task: ${taskDef.taskDescription}`,
    `constraints: ${taskDef.constraints}`,
    `goal: ${taskDef.goal}`
  ].join("\n");
}

// ─── Discovery: what's already in the repo ───

async function discoverExistingTools(config) {
  const repo = "via-decide/decide.engine-tools";
  try {
    const audit = await inspectRepository(repo, config);
    const registrySnippet = audit.readmeSnippet || "";

    // Parse tool IDs from README (lines like "- `tool-id` — description")
    const existingIds = new Set();
    const idPattern = /`([a-z0-9-]+)`/g;
    let match;
    while ((match = idPattern.exec(registrySnippet)) !== null) {
      existingIds.add(match[1]);
    }

    return { existingIds, audit };
  } catch {
    return { existingIds: new Set(), audit: null };
  }
}

// Hard-coded known existing tools (fallback if API fails)
const KNOWN_EXISTING = new Set([
  "prompt-alchemy-main", "agent", "app-generator", "interview-prep",
  "student-research", "decision-brief-guide", "multi-source-research-explained",
  "sales-dashboard", "founder", "wings-of-fire-quiz",
  "promptalchemy", "script-generator", "spec-builder", "code-generator",
  "code-reviewer", "tool-router", "export-studio", "template-vault",
  "idea-remixer", "task-splitter", "prompt-compare", "repo-improvement-brief",
  "workflow-template-gallery", "tool-search-discovery", "context-packager",
  "output-evaluator"
]);

// ─── Main generation function ───

export async function generateTasks(config, options = {}) {
  const {
    categories = null,        // null = all, or ["games", "business"]
    maxTasks = 20,
    excludeIds = new Set(),   // already completed/pending task IDs
    prioritize = "games"      // which category first
  } = options;

  // Merge known + discovered
  let existingIds;
  try {
    const discovered = await discoverExistingTools(config);
    existingIds = new Set([...KNOWN_EXISTING, ...discovered.existingIds]);
  } catch {
    existingIds = new Set(KNOWN_EXISTING);
  }

  // Merge with user-excluded IDs (completed/pending tasks)
  const allExcluded = new Set([...existingIds, ...excludeIds]);

  // Build task list
  const tasks = [];
  const catalogCategories = categories
    ? categories.filter((c) => TOOL_CATALOG[c])
    : Object.keys(TOOL_CATALOG);

  // Sort: prioritized category first
  catalogCategories.sort((a, b) => {
    if (a === prioritize) return -1;
    if (b === prioritize) return 1;
    return 0;
  });

  for (const category of catalogCategories) {
    const tools = TOOL_CATALOG[category] || [];
    for (const tool of tools) {
      if (allExcluded.has(tool.id)) continue;
      if (tasks.length >= maxTasks) break;

      tasks.push(buildTaskDefinition({
        id: tool.id,
        title: tool.title,
        description: tool.description,
        category
      }));
    }
    if (tasks.length >= maxTasks) break;
  }

  return tasks;
}

// ─── Generate a single next task (for loop mode) ───

export async function generateNextTask(config, completedIds = [], pendingIds = []) {
  const excludeIds = new Set([...completedIds, ...pendingIds]);
  const tasks = await generateTasks(config, { maxTasks: 1, excludeIds });
  return tasks[0] || null;
}

// ─── Get catalog summary ───

export function getCatalogSummary() {
  const summary = {};
  for (const [category, tools] of Object.entries(TOOL_CATALOG)) {
    summary[category] = {
      total: tools.length,
      tools: tools.map((t) => t.id)
    };
  }
  return summary;
}

// ─── Format for display ───

export function formatTaskForTelegram(task) {
  return buildTelegramTaskString(task);
}

export function formatTaskListForTelegram(tasks) {
  if (!tasks.length) return "No tasks to generate. All catalog tools exist or are queued.";

  return tasks
    .map((t, i) => {
      const cat = t.metadata.category;
      const id = t.metadata.toolId;
      return `${i + 1}. [${cat}] ${id} — ${t.metadata.toolTitle}`;
    })
    .join("\n");
}

export { TOOL_CATALOG, KNOWN_EXISTING, buildTaskDefinition, buildTelegramTaskString };
