import "./plugins.js";
import { routes, widgets, registerRoute, urlRoute } from "./core/registry.js";
import { loadConfig, applyTheme } from "./core/config.js";
import { decide, codeMode, finish } from "./core/router.js";
import { askLaya, layaHit, lacksCertainty } from "./core/laya.js";
import { loadModel } from "./core/classifier.js";
import * as store from "./core/storage.js";
import { calc } from "./core/calc.js";
import { mount as mountMoves, seedDemo } from "./ui/moves-ui.js";

const $ = (id) => document.getElementById(id);
const q = $("q"), chip = $("chip"), hint = $("hint"), menu = $("menu"), toastEl = $("toast");

// Preview only (page opened outside the extension): ?demo=1 fills localStorage with sample moves.
if (!store.inExtension && new URLSearchParams(location.search).get("demo") === "1") await seedDemo(store);

const cfg = await loadConfig();

// Firefox gives a new tab's focus to the address bar, and a page can't take it back.
// So a new tab opens the dashboard in a fresh tab right where it is and closes itself:
// a tab opened with an address gives its page the focus, so you can type straight into the box.
// (Not for the home page, which loads with ?home=1 and already has focus.)
const params = new URLSearchParams(location.search);
if (cfg.focusBox && store.inExtension && !params.has("f") && !params.has("home")) {
  const tab = await browser.tabs.getCurrent().catch(() => null);
  if (tab) {
    await browser.tabs.create({ url: browser.runtime.getURL("newtab.html?f=1"), index: tab.index, windowId: tab.windowId, active: true });
    await browser.tabs.remove(tab.id);
    await new Promise(() => {}); // this tab is closing
  }
}
applyTheme(cfg);
for (const def of cfg.urlRoutes) registerRoute(urlRoute(def));
const model = await loadModel();

// auto: what the router picked. pick: what you chose in the menu (overrides auto).
const state = { auto: null, pick: null, mode: null, project: undefined, armed: false, calc: null };
let moves = null; // the predictive-moves UI, mounted after the widgets

function current() {
  const a = state.auto;
  if (!a) return null;
  if (!state.pick && a.pending) return a;
  const route = state.pick || a.route;
  const r = routes.get(route);
  const cls = r?.cls;
  return {
    ...a,
    // A rule may swap in its own text (nav alias → its URL); a route you pick gets what you typed.
    text: state.pick ? a.raw ?? a.text : a.text,
    label: state.pick ? undefined : a.label,
    route,
    cls,
    mode: cls === "code" ? state.mode || (state.pick ? null : a.mode) || codeMode(a.text) : undefined,
    project: state.project !== undefined ? state.project : a.project,
    source: state.pick ? "manual" : a.source,
    why: state.pick ? "you picked it" : a.why,
  };
}

function render() {
  const d = current();
  chip.classList.toggle("armed", state.armed);
  if (!d) {
    chip.textContent = "→ Type something";
    hint.textContent = "";
    return;
  }
  if (d.pending) {
    chip.textContent = "→ Decides when you press Enter";
    hint.textContent = state.calc || "";
    return;
  }
  const r = routes.get(d.route);
  const bits = [d.label || (r ? r.label : d.route + " (unknown route)")];
  if (d.mode) bits.push(d.mode === "plan" ? "plan mode" : "direct");
  if (d.cls === "code") bits.push(d.project ? d.project.name : "no project");
  chip.textContent = "→ " + bits.join(" · ");
  chip.title = "Why: " + d.why;
  hint.textContent = state.armed ? "Press Enter again to start it, Esc to cancel." : state.calc || d.why;
}

let timer;
function preview() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    state.auto = decide(q.value, cfg, { model, final: false });
    state.calc = calc(q.value); // only the hint line; the route stays the same
    render();
  }, 300);
}

function toast(msg, ms = 4000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), ms);
}

function resetChoice() {
  Object.assign(state, { pick: null, mode: null, project: undefined, armed: false });
}

function context(d) {
  return {
    cfg,
    mode: d.mode,
    project: d.project,
    toast,
    open(url, delay = 0) {
      const go = () => (cfg.openIn === "new" ? window.open(url, "_blank", "noopener") : location.assign(url));
      delay ? setTimeout(go, delay) : go();
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        toast("Couldn't copy to the clipboard.");
      }
    },
    async native(msg) {
      if (typeof browser === "undefined" || !browser.runtime?.sendNativeMessage) throw new Error("not running as the extension");
      return browser.runtime.sendNativeMessage("hub_helper", msg);
    },
    clear() {
      q.value = "";
      state.auto = null;
      resetChoice();
      autosize();
      render();
    },
  };
}

