# Draft & Stamp — project context for Claude Code

Read this before doing anything. It covers what the project is, how it works, all rules Fouzan has set, and the full history of what has been built.

---

## What this is

A prompt-engineering assistant that turns vague requests into polished, ready-to-use AI prompts. Pipeline: classify the request → flag domain-specific considerations for high-stakes topics → run an adaptive interview (fresh questions each turn, not a fixed bank) → if the task is big, plan it into stages → generate the final prompt(s) tailored to the destination AI tool.

Live on Render. Users paste the result straight into Claude, ChatGPT, Gemini, Midjourney, etc.

---

## Fouzan's hard rules — never break these

1. **Never commit secrets.** `.env` is gitignored. All secrets live in `.env` locally and in the Render dashboard for production. Never put API keys, Supabase URLs, or service role keys in any committed file.
2. **Never open or launch a browser preview or app window.** Fouzan verifies changes on the live site himself after Render deploys.
3. **Never touch Claude integration.** The app calls Gemini only. Do not add, suggest, or wire up Claude API calls anywhere.
4. **Always bump the version in all three places in every commit:**
   - `server.js` → `const APP_VERSION = "vX.X.X"`
   - `public/js/config.js` → `const APP_VERSION = "vX.X.X"`
   - `public/index.html` → footer text `vX.X.X` AND the CSS cache-bust query string `?v=X.X.X`
5. **Always push after committing.** `git push origin main` immediately after every commit. Render auto-deploys on push.

---

## Tech stack

- **Backend:** Node.js + Express (`server.js`) — single file, no build step
- **Frontend:** Vanilla JS, no framework, no bundler. Files load in order: `config.js → prompts.js → render.js → app.js`. All globals are shared across files.
- **Database:** Supabase (Postgres). Tables: `runs`, `profiles`, `settings`, `gemini_keys`, `feedback`, `errors`, `funnel_events`
- **AI:** Google Gemini API. Multiple API keys in rotation (`gemini_keys` table). Two model pools:
  - `FAST_MODELS`: `["gemini-3.1-flash-lite", "gemma-4-26b-a4b-it", "gemma-4-31b-it"]` — classify, considerations, interview questions, stage planner
  - `STRONG_MODELS`: `["gemini-2.5-flash", "gemini-3.5-flash"]` — generate step (big/complex tasks only)
- **Auth:** Supabase Auth (Google OAuth + email/password). Supabase JS client loaded from CDN.
- **Hosting:** Render (auto-deploy on push to `main`)
- **CSS:** Single file `public/css/main.css`, cache-busted with `?v=X.X.X`

---

## Architecture details

### No build step
Everything in `public/` is served as-is. `config.js` declares all constants (model lists, schemas, system prompts). `prompts.js` holds system prompt strings. `render.js` has all rendering functions. `app.js` has state, event handling, and API calls. All are globals — no imports/exports.

### Settings system
Persistent config lives in the `settings` table as key/value pairs. `applySettingRow(key, value)` in `server.js` maps DB keys to in-memory variables. `loadKeyStats()` runs at startup to hydrate everything. Admin can change settings live via `/admin.html`.

### Gemini key rotation
`callWithRotation(modelPool, body)` in `server.js` tries models in priority order, picks the coldest key (LRU) for each model, skips keys/models on 60s cooldown after a 429. Falls back to the coldest slot if all are cooling down. Slot stats persisted to `gemini_keys` table.

### Thinking budget system
`callGemini(systemPrompt, userMessage, responseSchema, maxOutputTokens, thinkingBudget, model, step)` in `app.js`.
- `thinkingBudget: 0` = thinking off (all non-generate steps)
- Generate step picks budget dynamically based on `state.classification`:
  - `complexity === "small"` → FAST_MODELS, budget 0 (~3-5s)
  - `complexity === "big"`, simple categories (writing/research/image/video/presentation/other) → STRONG_MODELS, budget 1024 (~10-20s)
  - `complexity === "big"`, heavy categories (code/financial_model/legal/agent_prompt) → STRONG_MODELS, budget 5120 (~25-40s)

### Auth gate and rendering flow
`renderAll()` in `render.js` is the single render entry point. It checks in order:
1. Not initialized → loading screen
2. Shared result screen → `renderSharedResult()`
3. Pending password recovery → `renderUpdatePasswordScreen()`
4. `!currentUser && (!anonAccepted || anonDailyLimit === 0)` → inline auth screen inside `#app`
5. Otherwise → switch on `state.screen`

The auth modal (`#auth-overlay`) is a sibling of `#app` in the DOM — OUTSIDE `#app`. Therefore the main delegated click handler on `#app` never sees clicks inside the modal. The `#auth-overlay` element has its own dedicated delegated handler.

