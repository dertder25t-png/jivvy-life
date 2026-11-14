# Lifeboard

Your Firefox new tab and home page: one box for your whole day. Type anything and it goes to the right place:

| You type | Goes to |
|---|---|
| `weather tomorrow` | Google search |
| `github.com/foo` | that address |
| `explain how wifi works` | Claude (opens with your text filled in; you press send) |
| `research and compare …` | Claude, with a reminder to turn on Research |
| `add dark mode to hub` | Claude Code in your `hub` project, plan mode (asks for a second Enter) |

Nothing here automates any AI website. It only opens links and starts programs on your own computer.

## Install

1. **Try it:** in Firefox, open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick `extension/manifest.json`. It goes away when Firefox restarts.
2. **Keep it:** run `./sign.sh` (same as your close-all-tabs one), then drag the `.xpi` from `web-ext-artifacts/` into Firefox.
   New tabs open with the cursor already in the box (`focusBox` in Options turns this off).
3. **AI-or-search decisions (laya):** run `helper/install-laya.sh`. It sets up
   laya's [vega reader](https://huggingface.co/nandakishorm/vega-U) (0.8B, runs on the CPU, trained on
   `tools/seed.jsonl` in about 2 minutes) as a user service on `127.0.0.1:8770` that starts with your login. Check it: `curl -s http://127.0.0.1:8770/health`.
   If the script says Python can't make environments, run `sudo apt install python3-venv python3-pip` first.
   Without it running, the dashboard quietly uses the built-in classifier.
4. **For Claude Code routes:** install Claude Code (`npm i -g @anthropic-ai/claude-code`), run `helper/install.sh`, restart Firefox, then *Options → Check helper*.
   Without the helper, coding requests copy a ready-to-paste terminal command instead.

## Using it

- **Enter** sends · **Shift+Enter** new line · **Tab** opens the route menu (also has plan/direct and project pickers) · **Esc** cancels.
- **Prefixes** force a route: `!s` search, `!ask` Claude, `!gpt`, `!g` Gemini, `!deep` research, `!code` Claude Code, `!plan` plan mode, `!fix` direct mode.
- The label under the box always shows where it's going and why (hover it).

## How routing works

1. **Prefix** → always wins.
2. **Rules** (`extension/rules/basic.js` + your JSON rules): web addresses, code/file paths/stack traces, project names, short lookups.
3. **Classifier** (`extension/core/classifier.js`): a tiny linear model, ~10 µs per request. Runs only when you press Enter.
4. **laya** (`extension/core/laya.js` → `helper/laya_server.py`): when the classifier is under 95% sure or nothing
   matched, laya's vega model, trained on your examples, decides Google vs AI (~0.7 s on the CPU). On 30 typical searches:
   classifier alone 90%, with laya-typed-decisions 93%, with trained vega 97%. Adding 397 of your own Google
   searches to labels.jsonl took your held-out searches from 60/80 to 78/80 (107/110 overall).
   Settings: `laya` in Options (`classifierTrust`, `aiAt`, `{"enabled": false}` turns it off).
   To teach it more, add lines to `~/.config/hub-dashboard/labels.jsonl` (`{"text": "...", "cls": "search"}` or `"ask"`)
   and restart it: `systemctl --user restart hub-laya`. It retrains once, then reuses the result.
5. **Fallback** → Google search.

Claude Code starts in **plan mode** unless the request looks small ("fix the typo", "rename…").

## Customizing (no code)

Options page (gear icon, top right). Write only what you change; it merges onto the defaults. Click *Insert example* to see the shape:

- `projects` / `projectRoots`: your code folders (roots are scanned for git repos once an hour).
- `urlRoutes`: add any site with a search URL: `{"id":"yt","label":"YouTube","cls":"search","template":"https://www.youtube.com/results?search_query={q}"}`
- `prefixes`: `{"!yt": "yt"}`
- `rules`: `{"id":"recipes","pattern":"\\brecipe\\b","route":"yt"}`
- `classRoutes`: change where each kind of request goes, e.g. `{"ask":"chatgpt"}`
- `focusBox` (default `true`): new tabs put the cursor in the box instead of the address bar.
- `widgets`, `links`, `theme` (`{"accent":"#e07a5f","radius":"8px"}`), `openIn` (`"new"` for new tabs), `confirmCode`.

## Extending (a little code)

Add a file, then one `import` line in `extension/plugins.js`.

**Route** (`extension/routes/my-route.js`):
```js
import { registerRoute } from "../core/registry.js";
registerRoute({
  id: "notes", label: "Save to notes", cls: "ask",
  run(text, ctx) { /* ctx.open(url), ctx.copy(text), ctx.toast(msg), ctx.native(msg), ctx.clear() */ },
});
```

**Widget** (`extension/widgets/my-widget.js`), then add its id to `widgets` in Options:
```js
import { registerWidget } from "../core/registry.js";
registerWidget({ id: "todo", title: "To do", render(el, ctx) { el.textContent = "Hello"; } });
```

**Rule** (`extension/rules/my-rules.js`):
```js
import { registerRule } from "../core/registry.js";
registerRule({ id: "school", priority: 70,
  test: (text) => /\b(canvas|assignment|due)\b/i.test(text) ? { route: "search", why: "school stuff" } : null });
```

No build step. Edit, then reload the extension in `about:debugging`.

## Teaching it your habits

Every time you pick a route yourself (menu or prefix) it's saved as a correction, only in this browser.
Options → *Export corrections*, then:

```bash
python3 tools/train.py ~/Downloads/hub-corrections.jsonl
```

Reload the extension. Starter examples live in `tools/seed.jsonl`; add lines there too.

## Tests

```bash
node tests/router.test.mjs
node tests/laya.test.mjs
python3 -I tests/helper_test.py
python3 -I tests/laya_server_test.py
```

## Files

```
extension/   the add-on (manifest, newtab, options, core/, routes/, rules/, widgets/, model/)
helper/      native helper that starts Claude Code, the laya decision service, and their installers
tools/       train.py and seed examples
tests/       router and helper tests
```
