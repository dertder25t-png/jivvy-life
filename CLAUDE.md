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
- `npm run bench:search`; `node --test shared/lifeboard/lifeboard.test.ts`.

## Testing (run in `app/`)
- `npm run test:app` = all 159 Electron checks (~70 s); `npm run test:app:quick` = without media, perf, memsaver (~30 s). Both rebuild first; `JIVVY_SKIP_BUILD=1` skips that.
- One or more groups: `bash scripts/selftest.sh core,security` (or `JIVVY_SELFTEST=<groups>`). Needed groups are pulled in automatically; a bad name lists the valid ones and exits 2.
- Groups (electron/selftest/*.ts; `setup` always runs first): tabs (real web tabs, needs internet), history, core, media (slow), security, migration, predictions, perf (slow), browsing, persistence, memsaver (slow).
- Always runs on a throwaway profile (mktemp dir, deleted after), never `~/.config/jivvy-life`. Output: a `GROUP` line per group, then `SELFTEST OK: N passed, 0 failed`.
- Add a check: put it in the matching group file; shared helpers are in `electron/selftest/kit.ts`.

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
