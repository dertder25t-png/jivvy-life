# LIFE APP ALPHA V1 — MASTER BUILD & TOKEN-EFFICIENCY SPEC

## 1. GOAL
Finish building **Life App v1** from this pre-built starter skeleton into a fully functional Alpha release ready for daily testing:
- **Full Multi-Tab Browsing & Split-Pane Engine:** Unlimited web tabs, `Cmd/Ctrl + K` omnibox, back/forward/reload, pinned tabs, split-vertical view, dedicated Jivvy tab (`https://jivvy-study.vercel.app/`), and Tauri 2 native child `Webview` support with automatic `<iframe>` fallback in `npm run dev`.
- **Customizable Tab & Sidebar Layouts:** Instant switching between `left-vertical` (default), `compact-rail` (auto-hiding 48px icon rail), `classic-top` (horizontal tab strip), and `zen` (chrome-less focus mode with floating command pill).
- **Self-Contained Markdown Notes:** Native CodeMirror 6 editor with `[[wikilinks]]`, backlinks, tags, and local/Supabase persistence (no Obsidian required).
- **1-Click Firefox & Google Data Importer:** Finish wiring `src/services/importService.ts` + `src/components/ImportWizard.tsx` to import Firefox `bookmarks.html` (already parsed — add folder preview/selection), Firefox `places.sqlite` via `sql.js`, and Google Takeout `.zip`/`.json` (Keep notes -> Markdown notes; Chrome bookmarks -> Workspaces).
- **Full Supabase Cloud Sync & Telemetry Foundation:** Sync `workspaces`, `notes`, `user_preferences`, and `telemetry_events` (180s idle-gated focus + behavioral transitions + `Activity Context ID`) with offline IndexedDB/localStorage queue.

---

## 2. STRICT AGENT & TOKEN-BUDGET RULES (READ FIRST)
To minimize API costs while shipping high-quality code, follow these orchestration rules strictly:
1. **Use Subagents (`.claude/agents/`), NOT Agent Teams:** Never spin up full multi-session Agent Teams (they multiply context costs ~7x). Dispatch focused subagents from `.claude/agents/` in parallel for independent tasks.
2. **Route Cheap Work to Haiku (`model: haiku`), Hard Work to Sonnet (`model: sonnet`):**
   - `explore` (Haiku): All codebase searches, file discovery, and dependency lookups.
   - `ui-worker` (Haiku): Tailwind UI components, layout modes (`Sidebar`, `TopTabBar`, `ZenOmnibox`, `ImportWizard`, `SettingsModal`, `NoteEditor` UI).
   - `data-worker` (Haiku): Importer parsers (`places.sqlite`, Google Keep/Chrome JSON), storage helpers, and deterministic telemetry rollups.
   - `core-engineer` (Sonnet): Complex integration only — Tauri 2 native child Webview positioning, Supabase offline sync reconciliation, and TypeScript/Vite build error resolution.
3. **Zero Wasted Tokens:**
   - Do NOT rewrite files that are already complete unless a specific bug or feature requires an edit.
   - Keep subagent prompts concise and scoped to 1–3 target files. Return short summaries, not full file dumps.
   - Run `npm run build` once after parallel subagents finish, and only invoke `core-engineer` if TypeScript or bundler errors appear.

---

## 3. WHAT IS ALREADY BUILT IN THIS SKELETON
- `package.json`, `vite.config.ts`, `tailwind.config.js`, `tsconfig.json` (ready for `npm install`).
- `supabase/schema.sql` (complete Postgres tables + RLS policies).
- `src/types/workspace.ts` (all core TypeScript interfaces).
- `src/store/workspaceStore.ts` (Zustand store with workspaces, tabs, split panes, 4 layout modes, notes, and import merge).
- `src/services/supabaseClient.ts`, `storageService.ts`, `importService.ts` (Firefox HTML parser done), `telemetryService.ts` (180s idle tracker done).
- `src/App.tsx`, `LayoutSwitcher.tsx`, `Sidebar.tsx`, `PaneContainer.tsx`, `ImportWizard.tsx`, `SettingsModal.tsx` (working starter bones).
- `src-tauri/tauri.conf.json` & `src-tauri/capabilities/default.json` (Tauri 2 permissions pre-configured).

---

## 4. REMAINING TASKS TO HIT ALPHA V1
Dispatch these in parallel to subagents:
1. **[ui-worker - Haiku]** Complete `src/components/TopTabBar.tsx`, `src/components/ZenOmnibox.tsx` (`Cmd/Ctrl + K`), polish `compact-rail` hover-expand in `Sidebar.tsx`, and build `src/components/NoteEditor.tsx` with CodeMirror 6 + `[[wikilinks]]` + backlinks.
2. **[data-worker - Haiku]** Complete `parseFirefoxPlacesSqlite` (using `sql.js`) and `parseGoogleTakeout` (using `jszip`) in `src/services/importService.ts`, and wire the multi-step preview UI in `src/components/ImportWizard.tsx`.
3. **[core-engineer - Sonnet]** Wire full bidirectional Supabase sync + offline queue flush in `src/services/supabaseClient.ts` & `storageService.ts`, add Tauri 2 native child `Webview` adapter in `src/components/PaneContainer.tsx` (keeping `<iframe>` dev fallback), and verify `npm install && npm run build` passes with 0 errors.
