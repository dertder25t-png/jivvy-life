# Jivvy Life

A desktop browser/workspace for Linux, built with Electron 45 + React + Tailwind + Zustand: vertical tabs
and workspaces, split panes, Markdown notes with [[wikilinks]], ad/tracker blocking, local browsing
history with a prediction engine behind the address bar and dashboard search, and sync through its own
Encore API. It originally grew out of the Lifeboard Firefox extension.

## Folder map
- `app/electron/` main process: windows and views, tabs, history (history.sqlite), downloads, blocker,
  memory saver, logins (safeStorage), trainer, one-time Tauri migration, `selftest.ts`.
- `app/shared/` code used by main and renderer: `state.ts` (reducer), `ipc.ts` (typed channels),
  `layout.ts`, and `lifeboard/` (the prediction engine: router, classifier, completion, training).
- `app/src/` renderer (React/Tailwind): base chrome, overlay UI, dashboard, notes, settings.
- `app/blocklist/` EasyList-derived rules (`SOURCE.md`); `app/assets/icons/`; `app/scripts/` build, package, install.
- `api/` Encore.ts sync + sign-in API (Postgres, needs Docker). Deployed from the `api/` root directory.

## Architecture rules
- Main owns state and layout. The renderer is a mirror: it sends actions, main applies them and sends patches.
- Pages are WebContentsViews placed by main over the renderer's `data-page-slot` rect.
- Anything drawn over pages (menus, popups, modals, hover UI) goes in the overlay view. Never resize a page for a popup.
- Every IPC message is validated in main (types, lengths, allowed values). Never trust the renderer.
- Web pages are sandboxed with no preload and no Node. Only our own UI views get `preload.ts`.
- Electron flags (ozone hint, WaylandWindowDecorations) live in `main.ts`, not just in npm scripts.
- Package paths: use `__dirname` / `app.getAppPath()`, never paths into the source tree.

## Commands (run in `app/`)
- `npm run electron:dev` dev window with hot reload; `npm run electron:build` typecheck + build;
  `npm run electron:package` build + package to `out/jivvy-life-linux-x64/`.
- `npm run app:install` / `app:uninstall` user install in `~/.local` (atomic swap; user data kept).
- Self-test: `JIVVY_SELFTEST=1 timeout 300 npx electron . --user-data-dir=<scratch dir>` (must print `SELFTEST OK`).
  Also works on the packaged binary. `npm run electron:selftest` does the same.
- `npm run bench:search`; `node --test shared/lifeboard/lifeboard.test.ts`.

## Data (`~/.config/jivvy-life`)
`jivvy-state.json` (workspaces, notes, prefs), `history.sqlite`, `predictions.json`, `predictions-eval.jsonl`.
Saved logins are encrypted with Electron safeStorage.

## Privacy
- Never log cookie or password values (counts only). Never print URLs from the user's history in logs.
- Tests and the self-test use scratch profiles only (`--user-data-dir`), never `~/.config/jivvy-life`.

## Token budget
Use Haiku/Sonnet subagents for small scoped tasks (`.claude/agents/`): core-engineer (sonnet, main/IPC/build),
ui-worker (haiku, renderer/overlay), data-worker (haiku, history/prediction/import), tester (haiku, build + tests).
Keep prompts to 1-3 files, ask for short summaries, and run the build once after parallel work.

## NPU note
The `laya` OpenVINO helper stays installed for future features, but search does not use it.
