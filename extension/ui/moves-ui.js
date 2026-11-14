// Predictive moves on the new tab page: the banner, the drawer where you review moves, and the
// row of staged pills under the box (background.js stages them). Nothing here takes focus by
// itself; every move waits for a click, Alt+1–9, or Tab on an empty box.
import { SEEDS, withSeeds, isEnabled, pruneStaged, makeLabel, logLabels, IGNORE_AFTER_TABS } from "../core/moves.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const UNDO_MS = 10 * 60e3;

// ctx: { cfg, store, q, fill(text, route?), runRoute(id, text), open(url, delay?), copy(text), native(msg), toast(msg, ms?) }
export async function mount(ctx) {
  const { cfg, store } = ctx;
  if (!cfg.moves?.enabled) return { tabTop: () => false };
  const banner = $("banner"), pills = $("pills"), files = $("files"), drawer = $("drawer");
  let moves = withSeeds(await store.get("moves", {}));
  let learned = await store.get("learned", {});
  let staged = [];

  const visible = () => staged.filter((i) => i.action?.type === "undo-move" || isEnabled(moves, i.move)).slice(0, 9);

  // ---- staged list: prune, then count this tab as one more view of what's shown ----
  async function loadStaged(countView) {
    const now = Date.now();
    const { keep, expired } = pruneStaged(await store.get("staged", []), now);
    staged = keep;
    if (countView) {
      const shown = new Set(visible().map((i) => i.id));
      staged = staged.map((i) => (shown.has(i.id) && i.action?.type !== "undo-move" ? { ...i, tabsSeen: (i.tabsSeen || 0) + 1 } : i));
    }
    if (countView || expired.length) await store.set("staged", staged);
    await logLabels(store, expired.map((i) => makeLabel(i, "ignored", now)));
  }

  async function remove(item, outcome) {
    staged = (await store.get("staged", [])).filter((i) => i.id !== item.id);
    await store.set("staged", staged);
    if (outcome) await logLabels(store, [makeLabel(item, outcome)]);
    renderPills();
  }

  // ---- firing ----
  async function fire(item) {
    const a = item.action || {};
    if (a.type === "move") return doMove(item);
    if (a.type === "undo-move") return doUndo(item);
    await remove(item, "fired"); // saved before a link may leave this page
    if (a.type === "open") ctx.open(a.url);
    else if (a.type === "ask") await ctx.runRoute(a.route === "gemini" ? "gemini" : "claude", a.text);
    else if (a.type === "copy-open") {
      await ctx.copy(a.text);
      ctx.toast("Copied. Paste it there.");
      ctx.open(a.url, 900);
    } else if (a.type === "files") showFiles(a.files || []);
  }

  // Tab on an empty box: ask items and links go into the box (Enter sends); others fire.
  function tabTop() {
    const top = visible()[0];
    if (!top) return false;
    const a = top.action || {};
    if (a.type === "ask") ctx.fill(a.text, a.route === "gemini" ? "gemini" : "claude");
    else if (a.type === "open" && /^https?:/i.test(a.url)) ctx.fill(a.url);
    else return fire(top), true;
    remove(top, "fired");
    return true;
  }

  async function doMove(item) {
    const { names, dest } = item.action;
    let res;
    try {
      res = await ctx.native({ action: "move_files", names, dest });
    } catch (err) {
      return ctx.toast("Couldn't move the files: " + err.message, 6000);
    }
    if (!res?.ok) return ctx.toast("Couldn't move the files: " + (res?.error || "the helper didn't answer"), 6000);
    const pairs = res.pairs || [], skipped = res.skipped || [];
    await remove(item, "fired");
    ctx.toast(`Moved ${pairs.length} file${pairs.length === 1 ? "" : "s"}${skipped.length ? `, skipped ${skipped.length}` : ""}.`);
    if (!pairs.length) return;
    const now = Date.now();
    const undo = { id: "undo:" + now.toString(36), move: item.move, key: "undo", label: `Undo move (${pairs.length})`, confidence: 1,
      source: item.source, t: now, expires: now + UNDO_MS, tabsSeen: 0, action: { type: "undo-move", pairs } };
    staged = [undo, ...(await store.get("staged", []))];
    await store.set("staged", staged);
    renderPills();
  }

  async function doUndo(item) {
    try {
      const res = await ctx.native({ action: "undo_move", pairs: item.action.pairs });
      if (!res?.ok) throw new Error(res?.error || "the helper didn't answer");
      ctx.toast(`Moved ${res.pairs?.length ?? 0} file(s) back${res.skipped?.length ? `, ${res.skipped.length} couldn't be` : ""}.`);
      await remove(item, null);
    } catch (err) {
      ctx.toast("Couldn't undo: " + err.message, 6000);
    }
  }

  function showFiles(list) {
    files.textContent = "";
    const head = el("div", "files-head");
    head.append(el("strong", null, "Recent files in Downloads"));
    const close = el("button", "x", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close the file list");
    close.addEventListener("click", () => (files.hidden = true));
    head.append(close);
    const ul = el("ul", "files-list");
    for (const f of list) {
      const li = el("li");
      li.append(el("span", "fname", f.name));
      const show = el("button", "mini", "Show in folder");
      show.type = "button";
      show.addEventListener("click", async () => {
        try {
          const res = await ctx.native({ action: "reveal", path: f.path });
          if (!res?.ok) throw new Error(res?.error || "the helper didn't answer");
        } catch (err) {
          ctx.toast("Couldn't show it: " + err.message, 6000);
        }
      });
      const copy = el("button", "mini", "Copy path");
      copy.type = "button";
      copy.addEventListener("click", async () => (await ctx.copy(f.path), ctx.toast("Path copied.")));
      li.append(show, copy);
      ul.append(li);
    }
    if (!list.length) ul.append(el("li", "muted", "No files."));
    files.append(head, ul);
    files.hidden = false;
  }

  // ---- pills ----
  function renderPills() {
    pills.textContent = "";
    const list = visible();
    list.forEach((item, n) => {
      const pill = el("span", "pill" + (item.action?.type === "undo-move" ? " undo" : ""));
      const go = el("button", "pill-go");
      go.type = "button";
      go.title = `Alt+${n + 1}` + (n === 0 ? " · Tab on an empty box" : "") + (item.source === "laya" ? " · suggested by laya" : "");
      go.append(el("span", "num", String(n + 1)), el("span", null, item.label));
      go.addEventListener("click", () => fire(item));
      const x = el("button", "x", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Dismiss " + item.label);
      x.addEventListener("click", () => remove(item, item.action?.type === "undo-move" ? null : "dismissed"));
      pill.append(go, x);
      pills.append(pill);
    });
    pills.hidden = !list.length;
  }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
      const item = visible()[+e.code.slice(5) - 1];
      if (item) e.preventDefault(), fire(item);
    } else if (e.key === "Escape" && !drawer.hidden && drawer.contains(document.activeElement)) {
      closeDrawer();
    }
  });

  // ---- banner and drawer ----
  const discovered = () => (Array.isArray(learned.discovered) ? learned.discovered.filter((d) => d && d.id) : []);
  const statusOf = (id) => moves[id]?.status || "new";
  const newCount = () => [...SEEDS.map((s) => s.id), ...discovered().map((d) => d.id)].filter((id) => statusOf(id) === "new").length;

  function renderBanner() {
    const n = newCount();
    banner.textContent = "";
    banner.hidden = !n || !drawer.hidden;
    if (!n) return;
    const who = cfg.name ? `Hey ${cfg.name}, ` : "";
    banner.append(el("span", null, `⚡ ${who}${n} new predictive move${n === 1 ? "" : "s"} can help you day-to-day`));
    const b = el("button", "b primary", "View & Enable");
    b.type = "button";
    b.addEventListener("click", openDrawer);
    banner.append(b);
  }

  async function saveMove(id, patch) {
    const all = withSeeds(await store.get("moves", {}));
    all[id] = { status: "new", threshold: 0.85, ...all[id], ...patch };
    moves = all;
    await store.set("moves", all);
    renderBanner();
    renderPills();
  }

  function moveCard(m) {
    const st = statusOf(m.id);
    const card = el("article", "move" + (st === "dismissed" ? " dismissed" : ""));
    const head = el("div", "move-head");
    head.append(el("h3", null, m.title));
    if (st === "new") head.append(el("span", "badge", "new"));
    card.append(head);
    for (const [k, v] of [["Trigger", m.trigger], ["Action", m.action], ["In your history", m.note || "—"]]) {
      const p = el("p", "move-line");
      p.append(el("span", "muted", k + ": "), document.createTextNode(v));
      card.append(p);
    }
    const row = el("div", "move-ctl");
    const sw = el("label", "switch");
    const box = el("input");
    box.type = "checkbox";
    box.setAttribute("role", "switch");
    box.checked = st === "enabled";
    box.addEventListener("change", () => saveMove(m.id, { status: box.checked ? "enabled" : "disabled" }).then(renderDrawer));
    sw.append(box, el("span", "track"), el("span", null, "Enable"));
    const th = el("label", "th");
    const num = el("input");
    num.type = "number";
    num.min = "0.5";
    num.max = "1";
    num.step = "0.05";
    num.value = String(moves[m.id]?.threshold ?? 0.85);
    num.addEventListener("change", () => {
      const v = Math.min(1, Math.max(0.5, parseFloat(num.value) || 0.85));
      num.value = String(v);
      saveMove(m.id, { threshold: v });
    });
    th.append(el("span", "muted", "Threshold "), num);
    const dis = el("button", "b", st === "dismissed" ? "Restore" : "Dismiss");
    dis.type = "button";
    dis.addEventListener("click", () => saveMove(m.id, { status: st === "dismissed" ? "disabled" : "dismissed" }).then(renderDrawer));
    row.append(sw, th, dis);
    card.append(row);
    return card;
  }

  function renderDrawer() {
    drawer.textContent = "";
    const head = el("div", "drawer-head");
    head.append(el("h2", null, "Predictive moves"));
    const scanStatus = el("span", "muted small");
    const scan = el("button", "b", "Scan now");
    scan.type = "button";
    scan.addEventListener("click", async () => {
      scan.disabled = true;
      scanStatus.textContent = "Scanning your history (up to 2 minutes)…";
      try {
        const res = await ctx.native({ action: "mine" });
        if (!res?.ok) throw new Error(res?.error || "the helper didn't answer");
        learned = res.learned || {};
        await store.set("learned", learned);
        renderDrawer();
        renderBanner();
      } catch (err) {
        scanStatus.textContent = "Couldn't scan: " + err.message;
        scan.disabled = false;
      }
    });
    const close = el("button", "x", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeDrawer);
    head.append(scanStatus, scan, close);
    drawer.append(head);

    const counts = learned.counts || {};
    for (const s of SEEDS) drawer.append(moveCard({ ...s, note: counts[s.id]?.note }));
    const found = discovered();
    if (found.length) {
      drawer.append(el("h3", "drawer-sub", "Found in your history"));
      for (const d of found) {
        const hosts = Array.isArray(d.hosts) ? d.hosts : [];
        drawer.append(moveCard({
          id: d.id,
          title: d.label || hosts.join(" → "),
          trigger: hosts.length >= 2 ? `You open ${hosts[0]}, then ${hosts[1]}.` : "A repeated sequence of sites.",
          action: `Stages ${hosts[2] || d.url || "the next site"}${d.url ? " (" + d.url + ")" : ""}.`,
          note: d.n ? `${d.n} times on ${d.days ?? "?"} days` : counts[d.id]?.note,
        }));
      }
    }
    drawer.append(el("p", "muted small", `Labels: using a move counts as a yes, × as a no; one left unused for ${IGNORE_AFTER_TABS} new tabs or until it expires counts as a weak no. Only stored in this browser.`));
  }

  function openDrawer() {
    renderDrawer();
    drawer.hidden = false;
    banner.hidden = true;
    drawer.querySelector("input, button")?.focus();
  }
  function closeDrawer() {
    drawer.hidden = true;
    renderBanner();
    ctx.q?.focus();
  }

  await loadStaged(true);
  renderPills();
  renderBanner();

  // Moves staged while this tab is open show up right away.
  if (typeof browser !== "undefined" && browser.storage?.onChanged) {
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (changes.staged) (staged = pruneStaged(changes.staged.newValue || []).keep), renderPills();
      if (changes.moves) (moves = withSeeds(changes.moves.newValue || {})), renderPills(), renderBanner();
      if (changes.learned) (learned = changes.learned.newValue || {}), renderBanner();
    });
  }
  return { tabTop, openDrawer };
}

