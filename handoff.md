# Draft & Stamp — Session Handoff (updated 2026-06-20, v1.5.2)

## What This App Is

**Draft & Stamp** is a prompt-engineering assistant. Users describe a task, pick a destination AI (Claude, Gemini, ChatGPT, etc.), go through a short interview, and get one or more ready-to-paste prompts back. Designed for non-technical users — they never see system prompts or AI internals.

- **Live URL:** https://draft-and-stamp.onrender.com
- **GitHub repo:** https://github.com/Nazouf/draft-and-stamp (auto-deploys from `main`)
- **UptimeRobot:** https://stats.uptimerobot.com/2VeDqa7xvK (5-min ping, keeps Render free tier alive)
- **Supabase project:** https://supabase.com → project ID `wwbjeoxhgszgdfgfeova`
- **Current version:** v1.5.2 (shown in footer — bump on every push)

---

## Versioning Rules

`major.minor.fix` — e.g. `v1.5.2`
- **Fix** (last number): bug fixes, small tweaks
- **Minor** (middle number): new features or notable improvements
- **Major** (first number): complete rewrites or massive changes

Always update the version in the footer of `public/index.html` before committing.

---

## Repository & File Structure

**Working directory:** `C:\Users\Fouzan\Downloads\Draft and Stamp`

```
Draft and Stamp/
├── public/
│   ├── index.html        ← THE main file. All CSS, JS, system prompts, schemas.
│   └── admin.html        ← Admin dashboard (dark theme, stats + tables)
├── server.js             ← Express server + Supabase admin client + all API routes
├── package.json          ← type: module, start: node --env-file-if-exists=.env server.js
├── render.yaml           ← Render blueprint, 9 env vars (all sync:false)
├── supabase_schema.sql   ← Reference SQL (already applied — don't re-run blindly)
├── .env                  ← NOT committed. All secrets live here.
├── .gitignore            ← .env, node_modules/, .claude/
└── handoff.md            ← This file
```

**Git identity:** `Fouzan Akhtar <fouzanakhtar888@gmail.com>` | GitHub: Nazouf

---

## .env File (never committed — keys are secret)

The `.env` file is gitignored and never committed. All 9 vars are also set in the Render dashboard (env vars tab).

Keys needed:
```
GEMINI_API_KEY        ← 6 Gemini API keys (KEY through KEY_6)
GEMINI_API_KEY_2
GEMINI_API_KEY_3
GEMINI_API_KEY_4
GEMINI_API_KEY_5
GEMINI_API_KEY_6
PORT=3000
SUPABASE_URL=https://wwbjeoxhgszgdfgfeova.supabase.co
SUPABASE_ANON_KEY     ← sb_publishable_... from Supabase → Project Settings → API
SUPABASE_SERVICE_ROLE_KEY  ← sb_secret_... from same page (service_role)
```

To get the actual values: check Render dashboard env vars, or Supabase project settings, or ask Fouzan for the Gemini keys.

---

## Authentication & Database (Supabase)

### Auth flow
- **No anonymous browsing** — app shows an inline sign-in/sign-up screen until the user is logged in. There is no way to access the main form without an account.
- Sign-up creates a user in `auth.users`, trigger `on_auth_user_created` fires and inserts a row into `public.profiles`.
- Session is stored in `localStorage` by Supabase JS; auto-refreshes tokens; stays signed in for weeks.
- Admin users see a red **Admin** button in the topbar. Non-admins see nothing.
- Google OAuth not yet configured (button removed for now — needs Google Cloud project).

### Supabase tables (all in `public` schema, RLS enabled)

**`profiles`** — one row per user, created by trigger on signup
```sql
id uuid PRIMARY KEY references auth.users,
email text,
is_admin boolean DEFAULT false,
created_at timestamptz DEFAULT now()
```

**`runs`** — one row per completed prompt generation
```sql
id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
user_id uuid references auth.users,
created_at timestamptz DEFAULT now(),
request text,
destination text,
category text,
complexity text,
stakes text,
output_format text,
mode text,
qa_pairs jsonb,
generated_prompts jsonb
```

**`feedback`** — one row per run (upserted, unique on run_id+user_id)
```sql
id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
run_id uuid references runs,
user_id uuid references auth.users,
rating int CHECK (rating >= 1 AND rating <= 10),         -- prompt quality 1-10
results_rating int CHECK (results_rating >= 1 AND results_rating <= 10), -- results quality 1-10
comment text,
created_at timestamptz DEFAULT now(),
UNIQUE (run_id, user_id)
```

