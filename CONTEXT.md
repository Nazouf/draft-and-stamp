# Draft & Stamp — project context for Claude Code

Read this before doing anything. It covers what the project is, how it works, all rules Fouzan has set, and the full history of what has been built.

---

## What this is

A prompt-engineering assistant that turns vague requests into polished, ready-to-use AI prompts. Pipeline: classify the request → flag domain-specific considerations for high-stakes topics → run an adaptive interview (fresh questions each turn, not a fixed bank) → if the task is big, plan it into stages → generate the final prompt(s) tailored to the destination AI tool.

Live on Render. Users paste the result straight into Claude, ChatGPT, Gemini, Midjourney, etc.

**Categories (12):** `writing`, `creative_writing`, `summarisation`, `code`, `image`, `research`, `financial_model`, `presentation`, `video`, `agent_prompt`, `legal`, `other`. (`creative_writing` and `summarisation` were split out from `writing`/`research` in v3.9.29 based on real-usage data — see "Data-driven pipeline design" below.)

**Much of the interview/generation logic since v3.9.29 is grounded in analysis of two public datasets** (WildChat-1M + OpenAssistant), not just intuition. The "Data-driven pipeline design" section documents the findings and which prompt rules they justify. The analysis scripts live in the repo root (untracked) — see "Research artifacts".

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
  - `complexity === "big"`, light categories (everything not in heavyCats — writing, creative_writing, summarisation, research, image, video, presentation, other) → STRONG_MODELS, budget 1024 (~10-20s)
  - `complexity === "big"`, heavy categories (`heavyCats = ["code","financial_model","legal","agent_prompt"]`) → STRONG_MODELS, budget 5120 (~25-40s)

### Auth gate and rendering flow
`renderAll()` in `render.js` is the single render entry point. It checks in order:
1. Not initialized → loading screen
2. Shared result screen → `renderSharedResult()`
3. Pending password recovery → `renderUpdatePasswordScreen()`
4. `!currentUser && (!anonAccepted || anonDailyLimit === 0)` → inline auth screen inside `#app`
5. Otherwise → switch on `state.screen`

The auth modal (`#auth-overlay`) is a sibling of `#app` in the DOM — OUTSIDE `#app`. Therefore the main delegated click handler on `#app` never sees clicks inside the modal. The `#auth-overlay` element has its own dedicated delegated handler.

The feedback modal (`#feedback-overlay`) follows the same pattern — sibling of `#app`, its own delegated handler for close/submit actions.

**Google OAuth reassurance note (v3.9.28):** Both "Continue with Google" buttons (upsell modal + main welcome modal) are followed by a `<p class="auth-google-note">` reading "The sign-in screen may show an unfamiliar URL — this is expected and secure." This addresses the Google consent screen showing the Supabase project URL (`wwbjeoxhgszgdfgfeova.supabase.co`) instead of the app name. There is no free fix for the URL itself — it comes from the OAuth `redirect_uri` routing through Supabase; removing it would require Supabase Pro, a custom OAuth callback, or a verified custom domain + Google brand verification. The note is the accepted workaround. CSS class `auth-google-note` has separate desktop/mobile sizing.

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

### Batched questions (v3.9.30–3.9.31)
The interview can ask **2–4 independent questions on one screen** instead of strictly one-per-turn. This reduces friction (one round-trip + one Gemini call instead of several) for questions whose answers don't depend on each other — e.g. tone, length, direction, output shape for a writing task.

- **Schema:** `SELECT_QUESTION_SCHEMA` (config.js) has an `ask_batch` action and a `batch_questions` array (each item is the shared `QUESTION_ITEM_SCHEMA`). Foundational/cascading questions (company → exchange → ticker) still come one at a time via `ask_question`.
- **State:** `state.currentBatch` (array) + `state.batchAnswers` (map keyed by question id; custom "write your own" answers stored under `custom:<id>`).
- **Flow (app.js):** `runSelectQuestion` intercepts `action === "ask_batch"` **before** the existing `!next_question` guards (a batch has `next_question: null`, which would otherwise trigger the complete/forced-topic path). A batch of 1 degrades to a normal single question. `submitBatch()` reads free-text/custom from the DOM, pulls select/multi from `batchAnswers`, records every question to `qaHistory` (unanswered → `"[No preference — use your best judgment]"`), then loops. `syncBatchFreeText()` captures typed text into state before any option-click re-render wipes it.
- **Render (render.js):** new `interview_batch` screen → `renderInterviewBatch()` / `renderBatchQuestion()`. Reuses existing `check-row`/`check-box` widgets (single_select rendered radio-style, multi_select as checkboxes). Each select question has an inline "Or write your own answer…" field (`batch-custom-<id>`) that overrides the selection at submit. Sliders are never batched. CSS: `.batch-stack`, `.batch-q`, `.batch-custom`.
- **The whole batch path is additive** — if the model never returns `ask_batch`, behavior is exactly as before. Question budget counts every batched question (batching reduces friction, not the count).

