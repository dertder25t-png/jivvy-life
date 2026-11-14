// Starts Claude Code in a terminal through the local helper (see helper/).
// If the helper isn't installed, the ready-to-run command is copied instead.
import { registerRoute } from "../core/registry.js";

const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

registerRoute({
  id: "claude-code",
  label: "Claude Code",
  cls: "code",
  confirm: true,
  async run(text, ctx) {
    const plan = ctx.mode !== "direct";
    const cwd = ctx.project?.path || null;
    try {
      const res = await ctx.native({ action: "launch", prompt: text, cwd, plan });
      if (!res?.ok) throw new Error(res?.error || "the helper didn't answer");
      ctx.toast(`Claude Code started${plan ? " in plan mode" : ""}${ctx.project ? " in " + ctx.project.name : ""}.`);
      ctx.clear();
    } catch (err) {
      const cmd = `${cwd ? "cd " + quote(cwd) + " && " : ""}claude${plan ? " --permission-mode plan" : ""} ${quote(text)}`;
      await ctx.copy(cmd);
      ctx.toast(`Couldn't start Claude Code (${err.message}). The command is on your clipboard; paste it into a terminal.`, 7000);
    }
  },
});