**`settings`** — key/value config table
```sql
key text PRIMARY KEY,
value text,
updated_at timestamptz DEFAULT now()
```
Current rows:
- `unrestricted_mode = 'true'` — when true, monthly run limits are disabled (beta mode)

### Trigger (CRITICAL — do not lose this fix)
The `handle_new_user` trigger MUST use `SET search_path = public` and `public.profiles` (fully qualified). Without this it fails with "relation profiles does not exist" because it runs in the auth schema context.

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
```
Trigger: `on_auth_user_created` AFTER INSERT ON `auth.users` → calls `handle_new_user()`.

### Admin account
- **Email:** fouzanakhtar888@gmail.com
- **is_admin:** true (already set in profiles table)
- To make another user admin: `UPDATE public.profiles SET is_admin = true WHERE email = 'x@x.com';`

### Supabase email confirmation URL
Must be set in Supabase Dashboard → Authentication → URL Configuration:
- **Site URL:** `https://draft-and-stamp.onrender.com`
- **Redirect URLs:** `https://draft-and-stamp.onrender.com`, `http://localhost:3000`
(This was configured — confirmation emails now point to the live app, not localhost.)

---

## server.js — Backend Routes

Express + ES modules. Key structure:

```
supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken:false, persistSession:false } })
```

### Helper functions
- `verifyUser(req)` — reads `Authorization: Bearer <token>` header, calls `supabaseAdmin.auth.getUser(token)`, returns user or null
- `isAdminUser(userId)` — queries `profiles.is_admin`
- `getUnrestrictedMode()` — reads `settings` table for `unrestricted_mode`
- `requireAdmin` middleware — verifies JWT + is_admin, attaches `req.adminUser`

### Routes
| Route | Auth | Description |
|---|---|---|
| `GET /admin` | none | Serves `public/admin.html` |
| `GET /api/config` | none | Returns `{ supabaseUrl, supabaseAnonKey, unrestrictedMode }` — browser fetches this on load |
| `POST /api/gemini` | optional | Proxies to Gemini. If unrestricted=false, requires JWT and checks monthly run count (limit: 20) |
| `GET /api/admin/stats` | admin JWT | Total runs, today, active users 7d, thumbs up/down, category/dest breakdown, unrestricted mode |
| `GET /api/admin/runs` | admin JWT | Paginated runs feed (20/page) |
| `GET /api/admin/runs/:id` | admin JWT | Full run detail including qa_pairs and generated_prompts |
| `GET /api/admin/users` | admin JWT | Paginated users with run counts |
| `GET /api/admin/feedback` | admin JWT | Paginated feedback feed |
| `POST /api/admin/settings` | admin JWT | Upsert a settings row (used for unrestricted_mode toggle) |
| `POST /api/admin/users/:id/toggle-admin` | admin JWT | Toggle is_admin on a profile |

### Gemini key rotation
6 keys (`GEMINI_API_KEY` through `GEMINI_API_KEY_6`). On 429/quota error, advances `keyIndex` and tries next key. All non-quota responses are returned immediately.

---

## public/index.html — Architecture

Single-file app. All CSS, HTML, JS, system prompts, schemas in one file. No build step, no bundler, no React.

### Key JavaScript variables (AUTH section, ~line 1380)
```javascript
let sbClient = null;         // Supabase browser client, init'd by initApp()
let currentUser = null;      // auth.User object or null
let isAdmin = false;         // fetched from profiles on every sign-in
let appInitialized = false;  // true after initApp() completes (prevents loading flash)
let unrestrictedMode = true; // from /api/config, reflects settings table
let currentRunId = null;     // UUID of the run saved after generation
let authMode = "signin";     // "signin" | "signup"
let authLoading = false;
let authError = null;
let authSuccess = null;
```

### initApp() flow
1. Fetch `/api/config` → get Supabase URL/key + unrestrictedMode
2. Init `sbClient = supabase.createClient(url, anonKey)`
3. `getSession()` → set `currentUser`
4. `fetchIsAdmin(currentUser)` → set `isAdmin` (reads `profiles` table via RLS)
5. Register `onAuthStateChange` → updates `currentUser`, `isAdmin`, calls `renderAll()`
6. Set `appInitialized = true` → call `renderAll()`

### Auth form pattern
`authFormHTML(isSignUp, includeClose)` — shared HTML builder for both the inline screen and the modal.
`wireAuthForm(isSignUp)` — wires close button + Enter key + show/hide password toggle.
`refreshAuth()` — updates whichever surface is visible (inline or modal).

### renderAll() gate
```
if (!appInitialized)  → show loading
if (!currentUser)     → show renderAuthScreen() inline (no access to app at all)
else                  → normal screen switch (start / classifying / interview / result / etc.)
```

