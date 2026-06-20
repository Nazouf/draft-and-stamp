# Draft & Stamp

A real local web app: a small Express server holding your Gemini API key,
serving a frontend that runs the full classify → consider → interview →
stage → generate pipeline.

## Easiest way to run it

**Mac/Linux:** double-click `run.sh` (or run `bash run.sh` in a terminal).
**Windows:** double-click `run.bat`.

First time, it'll install everything automatically, then stop and tell you
to put your Gemini API key into a new `.env` file it creates for you (get a
free key, no card needed, at https://aistudio.google.com). Paste the key in,
save the file, run the script again — it'll start the server and tell you
to open **http://localhost:3000**.

## Doing it manually instead

1. `npm install`
2. `cp .env.example .env`, then open `.env` and paste your key in place of
   `your-key-here`
3. `npm start`
4. Open **http://localhost:3000**

## How it's structured

- `server.js` — the whole backend. Serves the frontend and exposes one
  route, `POST /api/gemini`, which attaches your real key (from `.env`,
  via `process.env.GEMINI_API_KEY`) and forwards the request to Google.
  The key never reaches the browser.
- `public/index.html` — the entire frontend: UI, rendering, and the
  pipeline logic (classification, the interview loop, staging, the
  final generator). It calls `/api/gemini`, a path on its own origin,
  so there's no CORS issue — the browser is just talking to itself.
- Account/credit simulation is stored in your browser's `localStorage`,
  not on the server — it's per-browser, not a real multi-user system.

## What this is — and isn't — ready for

This runs for real, locally, on your machine. It is **not** yet set up
for:
- Letting other people use it over the internet (it only listens on
  your own computer right now)
- Multiple real user accounts (the credit system is a simulated,
  single-browser stand-in for the real schema this project was designed
  around)
- Production security review, rate limiting, or abuse protection

Those are the next steps if you want this to go further than your own
machine — worth tackling deliberately, once the core pipeline itself is
confirmed to be working the way you want.
