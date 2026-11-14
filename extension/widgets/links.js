// Your links, from "links" on the Options page.
import { registerWidget } from "../core/registry.js";

registerWidget({
  id: "links",
  title: "Links",
  render(el, ctx) {
    const ul = document.createElement("ul");
    ul.className = "link-list";
    for (const l of ctx.cfg.links || []) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = l.url;
      a.textContent = l.label || l.url;
      li.append(a);
      ul.append(li);
    }
    if (!ul.children.length) ul.innerHTML = '<li class="muted">Add links on the Options page.</li>';
    el.append(ul);
  },
});
