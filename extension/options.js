import { DEFAULTS, merge } from "./core/config.js";
import * as store from "./core/storage.js";

const $ = (id) => document.getElementById(id);
const status = (el, msg, bad = false) => {
  el.textContent = msg;
  el.classList.toggle("err", bad);
};

const EXAMPLE = {
  projects: [{ name: "hub", path: "/home/you/code/hub" }],
  projectRoots: ["/home/you/code"],
  urlRoutes: [{ id: "perplexity", label: "Perplexity", cls: "ask", template: "https://www.perplexity.ai/search?q={q}" }],
  prefixes: { "!p": "perplexity" },
  rules: [{ id: "recipes", pattern: "\\brecipe\\b", route: "search" }],
  links: [{ label: "Canvas", url: "https://canvas.instructure.com" }],
  theme: { accent: "#e07a5f" },
  name: "Sam",
  assetFolder: "/home/you/Pictures/assets",
  canvas: { host: "school.instructure.com", courses: { "12345": { name: "Photography I", exts: ["tif", "jpg", "png"] } } },
  navAliases: { drive: "https://drive.google.com/", "my school": "https://www.example.edu/" },
  moves: { enabled: true, shortcutAt: 0.85, layaStaging: true, layaBatteryMode: "ac_only", layaBatteryMinPercent: 40, layaLowPowerOverride: true },
};

$("defaults").textContent = JSON.stringify(DEFAULTS, null, 2);
const user = await store.get("userConfig", {});
$("cfg").value = JSON.stringify(user, null, 2);

// Laya battery controls: shown from, and written to, moves.layaBatteryMode / layaBatteryMinPercent in the JSON.
const modes = ["ac_only", "always", "threshold", "never"];
function syncLaya() {
  $("layaPctWrap").hidden = $("layaMode").value !== "threshold";
}
function loadLaya() {
  let m = {};
  try {
    m = JSON.parse($("cfg").value || "{}").moves || {};
  } catch {
    /* invalid JSON: show the defaults */
  }
  $("layaMode").value = modes.includes(m.layaBatteryMode) ? m.layaBatteryMode : "ac_only";
  $("layaPct").value = Number.isFinite(m.layaBatteryMinPercent) ? m.layaBatteryMinPercent : 40;
  $("layaLow").checked = m.layaLowPowerOverride !== false;
  syncLaya();
}
function writeLaya() {
  syncLaya();
  let o;
  try {
    o = JSON.parse($("cfg").value || "{}");
  } catch {
    return;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return;
  const pct = Math.max(0, Math.min(100, Math.round(Number($("layaPct").value))));
  o.moves = { ...(o.moves || {}), layaBatteryMode: $("layaMode").value, layaBatteryMinPercent: Number.isFinite(pct) ? pct : 40, layaLowPowerOverride: $("layaLow").checked };
  $("cfg").value = JSON.stringify(o, null, 2);
}
loadLaya();
$("layaMode").addEventListener("change", writeLaya);
$("layaPct").addEventListener("change", writeLaya);
$("layaLow").addEventListener("change", writeLaya);
$("cfg").addEventListener("change", loadLaya);

$("save").addEventListener("click", async () => {
  let parsed;
  try {
    parsed = JSON.parse($("cfg").value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings must be a JSON object { … }");
    const cfg = merge(parsed);
    for (const r of cfg.rules) new RegExp(r.pattern, r.flags ?? "i");
    for (const d of cfg.urlRoutes) if (!d.id || !d.template) throw new Error(`url route needs "id" and "template": ${JSON.stringify(d)}`);
  } catch (err) {
    return status($("status"), "Not saved: " + err.message, true);
  }
  await store.set("userConfig", parsed);
  await store.set("scannedProjects", { t: 0, list: [] }); // rescan with the new roots
  status($("status"), "Saved. Open a new tab to see it.");
});

$("example").addEventListener("click", () => {
  $("cfg").value = JSON.stringify(EXAMPLE, null, 2);
  status($("status"), "Example inserted. Change the paths, then Save.");
});

$("ping").addEventListener("click", async () => {
  try {
    const res = await browser.runtime.sendNativeMessage("hub_helper", { action: "ping" });
    status($("helper"), res.claude ? `Working. Claude Code found at ${res.claude}.` : "Helper works, but the claude command wasn't found. Install Claude Code or set its path in ~/.config/hub-dashboard/helper.json.", !res.claude);
  } catch (err) {
    status($("helper"), "Helper not reachable: " + err.message + ". Run helper/install.sh, then restart Firefox.", true);
  }
});

async function counts() {
  const c = await store.get("corrections", []);
  const h = await store.get("history", []);
  $("counts").textContent = `${c.length} corrections · ${h.length} history items`;
}
counts();

async function moveCounts() {
  const l = await store.get("moveLabels", []);
  const n = (o) => l.filter((x) => x.outcome === o).length;
  $("moveCounts").textContent = `${l.length} move labels · ${n("fired")} used · ${n("dismissed")} dismissed · ${n("ignored")} ignored`;
}
moveCounts();

function download(name, lines) {
  const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("exportMoves").addEventListener("click", async () => download("hub-move-labels.jsonl", (await store.get("moveLabels", [])).map((x) => JSON.stringify(x))));
$("clearMoves").addEventListener("click", async () => (await store.set("moveLabels", []), moveCounts()));

$("export").addEventListener("click", async () => {
  const c = await store.get("corrections", []);
  const blob = new Blob([c.map((x) => JSON.stringify({ text: x.text, cls: x.cls })).join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "hub-corrections.jsonl";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("clearCorr").addEventListener("click", async () => (await store.set("corrections", []), counts()));
$("clearHist").addEventListener("click", async () => (await store.set("history", []), counts()));