### Supabase error handling
`authMsg(err)` — converts Supabase error to user-friendly string. Handles `"{}"` (empty JSON from email enumeration protection) and undefined messages.

### Feedback system (result screen)
Two 1-10 pill rating rows + text comment + Send button:
- `state.promptRating` (1-10) → saved to `feedback.rating`
- `state.resultsRating` (1-10) → saved to `feedback.results_rating`
- `state.feedbackComment` → saved to `feedback.comment`
- `saveFeedbackToDb(fields)` — upserts one row per run using `onConflict: "run_id,user_id"`
- Pill colours: 1-7 = red when selected, 8-10 = green when selected
- After Send: replaces block with "Thanks for the feedback"

### Slider questions
Show a large live number display (`id="slider-live-num"`) that updates on input. The `#app` input listener updates it. Submits as `value/100` string to Gemini.

### Topbar (renderTopbar)
- Not signed in: empty (whole page is auth screen)
- Signed in: chip(Beta·unlimited) + chip(email) + [Admin button if isAdmin] + Sign out + Start over
- Admin button is a red primary-styled `<a href="/admin">` — completely absent for non-admins

### saveRun() — called in finalizeSession()
Inserts into `runs` table:
```javascript
{ user_id, request, destination, category, complexity, stakes, output_format, mode, qa_pairs, generated_prompts }
```
Returns the new run UUID, stored in `currentRunId` for feedback linking.

### callGemini() — sends JWT
```javascript
headers["Authorization"] = "Bearer " + session.access_token;
```

---

## public/admin.html

