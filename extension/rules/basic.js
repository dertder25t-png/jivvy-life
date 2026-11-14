// Built-in routing rules. Edit freely, or add your own file and import it in plugins.js.
// Simple keyword rules can also go on the Options page as JSON (no code needed).
import { registerRule } from "../core/registry.js";

const BUILD = /\b(build|make|add|implement|fix|refactor|debug|write|create|change|update|rename|remove|test|deploy|migrate|port)\b/i;
const TECH = /\b(code|function|component|api|bug|error|crash|compile|repo|branch|commit|typescript|javascript|rust|python|css|html|react|svelte|tauri|cargo|npm|extension)\b/i;
const QWORD = /^(who|what|when|where|why|how|which|is|are|can|does|do|should|explain|compare)\b/i;

registerRule({
  id: "web address",
  priority: 100,
  test(t) {
    if (/\s/.test(t)) return null;
    if (/^https?:\/\/\S+$/i.test(t) || /^(www\.)?[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t)) {
      return { route: "open-url", why: "looks like a web address" };
    }
    return null;
  },
});

registerRule({
  id: "code or error text",
  priority: 90,
  test(t) {
    const codey =
      /```/.test(t) ||
      /^\s+at \S+ \(/m.test(t) || // JS stack trace
      /Traceback \(most recent call last\)/.test(t) ||
      /error\[E\d{4}\]/.test(t) || // rustc
      /\b[\w-]+\.(tsx?|jsx?|mjs|rs|py|go|css|scss|html|vue|svelte|toml|ya?ml)\b/i.test(t) ||
      /(^|\s)(\.{1,2}|~)?\/[\w.-]+\/[\w.\/-]*/.test(t);
    return codey ? { cls: "code", why: "contains code, a file path or an error trace" } : null;
  },
});

registerRule({
  id: "mentions a project",
  priority: 80,
  test(t, ctx) {
    if (ctx.project && (BUILD.test(t) || TECH.test(t))) {
      return { cls: "code", why: `mentions your project “${ctx.project.name}”` };
    }
    return null;
  },
});

registerRule({
  id: "short lookup",
  priority: 10,
  test(t, ctx) {
    if (ctx.words.length <= 3 && !QWORD.test(t) && !/\?\s*$/.test(t)) {
      return { cls: "search", why: "short lookup" };
    }
    return null;
  },
});