// ---- preview only: newtab.html?demo=1 outside the extension fills localStorage with sample data ----
export async function seedDemo(store) {
  const now = Date.now();
  const moves = withSeeds({});
  moves.nav_shortcut_interceptor = { status: "enabled", threshold: 0.85 };
  moves.search_frustration_escalator = { status: "enabled", threshold: 0.85 };
  moves.canvas_study_bridge = { status: "enabled", threshold: 0.85 };
  moves.creative_asset_router = { status: "enabled", threshold: 0.85 };
  moves["seq_example-com_docs-example-com_mail-example-com"] = { status: "enabled", threshold: 0.85 };
  const text = "I searched Google for this and didn't find it:\n- how to batch rename photos by date\n\nbatch rename photos by date taken linux";
  const base = { source: "rule", confidence: 0.95, t: now, expires: now + 20 * 60e3, tabsSeen: 0 };
  await store.set("moves", moves);
  await store.set("staged", [
    { ...base, id: "demo1", move: "search_frustration_escalator", key: "claude", label: "Ask Claude", action: { type: "ask", route: "claude", text } },
    { ...base, id: "demo2", move: "search_frustration_escalator", key: "gemini", label: "Ask Gemini", action: { type: "ask", route: "gemini", text } },
    { ...base, id: "demo3", move: "canvas_study_bridge", key: "files:1", label: "2 recent files for this assignment", confidence: 0.9,
      action: { type: "files", files: [
        { name: "poster-draft.pdf", path: "/home/you/Downloads/poster-draft.pdf", size: 120000, mtime: now - 600e3 },
        { name: "photo-01.tif", path: "/home/you/Downloads/photo-01.tif", size: 9000000, mtime: now - 300e3 },
      ] } },
    { ...base, id: "demo4", move: "creative_asset_router", key: "harvest", label: "Move 3 new files to assets", confidence: 0.9,
      action: { type: "move", names: ["a.jpg", "b.png", "font.woff2"], dest: "/home/you/Pictures/assets" } },
    { ...base, id: "demo5", move: "seq_example-com_docs-example-com_mail-example-com", key: "seq", label: "Open mail.example.com", source: "laya",
      confidence: 0.88, action: { type: "open", url: "https://mail.example.com/" } },
  ]);
  await store.set("learned", {
    t: now,
    name: "",
    navAliases: { drive: "https://drive.google.com/", "google drive": "https://drive.google.com/", calendar: "https://calendar.google.com/" },
    canvasCourses: {},
    counts: { nav_shortcut_interceptor: { n: 42, note: "42 searches for a site you then opened (sample)" },
      search_frustration_escalator: { n: 9, note: "9 bursts of repeated searches (sample)" } },
    discovered: [{ id: "seq_example-com_docs-example-com_mail-example-com", hosts: ["example.com", "docs.example.com", "mail.example.com"],
      n: 6, days: 4, label: "example.com → docs → mail", url: "https://mail.example.com/", laya: null }],
  });
}