The feedback modal (`#feedback-overlay`) follows the same pattern — sibling of `#app`, its own delegated handler for close/submit actions.

### Anonymous (guest) user flow
- On first visit, non-logged-in users see the auth screen with a "Continue as guest — N free prompts" button (when `anonDailyLimit > 0`)
- Clicking it sets `localStorage.ds_anon_accepted = '1'` and `anonAccepted = true`, which bypasses the auth gate
- A UUID token is generated in `localStorage.ds_anon_id` (never changes per browser)
- Server tracks anon usage in in-memory Maps: `anonByIp` (IP → count/date) and `anonByToken` (token → count/date). Resets daily.
- Limit enforced at the classify step only. Non-classify steps always pass through for in-progress sessions.
- **Anon limit enforces independently of Unrestricted Mode.**
- When limit is hit: `startOver()` and `backToStart()` intercept and call `openLoginWithGate("anon_limit")`. The guest completes their session uninterrupted; upsell appears when they try to leave.

### Run saving
`saveRun()` in `app.js`:
- If `currentRunId` exists (set during interview by `saveProgressToDb`): does an UPDATE adding `generated_prompts` and `model_usage`
- If no `currentRunId` (guest users, fast-path sessions, skipped interview): does an INSERT with all fields
- **`generated_prompts` is saved as `state.finalResult`** — the full object `{assumptions, elevatedStakesNotes, prompts[]}`, NOT just the prompts array. This matters because history reader expects either this object format or a bare array (legacy), handled by:
  ```js
  const gp = run.generated_prompts;
  const prompts = Array.isArray(gp) ? gp : (gp && gp.prompts) || [];
  ```
- Guest runs save with `user_id: null`.
- **RLS UPDATE policy exists** on `runs` table (`CREATE POLICY "Users can update own runs" ON runs FOR UPDATE USING (auth.uid() = user_id)`). This was missing until v3.9.19 and silently blocked all saveRun UPDATE calls.

### My Prompts / history screen
- Only runs with `generated_prompts IS NOT NULL` are returned by `/api/runs` — incomplete runs are excluded.
- Runs can be locally hidden via the × button. Hidden run IDs are stored in `localStorage.hiddenRuns` (a JSON array). These runs are NOT deleted from the DB — Fouzan wants all data preserved.
- The `history-back` action (`state.screen = "start"; renderAll()`) returns to the start screen without resetting state, so any text typed in the main input is preserved.
- "← Back" button is rendered inline with the "My Prompts" title (flex row, space-between).

### Topbar layout
- **Desktop:** brand | [My Prompts] [Admin?] [Sign in / Start over / Sign out] [dot-menu ⋮]
- **Mobile:** brand | [My Prompts] [dot-menu ⋮] — other buttons hidden via `topbar-hide-mobile`
- **Dot-menu always visible** (both desktop and mobile) — `.topbar-more-btn` is no longer mobile-only in CSS
- **Desktop dot-menu contents:** user email, Feedback, Dark/Light toggle
- **Mobile dot-menu adds:** Start over, Sign out (these items have `class="topbar-menu-mobile-only"` — hidden on desktop via CSS, shown in mobile media query)
- Email address is shown inside the dot-menu only, not in the topbar itself

### Feedback system
- **In-app feedback modal** (`#feedback-overlay`): triggered by "Feedback" button in topbar (desktop) or dot-menu. Free-text textarea. Submits to `/api/general-feedback` POST endpoint.
- `/api/general-feedback` saves to `feedback` table with `run_id: null`, `user_id` from verified session or null for guests.
- **Per-run feedback** (rating sliders) is separate — triggered from the result screen, saves with a `run_id`.
- Admin Feedback tab shows all feedback. Rows with `run_id: null` (general feedback) show "General" label instead of a "View run" button.

### Share feature
- Any completed run in My Prompts has a Share button. Generates a `/share/:id` URL.
- The share page (`renderSharedResult()`) handles empty prompts gracefully with a friendly message instead of a blank page.
- Share links work without sign-in (public endpoint `/api/share/:id`).

---

## Current version: v3.9.25

### Full version history (recent)

