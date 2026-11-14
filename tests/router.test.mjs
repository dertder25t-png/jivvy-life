// Run: node tests/router.test.mjs
import { readFileSync } from "node:fs";
import "../extension/rules/basic.js";
import "../extension/routes/open-url.js";
import "../extension/routes/claude-code.js";
import { registerRoute, urlRoute } from "../extension/core/registry.js";
import { merge } from "../extension/core/config.js";
import { decide } from "../extension/core/router.js";
import { classify } from "../extension/core/classifier.js";

const model = JSON.parse(readFileSync(new URL("../extension/model/weights.json", import.meta.url)));
const cfg = merge({ projects: [{ name: "hub", path: "/tmp" }], rules: [{ id: "recipes", pattern: "\\brecipe\\b", route: "chatgpt" }] });
cfg.allProjects = cfg.projects;
for (const d of cfg.urlRoutes) registerRoute(urlRoute(d));

const cases = [
  ["weather tomorrow", "search"],
  ["github.com/anthropics", "open-url"],
  ["https://example.com/a?b=1", "open-url"],
  ["!deep compare egpu enclosures", "claude-deep"],
  ["!code add dark mode", "claude-code", "plan"],
  ["!fix the typo in readme", "claude-code", "direct"],
  ["add dark mode to hub", "claude-code", "plan", "hub"],
  ["fix the typo in hub", "claude-code", "direct", "hub"],
  ["TypeError in src/app.tsx line 4", "claude-code"],
  ["a recipe for pancakes", "chatgpt"],
  ["explain how garbage collection works in java", "claude"],
  ["why is my phone battery draining so fast?", "claude"],
  ["research and compare the best budget mechanical keyboards with sources", "claude-deep"],
  ["write a script that deletes empty folders", "claude-code"],
];

let fail = 0;
for (const [text, route, mode, project] of cases) {
  const d = decide(text, cfg, { model, final: true });
  const ok = d.route === route && (!mode || d.mode === mode) && (!project || d.project?.name === project);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${text}  →  ${d.route}${d.mode ? " · " + d.mode : ""}${d.project ? " · " + d.project.name : ""}  (${d.why})`);
}

const n = 20000, t0 = performance.now();
for (let i = 0; i < n; i++) classify(model, "explain how garbage collection works in java");
console.log(`\nclassifier: ${((performance.now() - t0) / n * 1000).toFixed(1)} µs per request`);
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
