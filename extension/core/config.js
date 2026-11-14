// Default settings. Anything you put on the Options page overrides these.
// Objects (prefixes, classRoutes, theme) merge key by key; urlRoutes merge by id;
// your rules run before the default ones; everything else replaces the default.
import * as store from "./storage.js";

export const DEFAULTS = {
  // Typing one of these at the start forces a route. "route:mode" also sets Claude Code's mode.
  prefixes: {
    "!s": "search",
    "!search": "search",
    "!web": "claude",
    "!ask": "claude",
    "!gpt": "chatgpt",
    "!g": "gemini",
    "!deep": "claude-deep",
    "!code": "claude-code",
    "!plan": "claude-code:plan",
    "!fix": "claude-code:direct",
  },

  // Which route each kind of request goes to.
  classRoutes: { search: "search", ask: "claude", deep: "claude-deep", code: "claude-code" },
  fallbackClass: "search",

  // laya (vega model trained on tools/seed.jsonl), running locally (helper/install-laya.sh). On Enter, decides Google vs AI
  // when the classifier below is less than classifierTrust sure or nothing matched.
  // aiAt: laya's AI score needed to pick AI. Off, or slower than timeoutMs: the classifier's answer is used.
  laya: { enabled: true, url: "http://127.0.0.1:8770", timeoutMs: 2500, classifierTrust: 0.95, aiAt: 0.5 },

  // Classifier: below this confidence the fallback is used instead.
  classifierThreshold: 0.5,
  // false = while typing, only rules update the route label (the classifier runs on Enter).
  previewUsesClassifier: false,

  // Destinations that are just a link. Add your own here.
  urlRoutes: [
    { id: "search", label: "Google", cls: "search", template: "https://www.google.com/search?q={q}" },
    { id: "claude", label: "Claude", cls: "ask", template: "https://claude.ai/new?q={q}" },
    {
      id: "claude-deep", label: "Claude Research", cls: "deep", template: "https://claude.ai/new?q={q}",
      hint: "Turn on Research in the message box, then press send.",
    },
    { id: "chatgpt", label: "ChatGPT", cls: "ask", template: "https://chatgpt.com/?q={q}" },
    {
      id: "gemini", label: "Gemini", cls: "ask", template: "https://gemini.google.com/app", copy: true,
      hint: "Your text is on the clipboard. Paste it into Gemini.",
    },
  ],

  // Your own rules: { id, pattern, flags?, cls | route, mode?, priority? }
  rules: [],

  // Code projects. Mention a name and coding requests start Claude Code in that folder.
  projects: [], // e.g. { "name": "hub", "path": "/home/you/code/hub" }
  projectRoots: [], // folders the helper scans for git repos, e.g. "/home/you/code"

  // Put the cursor in the box on a new tab (Firefox otherwise focuses the address bar).
  focusBox: true,

  confirmCode: true, // Claude Code routes need a second Enter
  openIn: "current", // "current" tab or "new" tab
  keepHistory: true,

  widgets: ["clock", "recent", "links"],
  links: [
    { label: "Claude", url: "https://claude.ai" },
    { label: "GitHub", url: "https://github.com" },
  ],

  // CSS variables, e.g. { "accent": "#e07a5f", "radius": "14px" }
  theme: {},

  // Predictive moves (see docs/predictive-moves-contract.md). Turn single moves on in the drawer on the new tab.
  // shortcutAt: confidence the global shortcut (Meta+Shift+.) needs. layaStaging: ask laya when no rule matched.
  // layaBatteryMode: "ac_only" (laya only on AC; on battery just the rules), "always", "threshold" (on battery only at
  // layaBatteryMinPercent or more), or "never".
  moves: { enabled: true, shortcutAt: 0.85, layaStaging: true, layaBatteryMode: "ac_only", layaBatteryMinPercent: 40, layaLowPowerOverride: true },
  name: "", // for the banner greeting
  assetFolder: "", // where "Move N new files" puts design downloads, e.g. "/home/you/Pictures/assets"
  // Canvas: courses map a course id to { name, exts: ["pdf", "indd"] } (file types for "recent files").
  canvas: { host: "school.instructure.com", courses: {} },
  // Typed text → address, e.g. { "drive": "https://drive.google.com" }. Learned ones are added under these.
  navAliases: {},
};

function byId(defaults, user) {
  const out = new Map(defaults.map((d) => [d.id, d]));
  for (const u of user || []) out.set(u.id, { ...(out.get(u.id) || {}), ...u });
  return [...out.values()];
}

export function merge(user = {}) {
  const cfg = { ...DEFAULTS, ...user };
  for (const k of ["prefixes", "classRoutes", "theme", "laya", "moves", "canvas", "navAliases"]) cfg[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  cfg.canvas.courses = { ...DEFAULTS.canvas.courses, ...(user.canvas?.courses || {}) };
  cfg.urlRoutes = byId(DEFAULTS.urlRoutes, user.urlRoutes);
  cfg.rules = [...(user.rules || []), ...DEFAULTS.rules];
  return cfg;
}

export async function loadConfig() {
  const cfg = merge(await store.get("userConfig", {}));
  const scanned = await store.get("scannedProjects", { list: [] });
  const named = new Set(cfg.projects.map((p) => p.name.toLowerCase()));
  cfg.allProjects = [...cfg.projects, ...scanned.list.filter((p) => !named.has(p.name.toLowerCase()))];

  // What the helper learned from your history ("learned", see the contract) goes under your own settings.
  // Learned nav aliases only count once you've enabled that move in the drawer; yours always do.
  const learned = await store.get("learned", {});
  const moves = await store.get("moves", {});
  if (moves.nav_shortcut_interceptor?.status === "enabled") cfg.navAliases = { ...(learned.navAliases || {}), ...cfg.navAliases };
  cfg.canvas.courses = { ...(learned.canvasCourses || {}), ...cfg.canvas.courses };
  if (!cfg.name && learned.name) cfg.name = learned.name;
  return cfg;
}

export function applyTheme(cfg) {
  for (const [k, v] of Object.entries(cfg.theme || {})) {
    document.documentElement.style.setProperty("--" + k.replace(/^--/, ""), String(v));
  }
}