| Version | What changed |
|---------|-------------|
| v2.9.11 | Fixed anonDailyLimit=0 loophole; fixed model_usage null on insert path |
| v2.9.12 | Added Share button to history cards |
| v2.9.13 | Share button shown on all history cards regardless of prompt count |
| v2.9.14 | Added Feedback button + modal; dot-menu now visible on desktop |
| v2.9.15 | Removed Sign in from anon dot-menu (stays in topbar only) |
| v2.9.16 | Desktop dot-menu: email/Feedback/Dark-Light only; Start over + Sign out moved outside |
| v2.9.17 | Removed email chip from desktop topbar (email only in dot-menu now) |
| v2.9.18 | Mobile dot-menu adds Start over + Sign out; empty share page gets friendly message |
| v3.9.19 | Fixed generated_prompts never saving correctly (saveRun saved wrong field; added RLS UPDATE policy to runs table) |
| v3.9.20 | Added error logging to saveRun UPDATE path (was silently failing) |
| v3.9.21 | My Prompts only shows completed runs (generated_prompts IS NOT NULL filter on /api/runs) |
| v3.9.22 | Moved "Start a new prompt" button to top of history page |
| v3.9.23 | "Start a new prompt" button moved inline with "My Prompts" title (right side) |
| v3.9.24 | "← Back" button preserves typed request; history-back action doesn't reset state |
| v3.9.25 | Admin feedback table: "General" label for rows with run_id null instead of broken button |

---

## Admin panel (`/admin.html`)

Password-protected. Key sections:
- **Stats:** run counts, active users, category breakdown, model usage breakdown
- **Runs:** paginated run table with search/filter, expandable run detail modal
- **Users:** user list with run counts
- **Feedback:** all feedback submissions. Per-run feedback shows "View run" button; general feedback (no run_id) shows "General" label.
- **Limits:** monthly run limit per user, anonymous prompts per day, rate limit toggle
- **Models:** enable/disable individual models, set timeouts
- **Keys:** view Gemini API key stats (quota usage, 429 counts, last used)
- **Errors:** DB-logged pipeline errors
- **Settings:** unrestricted mode toggle, other flags

Key settings stored in `settings` table:
- `unrestricted_mode` — if true, monthly run limit not enforced for logged-in users (anon limit still applies)
- `anon_daily_limit` — integer, free prompts per guest per day (0 = block all guests)
- `monthly_run_limit` — integer
- `rate_limit_enabled` — boolean
- `server_quick_timeout` / `server_generate_timeout` — ms timeouts for API calls
- `model_enabled:<model-name>` — per-model enable/disable

---

## Files worth knowing

| File | Purpose |
|------|---------|
| `server.js` | Express server, Gemini proxy, auth, rate limiting, key rotation, admin API, all DB writes |
| `public/js/config.js` | APP_VERSION, model pool arrays, all JSON schemas, TOPIC_SEEDS, STAGE_HINTS |
| `public/js/prompts.js` | System prompt strings (CLASSIFY_SYSTEM, GENERATE_SYSTEM, etc.) |
| `public/js/render.js` | All rendering functions including renderAll(), topbar, history screen, share page, feedback modal |
| `public/js/app.js` | State, event handlers, callGemini(), pipeline functions, saveRun(), auth logic, feedback submit |
| `public/css/main.css` | All styles, single file |
| `public/index.html` | Shell HTML, loads scripts in order, footer version, CSS cache-bust link, #auth-overlay, #feedback-overlay |
| `public/admin.html` | Admin panel, self-contained |
| `.env` | Never committed. Contains GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD |

---

## Pipeline steps and which model each uses

1. **Classify** — FAST_MODELS, budget 0. Reads the user's request, outputs category/complexity/stakes/output_format.
2. **Considerations** — FAST_MODELS, budget 0. For high-stakes domains, lists topics that must be covered.
3. **Select question** — FAST_MODELS, budget 0. Picks the next interview question based on what's been covered. Called once per question turn.
4. **Stage planner** — FAST_MODELS, budget 0. Only runs for `complexity=big`. Breaks the task into stages.
5. **Generate** — model pool and thinking budget chosen dynamically (see thinking budget system above).

---

## Things deliberately NOT built / out of scope

- Saving guest run history to account after sign-up (guest runs with `user_id: null` stay unlinked)
- Deleting runs from DB (hide-run is localStorage-only by design — Fouzan wants all data preserved)
- Claude API integration (forbidden by Fouzan)
- Any build step, bundler, or framework
- Browser previews during development sessions

---

## Conventions to maintain

- Every pipeline step has a matching `_SCHEMA` object passed as `responseSchema`. Keep new steps schema-enforced.
- The question-selector treats `TOPIC_SEEDS` as inspiration, not a checklist. It writes fresh questions. Don't reintroduce a fixed question bank.
- Required topics from the considerations step are enforced in code — the session can't complete until each is answered or dismissed.
- CSS cache-busting: always update the `?v=X.X.X` query string on the `<link>` tag in `index.html` when changing CSS.
- No comments explaining WHAT code does — only WHY if non-obvious.
- No emojis in code or UI unless Fouzan specifically asks.