### Refine loop (v3.9.37)
The result screen has a **Refine** box: the person types one plain-language tweak ("make it shorter", "use Python instead", "add a constraint about X") and the finished prompt(s) are rewritten in place. `runRefine()` (app.js) feeds the full current `state.finalResult.prompts` + the shared generate context + the instruction to a dedicated `REFINE_SYSTEM` (prompts.js) via `buildRefineMsg()`, using `REFINE_SCHEMA` (= `GENERATE_SCHEMA`) and the same model pool/budget as generation (`generateModelConfig()`). It is an edit, not a regen — same number/structure of prompts unless the tweak requires otherwise. On success it replaces `finalResult`, re-runs `saveRun()`, resets the feedback widgets, and re-types. Errors set `state.error.step = "refine"` (handled by `retryLastStep`). Refine controls are disabled during the typewriter and re-enabled via `enableRefineControls()`.

### Per-stage generation + editable stage plan (v3.9.37)
For a genuinely multi-stage task (`stagePlan` not collapsed and >1 stage), `runGenerate()` now fires **one Gemini call per stage in parallel** (`Promise.all` over `buildStageGenerateMsg(i)`), each with its own full response budget, instead of squeezing all stages into a single call. Each call returns one prompt; assumptions and elevated-stakes notes are merged + de-duped across stages. Single/collapsed plans still use the original single-call `buildGenerateMsg()` path. Both share `buildGenerateContextLines()`. The **staged screen is editable** before generation: edit each stage's title/purpose inline, remove, reorder (↑/↓), or add a part (max 4) — `renderStaged()` + `stageEdit*`/`stageMove`/`stageAdd`/`stageRemove` (app.js), state in module-level `stageEditIndex/Title/Purpose`.

### Outcome tracking (v3.9.37)
The per-run feedback block has a **"Did it work when you used it?"** row (worked / edited / failed) above the rating sliders. `setPromptOutcome()` saves to a new `feedback.outcome` text column via the existing `saveFeedbackToDb()` upsert (logged-in only, same as ratings). Surfaced in the admin Feedback tab. This is the highest-signal feedback — real-world effectiveness of the generated prompt, not just a self-rating.

### Data-driven pipeline design (v3.9.29+)
The interview rules are grounded in analysis of two independent public datasets:
- **WildChat-1M** (real ChatGPT conversations) — 2,495 multi-turn conversations where the user corrected the AI on turn 2+, mined from 120k.
- **OpenAssistant oasst2** — 2,085 correction follow-ups, used as a cross-validation source (LMSYS-Chat-1M is gated).

**Key findings that drove changes:**
- Misses are rarely single-dimensional: 21% of corrections stacked 4+ distinct asks at once. → the "Defaults I assumed" surfacing + category-aware self-check.
- More context up front = fewer correction rounds: 6+ round conversations averaged 162 opening words vs 289 for ≤3 rounds; the **26–50 word band took the most rounds (5.19)** — "ambitious but under-specified" is the danger zone. → the anti-collapse rule.
- Top cross-validated corrections: **length, direction/angle, missing-detail, format/structure, regenerate-from-scratch.** Tone is real but ranks lower than a single-source pass suggested.
- **Audience was a keyword artifact** (21% in WildChat → 1.1% in OASST) — deliberately NOT a must-ask; reintroduced only as soft enrichment for external-facing tasks.
- `creative_writing` (~11–17% of corrections) and `summarisation` (~5%) were distinct enough to become their own categories.