Dark-themed admin dashboard. Loaded at `/admin` (explicit Express route — static middleware won't match `/admin` without `.html`).

On load: fetches `/api/config` → inits sbClient → calls `/api/admin/stats`. If 403, shows "not authorized."

Features:
- **Stats cards:** total runs, runs today, active users 7d, thumbs up %, satisfaction %
- **Unrestricted mode toggle:** reads from stats, POSTs to `/api/admin/settings`
- **Category + destination breakdown tables**
- **Tabs:** Runs | Users | Feedback — paginated (20/page)
- **Run detail modal:** full Q&A pairs + generated prompts JSON
- All requests use `adminFetch(path)` which sends `Authorization: Bearer accessToken`

---

## The 5-Step AI Pipeline

Every generation runs these 5 Gemini calls in sequence:

| Step | Model | Purpose | Schema |
|---|---|---|---|
| 1. CLASSIFY | flash-lite (thinking=0) | Category, complexity, stakes, output_format | CLASSIFY_SCHEMA |
| 2. CONSIDERATIONS | flash-lite (thinking=0) | Domain risk topics (only when stakes=sensitive) | CONSIDERATIONS_SCHEMA |
| 3. SELECT_QUESTION | flash-lite (thinking=0) | One interview question at a time, loops until complete | SELECT_QUESTION_SCHEMA |
| 4. STAGE_PLANNER | flash-lite (thinking=0) | How many staged prompts (only when complexity=big) | STAGE_PLANNER_SCHEMA |
| 5. GENERATE | flash (thinking enabled) | The actual final prompt(s) | GENERATE_SCHEMA |

```javascript
const FAST_MODEL   = "gemini-2.5-flash-lite";
const STRONG_MODEL = "gemini-2.5-flash";
```

All schemas are enforced by Gemini's `responseSchema` + `responseMimeType: "application/json"`. No JSON parsing issues.

---

## Version History (this session)

| Version | What changed |
|---|---|
| v1.2 | Original — system prompt improvements, format detection, scope fixes |
| v1.3 | Full Supabase auth + DB integration, admin dashboard, server rewrite |
| v1.4.0 | Required sign-in before app access (no anonymous browsing), fixed duplicate signOut |
| v1.4.1 | Fixed `{}` error display from Supabase email enumeration protection (authMsg helper) |
| v1.4.2 | Show/hide password toggle; fixed handle_new_user trigger (SET search_path = public) |
| v1.4.3 | Admin button in topbar for admin users only; removed footer admin link |
| v1.5.0 | Two-question feedback with thumbs (prompt quality + results quality) |
| v1.5.1 | Replaced thumbs with 1-10 pill ratings + comment textarea + Send button |
| v1.5.2 | Slider questions now show live number display as you drag |

---

## Known Issues / Pending Work

### Google OAuth (not yet done)
The Google sign-in button was removed because Google OAuth hasn't been configured. To add it:
1. Create a Google Cloud project → OAuth 2.0 credentials → add `https://wwbjeoxhgszgdfgfeova.supabase.co/auth/v1/callback` as redirect URI
2. In Supabase Dashboard → Auth → Providers → Google → enter Client ID + Secret
3. Re-add the Google button in `authFormHTML()` calling `sbClient.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } })`

### Monthly run limit (not enforced yet)
When `unrestricted_mode = 'false'`, server enforces 20 runs/month per user. The admin toggle in the dashboard controls this. Currently ON (unrestricted).

### Admin dashboard feedback tab
The feedback table in admin.html shows `rating` column from old 1/-1 schema. Now that ratings are 1-10, the admin dashboard should display both `rating` and `results_rating` as numbers. Not updated yet.

---

## Deployment Workflow

### Make a change:
```
1. Edit public/index.html (or server.js / admin.html)
2. Bump version in footer: find v1.5.2, change to v1.5.3 (fix) or v1.6.0 (feature)
3. git add <file>
4. git commit -m "description (vX.X.X)"  ← always include version in commit message
5. git push origin main
```
Render auto-deploys. Takes ~1 minute. Confirm by checking footer version on live site.

### Local dev:
```bash
cd "C:\Users\Fouzan\Downloads\Draft and Stamp"
npm start   # reads .env, starts on http://localhost:3000
```

### Syntax check JS before commit:
```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const s = html.indexOf('<script>'), e = html.lastIndexOf('</script>');
fs.writeFileSync('_tmp.js', html.slice(s+8,e));
" && node --check _tmp.js && echo OK && rm _tmp.js
```

### Preview server (.claude/launch.json exists):
Use `mcp__Claude_Preview__preview_start` with name `"draft-and-stamp"` to launch and screenshot locally.

---

## Supabase MCP

Available in Claude sessions as `mcp__a08193b6-5feb-40f2-a6a6-491b18b1eb73__*`.
Project ID: `wwbjeoxhgszgdfgfeova`

Useful queries:
```sql
-- Check auth logs for signup/signin errors
-- (use get_logs tool with service:"auth")

-- Make a user admin
UPDATE public.profiles SET is_admin = true WHERE email = 'x@x.com';

-- Check who has signed up
SELECT id, email, email_confirmed_at, created_at FROM auth.users ORDER BY created_at DESC;

-- Check runs
SELECT id, created_at, request, destination, category FROM public.runs ORDER BY created_at DESC LIMIT 10;

-- Check feedback
SELECT run_id, rating, results_rating, comment FROM public.feedback ORDER BY created_at DESC;
```

---

## User Profile

- **Name:** Fouzan Akhtar
- **Email:** fouzanakhtar888@gmail.com (admin account, already confirmed + is_admin=true)
- **Primary use case:** Financial analysis / equity valuation (Pakistan market — PSX, PKR, EFERT, FFC etc.)
- **Preferences:**
  - Prefers concise communication — no summaries of what was just done
  - Semantic versioning: major.minor.fix
  - Wants all features to "just work" without manual steps where possible
  - Non-technical on web/coding side but sophisticated on finance

---

## System Prompt Summary (what each prompt does)

### CLASSIFY_SYSTEM
Reads request + destination → outputs category, complexity, stakes, output_format. Key rules: "excel"/"spreadsheet" → excel_file; "slide deck"/"PowerPoint" → presentation_file. Complexity "big" if multi-deliverable or would take a professional hours. Stakes "sensitive" if regulated domain / real company equity / external reliance.

### CONSIDERATIONS_SYSTEM
Only runs when stakes=sensitive. Expert domain review → list of risk topics that MUST be addressed in the interview. Scope rule: only flags risks for what was actually requested (comps-only ≠ "DCF was not included").

### SELECT_QUESTION_SYSTEM
Drives the interview, one question at a time. Hard disqualifiers: (1) don't ask if example answer self-discloses, (2) don't ask what's already stated in request. Caps: ~5 questions for small tasks, ~8 for big. Question types: single_select, multi_select, slider, free_text.

### STAGE_PLANNER_SYSTEM
Only for complexity=big. Decides how to split into staged prompts. Scope map: comps-only = 1 stage, DCF = 1-2, full model = max 4. Collapse to single if simpler than initially classified.

### GENERATE_SYSTEM
Writes the actual ready-to-paste prompts. Uses thinkingBudget (no cap). Key sections:
- `destination_profiles`: file output capability per AI (ChatGPT yes via Code Interpreter, Claude/Gemini no → markdown fallback)
- `financial_model_guidance`: CFA/IB framework, internal consistency, source quality rules
- `writing_and_correspondence_guidance`: natural voice, no hollow openers, short paragraphs
- `output_format_handling`: excel_file, presentation_file, code_file, written_text, auto

---

## Co-Author Line for Commits

Always include in commit messages:
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```
