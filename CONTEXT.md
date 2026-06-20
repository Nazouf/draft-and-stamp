# Draft & Stamp — project context for Claude Code

This file exists so a fresh Claude Code session in this folder has the
history that a regular chat conversation would have had. Read this first.

## What this is

A prompt-engineering assistant, built from this project's own spec
(`system_prompts.md` and `database_schema.sql`, originally drafted in a
claude.ai Project — ask the user if those aren't in this folder, they're
worth pulling in). The pipeline: classify the request → (if it touches a
regulated/high-stakes domain) flag domain-specific things worth covering →
run an adaptive interview, asking fresh questions each turn rather than from
a fixed bank → if the task is big, plan it into stages → generate the
final, ready-to-use prompt(s), tailored to whichever AI tool they'll be
pasted into.

## How we got to the current state (in order)

1. Built as a single-file HTML artifact inside claude.ai chat, calling the
   Claude API directly. This only worked because that sandbox quietly
   authenticates Claude API calls — it is not representative of how a real
   deployed app would call any provider.
2. Iterated heavily on UX and pipeline quality inside that artifact: a
   "type your own answer" option on every question, sliders for spectrum
   questions, a domain-expert "things to verify" step for sensitive
   requests (lending, healthcare, legal, anything affecting real people),
   per-prompt cards in the result screen instead of one text blob, more
   destination options (ChatGPT, Gemini, Grok, Perplexity, DeepSeek,
   Microsoft Copilot, Midjourney, General) each with real destination-
   specific prompt-writing conventions, and an explicit instruction in the
   final generator telling the destination AI to use search/grounding for
   real-world facts and label what it couldn't verify (this was added after
   a real test on Gemini produced a fabricated-looking statistic with a
   fake citation).
3. User wanted to stop paying for Claude API calls. Researched current free
   options (web search, not just training knowledge) and picked Google's
   Gemini API free tier — genuinely free indefinitely, frontier-quality,
   and it has *native* JSON schema enforcement, which is strictly better
   than what was possible with Claude in that sandbox (there, JSON shape
   was only requested in the prompt text and parsed by hunting for the
   first `{` and last `}` — fragile, and the literal cause of one crash).
4. Tried calling Gemini directly from the browser inside the artifact.
   Blocked by CORS — confirmed via direct testing and via Google's own
   AI Studio engineering writeup, which describes building a literal proxy
   specifically because direct browser calls don't work. This is normal:
   the original Claude version only worked because of sandbox-specific
   magic, not because direct-browser-to-provider calls are generally fine.
5. Tried a Cloudflare Worker as a thin CORS-fixing proxy, configurable from
   inside the artifact. Hit a separate failure (got back an HTML error page
   instead of JSON — likely a misconfigured Worker route, never fully
   debugged) that was painful to diagnose with no real logs, which is what
   prompted the move below.
6. Rebuilt this as a real local app instead of an artifact: an Express
   server (`server.js`) holding the Gemini key server-side via `.env`, with
   a single `POST /api/gemini` route that the frontend calls on its own
   origin (no CORS issue, since it's same-origin). The frontend
   (`public/index.html`) is the same pipeline logic as the artifact, with
   the in-browser key/proxy-URL settings UI removed (no longer needed) and
   the simulated account/credits storage switched from an artifact-only API
   (`window.storage`) to plain `localStorage`, which works in any normal
   browser. **This was tested end-to-end for real** — server started, hit
   with a real request shaped exactly like the browser would send it, got a
   correct response back from real Gemini through the real server.
7. Added `run.sh` / `run.bat` one-click launchers that install dependencies,
   create `.env` from the template on first run, and start the server —
   tested, both branches work.

## Current state, plainly

- **Works:** locally, on one machine, for one person at a time. Real
  Gemini calls, real structured output, the full pipeline (classify,
  considerations, interview, staging, generate) all confirmed working.
- **Does not exist yet:** any public hosting, real user accounts (the
  anonymous/free credit system is simulated per-browser in localStorage,
  not backed by a real database), payments, or abuse/rate-limit
  protection. `database_schema.sql` in the original project already
  designs for a real Postgres setup (Supabase was the suggested host,
  since the schema was written with it in mind) — that hasn't been built.
- **A deliberate simplification worth revisiting:** the original
  `system_prompts.md` spec calls for a cheap/fast model for classify,
  question-selection, and stage-planning, and a stronger model only for
  the final generate step. Everything currently runs on one model
  (`gemini-2.5-flash`) for simplicity. Splitting this back out would cut
  real cost at any meaningful volume, since most calls in a session are
  the cheap ones.

## Conventions worth preserving if you extend this

- Every pipeline step (`CLASSIFY_SYSTEM`, `CONSIDERATIONS_SYSTEM`,
  `SELECT_QUESTION_SYSTEM`, `STAGE_PLANNER_SYSTEM`, `GENERATE_SYSTEM`) has
  a matching `*_SCHEMA` object passed as `responseSchema` — keep new steps
  schema-enforced rather than parsed from free text.
- The question-selector treats topic lists (`TOPIC_SEEDS`) as inspiration,
  never a literal checklist — it writes fresh questions every turn. Don't
  reintroduce a rigid question bank.
- "Required topics" from the considerations step are enforced in *code*,
  not just prompted for — the session is structurally blocked from
  completing until each is answered or explicitly dismissed by the user.
  Keep that pattern (rules that matter get enforced in code, not just
  requested in a prompt) for anything else safety-relevant.