### Prompt structure: the interview-control sections (prompts.js → `SELECT_QUESTION_SYSTEM`)
- **`<category_must_ask>`** — per-category non-negotiable foundational questions, asked one per turn as critical priority, skipped if the request already answered them. Every working category has a block (see "Must-ask questions per category" below).
- **`<high_value_enrichment>`** — two high-leverage enrichment offers: (1) **example/style reference** (few-shot) for writing/creative/code/agent — paste an example to match; (2) **audience** for external-facing/professional output only.
- **`<under_specified_complex_requests>`** — anti-collapse rule. `buildSelectQuestionMsg` (app.js) computes the request word count; a big task under 40 words is flagged `UNDER-SPECIFIED COMPLEX REQUEST`, and this rule then treats length/shape/direction/must-include as critical (prefers a single batch to close the gap).
- **`<batching_independent_questions>`** — when to use `ask_batch` vs one-at-a-time.

### Prompt structure: the generation sections (prompts.js → `GENERATE_SYSTEM`)
- **SURFACE THE DEFAULTS YOU ASSUMED** (in `<writing_and_correspondence_guidance>`) — for writing/content tasks, any of length/shape/tone/direction that wasn't settled in the interview must be listed as its own entry in the `assumptions` array, so multi-dimensional misses are correctable at a glance.
- **`<user_supplied_material>`** — embed any pasted example **verbatim** in a labeled block (few-shot), and pass through pasted source text / data / existing code faithfully rather than compressing it to a label (context engineering).
- **`<self_verification>`** — close the prompt with a category-aware self-check: writing checks captured constraints, code traces the test case, financial audits figures line-by-line, research verifies claims. Targets the costly "rewrite from scratch" failure.

---

## Current version: v3.9.38

### Full version history (recent)

| Version | What changed |
|---------|-------------|
| v2.9.11 | Fixed anonDailyLimit=0 loophole; fixed model_usage null on insert path |
| v2.9.12–18 | Share button, Feedback modal, topbar/dot-menu layout iterations |
| v3.9.19 | Fixed generated_prompts never saving (wrong field in saveRun; added RLS UPDATE policy to runs) |
| v3.9.20 | Error logging on saveRun UPDATE path |
| v3.9.21 | My Prompts only shows completed runs (generated_prompts IS NOT NULL) |
| v3.9.22–24 | History page button placement; "← Back" preserves typed request |
| v3.9.25 | Admin feedback: "General" label for run_id-null rows instead of broken button |
| v3.9.26 | CONTEXT.md rewrite + minor |
| v3.9.27 | LinkedIn posts classified "professional" stakes; LinkedIn must-ask block (tone/avoid/angle) |
| v3.9.28 | Universal writing must-ask (tone + length critical for all writing); Google OAuth reassurance note |
| v3.9.29 | **Added `creative_writing` + `summarisation` categories**; direction/angle as universal writing must-ask (data-driven) |
| v3.9.30 | **Batched questions** (`ask_batch` + `interview_batch` screen); Tier-1: output-shape must-ask, "Defaults I assumed" surfacing, writing self-check |
| v3.9.31 | "Write your own answer" field on batch select questions |
| v3.9.32 | Must-ask questions added for code, image, research (previously seed-only) |
| v3.9.33 | Few-shot/example capture + verbatim embedding; raw-context passthrough; category-aware self-check; audience as soft enrichment; per-category blockers (summarisation source, code test-case, image aspect-ratio, legal core obligation) |
| v3.9.34 | Must-include facts (writing, scoped to thin requests); anti-collapse rule for under-specified big tasks; direction as must-ask for code (approach) + research (angle) |
| v3.9.35 | Docs only — comprehensive CONTEXT.md update through v3.9.34 (no app behavior change) |
| v3.9.36 | Persist guest runs via service-role `/api/track-run` endpoint (RLS blocks NULL-user read/update on the anon client) |
| v3.9.37 | **Four features:** (1) post-generation **refine** loop; (2) `other`-category must-asks; (3) real-world **outcome** tracking (worked/edited/failed); (4) **editable stage plan** + **per-stage parallel generation** |
| v3.9.38 | **Option descriptions** — added `description` field to option schema (replaces `example`); all four option render paths (single_select button, multi_select check-row, batch single_select, batch multi_select) now show a muted one-liner below the label; system prompt instructs model to write a concrete ≤12-word description for every option |

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
| `.env` | Never committed. Contains GEMINI_API_KEY(s), SUPABASE_URL, SUPABASE keys, PORT |

