// Run: node tests/laya.test.mjs   (no model needed: the service is faked)
import "../extension/rules/basic.js";
import { merge } from "../extension/core/config.js";
import { decide, finish } from "../extension/core/router.js";
import { askLaya, layaHit, lacksCertainty } from "../extension/core/laya.js";
import { registerRoute, urlRoute } from "../extension/core/registry.js";

const cfg = merge({});
cfg.allProjects = [];
for (const d of cfg.urlRoutes) registerRoute(urlRoute(d));
let fail = 0;
const check = (name, ok) => (ok || fail++, console.log(`${ok ? "ok  " : "FAIL"} ${name}`));

const fake = (reply, delay = 0) => async (url, opts) => {
  fake.last = { url, body: JSON.parse(opts.body) };
  await new Promise((r, j) => {
    const t = setTimeout(r, delay);
    opts.signal.addEventListener("abort", () => (clearTimeout(t), j(new Error("aborted"))));
  });
  return { json: async () => reply };
};

check("search goes to Google", cfg.urlRoutes.find((r) => r.id === "search").template.startsWith("https://www.google.com/search?q="));
check("prefix is certain", !lacksCertainty(decide("!ask hi there", cfg), cfg));
check("web address is certain", !lacksCertainty(decide("github.com/foo", cfg), cfg));
check("short lookup rule is certain", !lacksCertainty(decide("walmart hours", cfg), cfg));
check("fallback is uncertain", lacksCertainty(decide("write a cover letter for a barista job", cfg), cfg));
check("unsure classifier is uncertain", lacksCertainty({ source: "classifier", confidence: 0.9 }, cfg));
check("sure classifier is certain", !lacksCertainty({ source: "classifier", confidence: 0.97 }, cfg));

const out = await askLaya("explain how wifi works", cfg, fake({ ok: true, p_ai: 0.5, ms: 340 }));
check("asks /decide with the text", fake.last.url === "http://127.0.0.1:8770/decide" && fake.last.body.text === "explain how wifi works");
const hit = layaHit(out, cfg);
const d = finish(hit, "explain how wifi works", cfg, null);
check("laya answer routes to Claude", d.route === "claude" && d.source === "laya");
check("low AI score goes to Google", finish(layaHit({ ok: true, p_ai: 0.36 }, cfg), "best pizza near me", cfg, null).route === "search");
check("bad reply is ignored", layaHit(null, cfg) === null);

const slow = await askLaya("x", { ...cfg, laya: { ...cfg.laya, timeoutMs: 50 } }, fake({ ok: true, p_ai: 1 }, 500));
check("slow service times out", slow === null);
check("service down gives null", (await askLaya("x", cfg, async () => { throw new Error("refused"); })) === null);
check("disabled skips the call", (await askLaya("x", merge({ laya: { enabled: false } }), () => { throw new Error("called"); })) === null);

console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
