// Typing a web address goes straight there.
import { registerRoute } from "../core/registry.js";

registerRoute({
  id: "open-url",
  label: "Open address",
  cls: "search",
  run(text, ctx) {
    ctx.open(/^https?:\/\//i.test(text) ? text : "https://" + text);
  },
});
