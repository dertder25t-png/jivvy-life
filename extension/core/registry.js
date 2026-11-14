// The plug-in system. Every route, widget and rule registers itself here.
//
//   registerRoute({ id, label, cls, confirm?, run(text, ctx) })
//     cls: which kind of request this route handles: "search" | "ask" | "deep" | "code"
//          (used for learning from your corrections and picking Claude Code's mode).
//     confirm: true = needs a second Enter press before it runs.
//
//   registerWidget({ id, title, render(el, ctx) })
//
//   registerRule({ id, priority, test(text, ctx) })
//     test returns null, or { cls | route, mode?, why? }. Higher priority runs first.

export const routes = new Map();
export const widgets = new Map();
export const rules = [];

export function registerRoute(route) {
  if (!route.id || typeof route.run !== "function") throw new Error("route needs id and run()");
  routes.set(route.id, { label: route.id, ...route });
}

export function registerWidget(widget) {
  if (!widget.id || typeof widget.render !== "function") throw new Error("widget needs id and render()");
  widgets.set(widget.id, { title: widget.id, ...widget });
}

export function registerRule(rule) {
  if (!rule.id || typeof rule.test !== "function") throw new Error("rule needs id and test()");
  const i = rules.findIndex((r) => r.id === rule.id);
  if (i >= 0) rules.splice(i, 1);
  rules.push({ priority: 50, ...rule });
  rules.sort((a, b) => b.priority - a.priority);
}

// Routes that need no code: a URL template from the config.
//   { id, label, cls, template: "https://example.com/?q={q}", copy?, hint? }
//   {q} = your text, URL-encoded. {raw} = your text as typed.
export function urlRoute(def) {
  return {
    ...def,
    async run(text, ctx) {
      if (def.copy) await ctx.copy(text);
      if (def.hint) ctx.toast(def.hint);
      const url = def.template
        .replaceAll("{q}", encodeURIComponent(text))
        .replaceAll("{raw}", text);
      ctx.open(url, def.hint || def.copy ? 900 : 0);
    },
  };
}