### Research artifacts (repo root, untracked — NOT part of the deployed app)

Standalone Python scripts used to mine public datasets for the data-driven pipeline design. Pure local analysis, no app dependency. Safe to ignore for app work; useful if revisiting the interview/generation rules.

| File | Purpose |
|------|---------|
| `analyze_wildchat.py` | First-pass WildChat correction analysis (category × correction-type) |
| `deep_analysis.py` | Deeper pass: stacked corrections, prompt-length vs rounds, n-gram mining |
| `crossval_oasst.py` | Cross-validation against OpenAssistant oasst2 |
| `*_report.txt`, `*_results.json` | Generated outputs from the above |

Requires `pip install datasets`. WildChat streams fine unauthenticated; LMSYS-Chat-1M is gated (not used). **Do not send dataset rows to Gemini** — Fouzan asked for local analysis only.

---

## Pipeline steps and which model each uses

1. **Classify** — FAST_MODELS, budget 0. Reads the user's request, outputs category/complexity/stakes/output_format.
2. **Considerations** — FAST_MODELS, budget 0. For high-stakes domains, lists topics that must be covered.
3. **Select question** — FAST_MODELS, budget 0. Picks the next interview question based on what's been covered. Called once per question turn.
4. **Stage planner** — FAST_MODELS, budget 0. Only runs for `complexity=big`. Breaks the task into stages.
5. **Generate** — model pool and thinking budget chosen dynamically (see thinking budget system above).

---

## Must-ask questions per category

Defined in `<category_must_ask>` inside `SELECT_QUESTION_SYSTEM` (prompts.js). Asked as critical priority before enrichment; each skipped if the request already answered it. The matching enrichment inspiration lives in `TOPIC_SEEDS` (config.js).

- **Writing (universal):** tone · length · direction/constraints · output shape · must-include specifics (last only when the request is thin on detail). *Exception: trivial informal writing skips all.*
- **Writing (cover letters/applications):** sender's name · real certs/credentials · specific achievements.
- **Writing (LinkedIn/professional social):** voice/tone · what to avoid · narrative angle.
- **Creative writing:** genre/style · narrative direction · what to avoid.
- **Summarisation:** confirm the source content is provided · output style · compression level · what to preserve.
- **Code:** language/framework/environment · a literal test case (input→output) · where it runs · direction/approach (constraints, library, simple-vs-robust).
- **Image:** which tool · subject/scene · visual style/medium · aspect-ratio/use.
- **Research:** purpose + output format · angle/focus + what to exclude · depth vs breadth · the person's level.
- **Financial model:** current revenue / core metric (then the deeper probing chain: listing status → exchange → ticker → base year → FX → commodity → valuation approach).
- **Presentation:** how many slides.
- **Video (generation):** AI-tool-vs-human-script · subject + motion. **(script):** the single key message.
- **Agent prompt:** the one core job (always-do / never-do) · platform.
- **Legal:** jurisdiction · parties + roles · core obligation/exchange.
- **Other:** what a good result looks like + who it's for · output shape and rough size/detail (then at most one enrichment on constraints). Kept light — over-asking on open-ended tasks backfires.

Cross-cutting: contradictions are resolved before tone/style; identifying details (real person/company) are asked before soft preferences.

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
- **Quality of questions over quantity.** Spend the question budget on the high-correction dimensions (length, shape, direction, must-include facts) + an example; don't pad with low-value confirmation. Every new must-ask must be justified, and must skip when the request already answered it. Over-asking causes abandonment.
- **Most pipeline changes are prompt-only** (edits to `prompts.js` `SELECT_QUESTION_SYSTEM` / `GENERATE_SYSTEM`, plus `TOPIC_SEEDS`/`STAGE_HINTS` in config.js). These are low-risk. The batched-question feature is the only recent architecture change — keep new question types additive so the single-question path is never broken.
- After editing any JS, run `node --check <file>` before committing (no test suite; this catches template-literal/syntax breaks).
- When designing interview/generation rules, prefer evidence (the datasets) + judgment + a quick best-practice check over intuition alone — that's how the current rules were built.
