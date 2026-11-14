import { registerWidget } from "../core/registry.js";

registerWidget({
  id: "clock",
  title: "Today",
  render(el) {
    const tick = () => {
      const now = new Date();
      el.innerHTML = "";
      const time = document.createElement("div");
      time.className = "clock-time";
      time.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const date = document.createElement("div");
      date.className = "muted";
      date.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
      el.append(time, date);
      setTimeout(tick, 60000 - (Date.now() % 60000)); // wake once a minute, on the minute
    };
    tick();
  },
});