async function submit() {
  clearTimeout(timer);
  if (!q.value.trim()) return;
  if (!state.armed) {
    state.auto = decide(q.value, cfg, { model, final: true });
    // The quick classifier isn't sure (and you didn't pick): let laya decide Google vs AI.
    if (!state.pick && lacksCertainty(state.auto, cfg) && cfg.laya?.enabled) {
      chip.textContent = "→ Deciding…";
      const text = state.auto.text;
      const hit = layaHit(await askLaya(text, cfg), cfg);
      if (hit) state.auto = finish(hit, text, cfg, state.auto.project);
    }
  }
  const d = current();
  const r = routes.get(d.route);
  if (!r) return toast(`No route called “${d.route}”. Check your settings.`);
  if (!d.text) return toast("Type something after the prefix.");

  if (r.confirm && cfg.confirmCode && !state.armed) {
    state.armed = true;
    return render();
  }

  if (cfg.keepHistory) await store.push("history", { text: q.value.trim(), route: d.route, t: Date.now() }, 50);
  // Your explicit choices (menu picks and prefixes) become training data for tools/train.py.
  if ((d.source === "manual" || d.source === "prefix") && d.cls) {
    await store.push("corrections", { text: d.text, cls: d.cls, t: Date.now() }, 1000);
  }
  state.armed = false;
  render();
  await r.run(d.text, context(d));
}

// ---- route menu ----
function openMenu() {
  if (!state.auto || state.auto.pending) state.auto = decide(q.value || " ", cfg, { model, final: true });
  const d = current();
  menu.innerHTML = "";
  for (const r of routes.values()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = d && d.route === r.id ? "on" : "";
    b.innerHTML = `<span></span><span class="sub"></span>`;
    b.firstChild.textContent = r.label;
    b.lastChild.textContent = r.cls || "";
    b.addEventListener("click", () => {
      state.pick = r.id;
      state.armed = false;
      closeMenu();
      render();
      q.focus();
    });
    menu.append(b);
  }
  if (d && d.cls === "code") {
    const row = document.createElement("div");
    row.className = "row";
    const mode = document.createElement("select");
    mode.innerHTML = '<option value="plan">Plan mode</option><option value="direct">Direct</option>';
    mode.value = d.mode;
    mode.addEventListener("change", () => ((state.mode = mode.value), render()));
    const proj = document.createElement("select");
    proj.innerHTML = '<option value="">No project (home folder)</option>';
    cfg.allProjects.forEach((p, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = p.name;
      proj.append(o);
    });
    proj.value = d.project ? String(cfg.allProjects.indexOf(d.project)) : "";
    proj.addEventListener("change", () => ((state.project = proj.value === "" ? null : cfg.allProjects[+proj.value]), render()));
    row.append(mode, proj);
    menu.append(row);
  }
  menu.hidden = false;
  chip.setAttribute("aria-expanded", "true");
  menu.querySelector("button.on, button")?.focus();
}
function closeMenu() {
  menu.hidden = true;
  chip.setAttribute("aria-expanded", "false");
}

// ---- input ----
function autosize() {
  q.style.height = "auto";
  q.style.height = q.scrollHeight + "px";
}
q.addEventListener("input", () => {
  if (!q.value.trim()) resetChoice();
  state.armed = false;
  autosize();
  preview();
});
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape") {
    if (!menu.hidden) closeMenu();
    else if (state.armed) (state.armed = false), render();
    else if (state.pick) resetChoice(), render();
  } else if (e.key === "Tab" && !e.shiftKey && q.value.trim()) {
    e.preventDefault();
    openMenu();
  } else if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && moves?.tabTop()) {
    e.preventDefault(); // empty box: the first staged move
  }
});
menu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu(), q.focus();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
chip.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && e.target !== chip) closeMenu();
});
$("ask").addEventListener("submit", (e) => (e.preventDefault(), submit()));

// ---- widgets ----
const wctx = { cfg, store, fill: (t) => ((q.value = t), autosize(), preview(), q.focus()) };
for (const id of cfg.widgets) {
  const w = widgets.get(id);
  if (!w) continue;
  const card = document.createElement("section");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = w.title;
  const body = document.createElement("div");
  card.append(h, body);
  $("widgets").append(card);
  try {
    await w.render(body, wctx);
  } catch (err) {
    body.textContent = "This widget failed to load: " + err.message;
  }
}

// ---- predictive moves: banner, drawer and staged pills (after the widgets) ----
moves = await mountMoves({
  cfg,
  store,
  q,
  toast,
  ...(({ open, copy, native }) => ({ open, copy, native }))(context({})),
  fill(text, pick) {
    q.value = text;
    resetChoice();
    if (pick) state.pick = pick;
    autosize();
    clearTimeout(timer);
    // final: a picked route needs a settled decision (a pending one would hide the pick on the chip)
    state.auto = decide(text, cfg, { model, final: true });
    state.calc = calc(text);
    render();
    q.focus();
  },
  async runRoute(id, text) {
    const r = routes.get(id);
    if (!r) return toast(`No route called “${id}”. Check your settings.`);
    await r.run(text, context({}));
  },
}).catch((err) => (console.warn("moves UI failed:", err), null));

// ---- refresh scanned projects at most once an hour (one short helper run) ----
if (cfg.projectRoots.length && store.inExtension) {
  const scanned = await store.get("scannedProjects", { t: 0, list: [] });
  if (Date.now() - scanned.t > 3600e3) {
    browser.runtime
      .sendNativeMessage("hub_helper", { action: "list_projects", roots: cfg.projectRoots })
      .then((res) => res?.ok && store.set("scannedProjects", { t: Date.now(), list: res.projects }))
      .catch(() => {});
  }
}

render();
q.focus();
