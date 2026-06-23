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
   - `public/index.html` → footer text `v2.X.X` AND the CSS cache-bust query string `?v=2.X.X`
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
- Previously `enableThinking: true` (boolean) sent no thinkingConfig, meaning the API used its full default budget (up to 24k tokens = 60-90s). Now always set explicitly.

### Auth gate and rendering flow
`renderAll()` in `render.js` is the single render entry point. It checks in order:
1. Not initialized → loading screen
2. Shared result screen → `renderSharedResult()`
3. Pending password recovery → `renderUpdatePasswordScreen()`
4. `!currentUser && (!anonAccepted || anonDailyLimit === 0)` → inline auth screen inside `#app`
5. Otherwise → switch on `state.screen`

The auth modal (`#auth-overlay`) is a sibling of `#app` in the DOM — it is OUTSIDE `#app`. Therefore the main delegated click handler on `#app` never sees clicks inside the modal. The `#auth-overlay` element has its own dedicated delegated handler covering all modal button actions.

### Anonymous (guest) user flow
- On first visit, non-logged-in users see the auth screen with a "Continue as guest — N free prompts" button (when `anonDailyLimit > 0`)
- Clicking it sets `localStorage.ds_anon_accepted = '1'` and `anonAccepted = true`, which bypasses the auth gate in `renderAll()`
- A UUID token is generated in `localStorage.ds_anon_id` (never changes per browser)
- Server tracks anon usage in in-memory Maps: `anonByIp` (IP → count/date) and `anonByToken` (token → count/date). Resets daily by date comparison.
- Limit enforced at the classify step only (first API call of a session). Non-classify steps (interview, generate) always pass through for in-progress sessions.
- `X-Anon-Token` header sent on every Gemini call; `_step: "classify"` field sent in body for classify calls only. Server strips `_step` before forwarding to Google.
- **Anon limit enforces independently of Unrestricted Mode** — admin can have unrestricted mode on (no monthly limit for logged-in users) and the anon daily limit still applies.
- When limit is hit: `startOver()` and `backToStart()` intercept and call `openLoginWithGate("anon_limit")` instead of going back to the start screen. The guest completes their full session uninterrupted; the upsell appears when they try to leave.
- The upsell modal shows: icon, "You've used your N free prompt(s)", 4 feature bullets (unlimited prompts, save prompts, cross-device, free during beta), reset note, then Google / email sign-in / create account buttons.

### Run saving
`saveRun()` in `app.js`:
- If `currentRunId` exists (set during interview by `saveProgressToDb`): does an UPDATE adding `generated_prompts` and `model_usage`
- If no `currentRunId` (guest users, fast-path sessions, skipped interview): does an INSERT with all fields including `model_usage: state.usageEvents`
- Guest runs save with `user_id: null`. They are NOT linked to an account after sign-up (not yet built).

### `model_usage` field
Populated on every run (both insert and update paths). Array of `{step, model, input_tokens, output_tokens}` objects. Used by admin model stats page. Was null for all historical runs until v2.9.11 fixed the insert path.

---

## Current version: v2.9.11

### Full version history (recent)

| Version | What changed |
|---------|-------------|
| v2.9.5 | Initial anonymous browsing implementation (had architectural bugs) |
| v2.9.6 | Rebuilt guest flow: `anonAccepted` flag, "Continue as guest" button, auth modal delegation fix, modal auto-close on sign-in |
| v2.9.7 | "Let AI decide" button filled green on all screen sizes (was mobile-only) |
| v2.9.8 | Fixed anon limit bypassed by Unrestricted Mode — anon check now independent |
| v2.9.9 | Upsell popup moved to post-session (startOver/backToStart intercept), full styled upsell modal with feature bullets |
| v2.9.10 | Thinking budget per complexity/category — small tasks use FAST_MODELS+budget 0, big tasks capped budgets |
| v2.9.11 | Fixed anonDailyLimit=0 loophole; fixed model_usage null on insert path |

---

## Admin panel (`/admin.html`)

Password-protected. Key sections:
- **Stats:** run counts, active users, category breakdown, model usage breakdown
- **Limits:** monthly run limit per user, anonymous prompts per day, rate limit toggle
- **Models:** enable/disable individual models, set timeouts
- **Keys:** view Gemini API key stats (quota usage, 429 counts, last used)
- **Settings:** unrestricted mode toggle, other flags

Key settings stored in `settings` table:
- `unrestricted_mode` — if true, monthly run limit is not enforced for logged-in users (anon limit still applies)
- `anon_daily_limit` — integer, how many free prompts a guest can run per day (0 = block all guests)
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
| `public/js/render.js` | All rendering functions including renderAll(), auth modal HTML, history screen |
| `public/js/app.js` | State, event handlers, callGemini(), pipeline functions (runClassify, runGenerate, etc.), saveRun(), auth logic |
| `public/css/main.css` | All styles, single file |
| `public/index.html` | Shell HTML, loads scripts in order, footer version, CSS cache-bust link |
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
- Claude API integration (forbidden by Fouzan)
- Any build step, bundler, or framework
- Browser previews during development sessions

---

## Conventions to maintain

- Every pipeline step has a matching `_SCHEMA` object passed as `responseSchema`. Keep new steps schema-enforced.
- The question-selector treats `TOPIC_SEEDS` as inspiration, not a checklist. It writes fresh questions. Don't reintroduce a fixed question bank.
- Required topics from the considerations step are enforced in code — the session can't complete until each is answered or dismissed.
- CSS cache-busting: always update the `?v=X.X.X` query string on the `<link>` tag in `index.html` when changing CSS.
- No comments explaining WHAT code does — only WHY if non-obvious (hidden constraint, workaround, subtle invariant).
- No emojis in code or UI unless Fouzan specifically asks.
