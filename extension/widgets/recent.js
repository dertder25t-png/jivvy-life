// The last things you sent. Click one to put it back in the box.
import { registerWidget } from "../core/registry.js";

registerWidget({
  id: "recent",
  title: "Recent",
  async render(el, ctx) {
    const items = (await ctx.store.get("history", [])).slice(-8).reverse();
    const ul = document.createElement("ul");
    ul.className = "recent-list";
    for (const h of items) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = h.text;
      b.title = "Sent to " + h.route;
      b.addEventListener("click", () => ctx.fill(h.text));
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = h.route;
      li.append(b, tag);
      ul.append(li);
    }
    if (!items.length) ul.innerHTML = '<li class="muted">Nothing yet.</li>';
    el.append(ul);
  },
});
