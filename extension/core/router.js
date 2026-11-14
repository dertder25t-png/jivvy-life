// Decides where a request goes: prefix, then rules, then classifier, then fallback.
import { rules, routes } from "./registry.js";
import { classify } from "./classifier.js";

const BIG = /\b(from scratch|new (app|project|feature|page|system|tool|extension)|build|implement|design|architect|refactor|migrate|rewrite|set ?up|add (a |an |the )?(feature|page|system|support|screen))\b/i;
const SMALL = /\b(typo|rename|bump|tweak|one[- ]line|quick fix|small|fix (the |this |a |that )?(typo|bug|error|test|lint|warning))\b/i;

// Plan mode for big or vague jobs, direct for small fixes. When unsure: plan.
export function codeMode(text) {
  const n = (text.match(/\S+/g) || []).length;
  if (SMALL.test(text) && !BIG.test(text) && n <= 25) return "direct";
  return "plan";
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findProject(text, projects = []) {
  const lower = text.toLowerCase();
  for (const p of projects) {
    const re = new RegExp(`(^|[^a-z0-9_-])${escapeRe(p.name.toLowerCase())}($|[^a-z0-9_-])`);
    if (re.test(lower)) return p;
  }
  return null;
}

export function parsePrefix(text, cfg) {
  const m = text.match(/^(![\w-]+)(\s+|$)/);
  if (!m) return null;
  const target = cfg.prefixes[m[1].toLowerCase()];
  if (!target) return null;
  const [route, mode] = target.split(":");
  return { route, mode, prefix: m[1], text: text.slice(m[0].length).trim() };
}

const compiled = new WeakMap();
function configRules(cfg) {
  if (compiled.has(cfg)) return compiled.get(cfg);
  const list = [];
  for (const r of cfg.rules || []) {
    try {
      const re = new RegExp(r.pattern, r.flags ?? "i");
      list.push({
        id: r.id || r.pattern,
        priority: r.priority ?? 60,
        test: (t) => (re.test(t) ? { cls: r.cls, route: r.route, mode: r.mode, why: `your rule “${r.id || r.pattern}”` } : null),
      });
    } catch {
      console.warn("Skipping rule with a bad pattern:", r);
    }
  }
  compiled.set(cfg, list);
  return list;
}

export function finish(hit, text, cfg, project) {
  const route = hit.route || cfg.classRoutes[hit.cls];
  const cls = routes.get(route)?.cls ?? hit.cls;
  const mode = cls === "code" ? hit.mode || codeMode(text) : undefined;
  return { ...hit, route, cls, mode, text, project };
}

// final=false is the cheap live preview while typing.
export function decide(input, cfg, { model = null, final = true } = {}) {
  const raw = input.trim();
  if (!raw) return null;

  const pre = parsePrefix(raw, cfg);
  if (pre) {
    const project = findProject(pre.text, cfg.allProjects);
    return finish({ route: pre.route, mode: pre.mode, why: `prefix ${pre.prefix}`, source: "prefix", confidence: 1 }, pre.text, cfg, project);
  }

  const project = findProject(raw, cfg.allProjects);
  const ctx = { cfg, project, words: raw.match(/\S+/g) || [] };
  const all = [...configRules(cfg), ...rules].sort((a, b) => b.priority - a.priority);
  for (const r of all) {
    const hit = r.test(raw, ctx);
    if (hit) return finish({ why: r.id, ...hit, source: "rule", confidence: 1 }, raw, cfg, project);
  }

  if (model && (final || cfg.previewUsesClassifier)) {
    const { cls, p } = classify(model, raw);
    if (p >= cfg.classifierThreshold) {
      return finish({ cls, why: `classifier, ${Math.round(p * 100)}% sure`, source: "classifier", confidence: p }, raw, cfg, project);
    }
  }

  if (!final) return { pending: true, text: raw, project };
  return finish({ cls: cfg.fallbackClass, why: "nothing matched, using the fallback", source: "fallback", confidence: 0 }, raw, cfg, project);
}
