import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // Required on Render: proxy sets X-Forwarded-For

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Per-IP rate limit on the Gemini proxy — prevents abuse of paid API keys.
// 50 requests per 10 minutes = ~5 full pipeline sessions.
let rateLimitEnabled = true; // toggleable from admin panel without restart

const geminiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes and try again." },
  skip: () => !rateLimitEnabled
});

const APP_VERSION = "v1.25.2";
const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);

// Configurable settings — loaded from DB at startup, updated live when admin saves.
// All timeout values are stored in the DB as seconds; multiplied to ms here.
let monthlyRunLimit        = 20;
let serverQuickTimeoutMs   = 25000;
let serverGenerateTimeoutMs = 100000;
let clientQuickTimeoutMs   = 25000;
let clientGenerateTimeoutMs = 90000;

// Question cap settings — injected into SELECT_QUESTION_SYSTEM at runtime.
let smallCritCap   = 3;  // hard budget pressure kicks in above this for small tasks
let bigCritCap     = 5;  // hard budget pressure kicks in above this for big tasks
let smallEnrichCap = 1;  // max enrichment questions for small tasks
let bigEnrichCap   = 2;  // max enrichment questions for big tasks

// Supabase admin client — uses service role key, never exposed to the browser.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

// ─── Gemini key rotation ───────────────────────────────────────────────────────
// Loads GEMINI_API_KEY, GEMINI_API_KEY_2 … GEMINI_API_KEY_20 — add as many as
// you have in Render environment variables and they'll be picked up automatically.
const API_KEYS = (() => {
  const keys = [];
  for (let i = 1; i <= 20; i++) {
    const k = i === 1 ? process.env.GEMINI_API_KEY : process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
})();

// In-memory key stats — loaded from DB at startup, kept in sync after each call.
let keyStats = API_KEYS.map((_, i) => ({
  key_index: i, enabled: true, daily_limit: 500,
  calls_today: 0, calls_total: 0, error_count_429: 0,
  last_used_at: null, last_429_at: null,
  last_reset_date: new Date().toISOString().slice(0, 10)
}));
let keyIndex = 0;

// ─── Settings cache (avoids a DB round-trip on every Gemini call) ─────────────
let _unrestrictedCache = null, _unrestrictedExpiry = 0;

async function getUnrestrictedMode() {
  if (Date.now() < _unrestrictedExpiry) return _unrestrictedCache;
  if (!supabaseAdmin) { _unrestrictedCache = true; _unrestrictedExpiry = Date.now() + 60000; return true; }
  const { data } = await supabaseAdmin.from("settings").select("value").eq("key", "unrestricted_mode").single();
  _unrestrictedCache = data?.value !== "false";
  _unrestrictedExpiry = Date.now() + 60000;
  return _unrestrictedCache;
}

function applySettingRow(key, value) {
  if (key === "rate_limit_enabled")      rateLimitEnabled         = value !== "false";
  if (key === "monthly_run_limit")       monthlyRunLimit          = Math.max(1, parseInt(value) || 20);
  if (key === "server_quick_timeout")    serverQuickTimeoutMs     = Math.max(5,   parseInt(value) || 25)  * 1000;
  if (key === "server_generate_timeout") serverGenerateTimeoutMs  = Math.max(10,  parseInt(value) || 100) * 1000;
  if (key === "client_quick_timeout")    clientQuickTimeoutMs     = Math.max(5,   parseInt(value) || 25)  * 1000;
  if (key === "client_generate_timeout") clientGenerateTimeoutMs  = Math.max(10,  parseInt(value) || 90)  * 1000;
  if (key === "small_crit_cap")          smallCritCap             = Math.max(1, parseInt(value) || 3);
  if (key === "big_crit_cap")            bigCritCap               = Math.max(1, parseInt(value) || 5);
  if (key === "small_enrich_cap")        smallEnrichCap           = Math.max(0, parseInt(value) || 1);
  if (key === "big_enrich_cap")          bigEnrichCap             = Math.max(0, parseInt(value) || 2);
}

async function loadKeyStats() {
  if (!supabaseAdmin) return;
  const { data } = await supabaseAdmin.from("gemini_keys").select("*").order("key_index");
  if (data && data.length) keyStats = data;
  // Load all settings rows in one query
  const { data: rows } = await supabaseAdmin.from("settings").select("key, value");
  (rows || []).forEach(r => applySettingRow(r.key, r.value));
}

function todayDate() { return new Date().toISOString().slice(0, 10); }

function resetTodayIfNeeded(stat) {
  const today = todayDate();
  if (stat.last_reset_date !== today) {
    stat.calls_today = 0;
    stat.last_reset_date = today;
  }
}

function persistKeyStat(stat) {
  if (!supabaseAdmin) return;
  supabaseAdmin.from("gemini_keys").upsert(stat, { onConflict: "key_index" }).then(() => {});
}

const QUOTA_COOLDOWN_MS = 60_000; // don't retry a key for 60s after a 429
const wait = ms => new Promise(r => setTimeout(r, ms));

async function callWithRotation(model, body) {
  const now = Date.now();
  const isLongRequest = body.generationConfig && body.generationConfig.maxOutputTokens > 2000;
  const keyTimeoutMs = isLongRequest ? serverGenerateTimeoutMs : serverQuickTimeoutMs;

  // Build candidate list — skip disabled, over daily limit, or within 60s cooldown
  // after a 429. Sort by least-recently-used so load spreads across keys naturally.
  let candidates = [];
  for (let i = 0; i < API_KEYS.length; i++) {
    const idx = (keyIndex + i) % API_KEYS.length;
    const stat = keyStats[idx];
    if (!stat) continue;
    resetTodayIfNeeded(stat);
    if (!stat.enabled) continue;
    if (stat.daily_limit > 0 && stat.calls_today >= stat.daily_limit) continue;
    const last429 = stat.last_429_at ? new Date(stat.last_429_at).getTime() : 0;
    if (now - last429 < QUOTA_COOLDOWN_MS) continue;
    candidates.push(idx);
  }

  // Sort coldest-first: key unused longest gets tried first
  const coldness = idx => {
    const t = keyStats[idx]?.last_used_at ? new Date(keyStats[idx].last_used_at).getTime() : 0;
    return t;
  };
  candidates.sort((a, b) => coldness(a) - coldness(b));

  // If every key is on cooldown, fall back to trying them all anyway
  // (avoids total blackout when all keys hit per-minute limits simultaneously)
  if (candidates.length === 0) {
    for (let i = 0; i < API_KEYS.length; i++) {
      const idx = (keyIndex + i) % API_KEYS.length;
      const stat = keyStats[idx];
      if (stat && stat.enabled) candidates.push(idx);
    }
    candidates.sort((a, b) => coldness(a) - coldness(b));
  }

  for (const idx of candidates) {
    const stat = keyStats[idx];
    const key = API_KEYS[idx];
    const keyController = new AbortController();
    const keyTimeoutId = setTimeout(() => keyController.abort(), keyTimeoutMs);

    let upstream, data;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: keyController.signal
        }
      );
      data = await upstream.json();
    } catch(e) {
      clearTimeout(keyTimeoutId);
      keyIndex = (idx + 1) % API_KEYS.length;
      continue;
    }
    clearTimeout(keyTimeoutId);

    const errMsg = (data.error && data.error.message) || "";
    const isQuotaError = upstream.status === 429 ||
      (data.error && (data.error.code === 429 || errMsg.includes("quota")));
    const isCapacityError = upstream.status === 503 ||
      errMsg.includes("high demand") || errMsg.includes("overloaded") || errMsg.includes("temporarily unavailable");

    if (isQuotaError) {
      stat.error_count_429 = (stat.error_count_429 || 0) + 1;
      stat.last_429_at = new Date().toISOString(); // starts 60s cooldown
      persistKeyStat(stat);
      keyIndex = (idx + 1) % API_KEYS.length;
      continue;
    }

    if (isCapacityError) {
      keyIndex = (idx + 1) % API_KEYS.length;
      await wait(300 + Math.random() * 200); // jitter before next key to avoid thundering herd
      continue;
    }

    stat.calls_today = (stat.calls_today || 0) + 1;
    stat.calls_total = (stat.calls_total || 0) + 1;
    stat.last_used_at = new Date().toISOString();
    persistKeyStat(stat);
    keyIndex = idx;
    return { status: upstream.status, data };
  }

  return {
    status: 503,
    data: { error: { message: `All API keys are currently unavailable — the service may be at capacity. Please try again in a moment.` } }
  };
}

// ─── Supabase helpers ──────────────────────────────────────────────────────────
async function verifyUser(req) {
  if (!supabaseAdmin) return null;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (error || !data.user) return null;
  return data.user;
}

async function isAdminUser(userId) {
  if (!supabaseAdmin || !userId) return false;
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();
  return data?.is_admin === true;
}

async function requireAdmin(req, res, next) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const admin = await isAdminUser(user.id);
  if (!admin) return res.status(403).json({ error: "Forbidden — not an admin account" });
  req.adminUser = user;
  next();
}

// ─── Error logging ────────────────────────────────────────────────────────────
app.post("/api/errors", async (req, res) => {
  const user = await verifyUser(req);
  const { session_id, step, error_type, error_message, request_preview, category, destination, complexity } = req.body || {};
  if (!step) return res.status(400).json({ error: "step required" });
  try {
    await supabaseAdmin.from("errors").insert({
      user_id: user?.id || null,
      session_id: session_id || null,
      step, error_type: error_type || "unknown", error_message: error_message || null,
      request_preview: request_preview ? String(request_preview).slice(0, 200) : null,
      category: category || null, destination: destination || null, complexity: complexity || null
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin page route ─────────────────────────────────────────────────────────
app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ─── Public config ─────────────────────────────────────────────────────────────
// Returns the Supabase public keys (safe to expose) and current unrestricted mode.
// The browser fetches this on startup to initialize the Supabase JS client.
app.get("/api/config", async (req, res) => {
  const unrestricted = await getUnrestrictedMode();
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    unrestrictedMode: unrestricted,
    clientQuickTimeout: clientQuickTimeoutMs,
    clientGenerateTimeout: clientGenerateTimeoutMs,
    monthlyRunLimit,
    smallCritCap, bigCritCap, smallEnrichCap, bigEnrichCap
  });
});

// ─── Gemini proxy ──────────────────────────────────────────────────────────────
app.post("/api/gemini", geminiLimiter, async (req, res) => {
  if (API_KEYS.length === 0) {
    return res.status(500).json({ error: { message: "No API keys configured. Add GEMINI_API_KEY to .env and restart." } });
  }

  // Allow unauthenticated calls from localhost (test runner)
  const isLocalhost = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";

  // Enforce limits only when Supabase is connected and unrestricted mode is off.
  if (supabaseAdmin && !isLocalhost) {
    const unrestricted = await getUnrestrictedMode();
    if (!unrestricted) {
      const user = await verifyUser(req);
      if (!user) {
        return res.status(401).json({ error: { message: "Sign in to use Draft & Stamp." } });
      }
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const { count } = await supabaseAdmin
        .from("runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", startOfMonth.toISOString());
      if ((count || 0) >= monthlyRunLimit) {
        return res.status(429).json({
          error: { message: `You've used all ${monthlyRunLimit} free runs this month. Resets on the 1st.` }
        });
      }
    }
  }

  try {
    const { model: requestedModel, ...geminiBody } = req.body;
    const model = (requestedModel && ALLOWED_MODELS.has(requestedModel)) ? requestedModel : DEFAULT_MODEL;
    const { status, data } = await callWithRotation(model, geminiBody);
    res.status(status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── User: own run history ─────────────────────────────────────────────────────
app.get("/api/runs", async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const page = Math.max(0, parseInt(req.query.page || "0"));
  const limit = 12;
  const search = (req.query.q || "").trim();
  try {
    let q = supabaseAdmin
      .from("runs")
      .select("id, created_at, request, destination, category, complexity, generated_prompts", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (search) q = q.ilike("request", "%" + search + "%");
    const { data, count, error } = await q.range(page * limit, (page + 1) * limit - 1);
    if (error) throw error;
    res.json({ runs: data || [], total: count || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Funnel events ─────────────────────────────────────────────────────────────
app.post("/api/funnel", async (req, res) => {
  const user = await verifyUser(req);
  const { session_id, event, category, destination, complexity } = req.body || {};
  if (!session_id || !event) return res.status(400).json({ error: "session_id and event required" });
  try {
    await supabaseAdmin.from("funnel_events").insert({
      user_id: user?.id || null, session_id, event,
      category: category || null, destination: destination || null, complexity: complexity || null
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/funnel", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("funnel_events")
      .select("event, session_id");
    if (error) throw error;
    const counts = {};
    (data || []).forEach(r => {
      if (!counts[r.event]) counts[r.event] = new Set();
      counts[r.event].add(r.session_id);
    });
    const order = ["classified", "interview_started", "interview_complete", "generated"];
    const funnel = order.map(e => ({ event: e, sessions: counts[e] ? counts[e].size : 0 }));
    res.json({ funnel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: stats ──────────────────────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [totalRuns, runsToday, feedbackAvgs, unrestricted] = await Promise.all([
      supabaseAdmin.from("runs").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("runs").select("id", { count: "exact", head: true })
        .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
      supabaseAdmin.from("feedback").select("rating, results_rating"),
      getUnrestrictedMode()
    ]);

    // All remaining queries run in parallel
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const sevenDaysAgo  = new Date(Date.now() - 7  * 86400000).toISOString();
    const [activeUsersRes, allRunsRes, recentRunsRes, recentQARes] = await Promise.all([
      supabaseAdmin.from("runs").select("user_id").gte("created_at", sevenDaysAgo).not("user_id", "is", null),
      supabaseAdmin.from("runs").select("category, destination, complexity"),
      supabaseAdmin.from("runs").select("created_at").gte("created_at", thirtyDaysAgo),
      supabaseAdmin.from("runs").select("qa_pairs, complexity, generated_prompts").order("created_at", { ascending: false }).limit(300)
    ]);

    const uniqueUsers = new Set((activeUsersRes.data || []).map(r => r.user_id)).size;

    const allRuns = allRunsRes.data || [];
    const categoryCounts = {}, destCounts = {}, complexityCounts = { big: 0, small: 0 };
    allRuns.forEach(r => {
      if (r.category) categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
      if (r.destination) destCounts[r.destination] = (destCounts[r.destination] || 0) + 1;
      if (r.complexity) complexityCounts[r.complexity] = (complexityCounts[r.complexity] || 0) + 1;
    });

    // Question count + staging stats from recent 300 runs
    const recentQA = recentQARes.data || [];
    let totalQs = 0, qCount = 0, stagedCount = 0, bigCount = 0;
    recentQA.forEach(r => {
      const pairs = Array.isArray(r.qa_pairs) ? r.qa_pairs.length : 0;
      if (pairs > 0) { totalQs += pairs; qCount++; }
      if (r.complexity === "big") {
        bigCount++;
        const prompts = r.generated_prompts && Array.isArray(r.generated_prompts.prompts) ? r.generated_prompts.prompts.length : 0;
        if (prompts > 1) stagedCount++;
      }
    });
    const avgQuestionsPerRun = qCount ? (totalQs / qCount).toFixed(1) : null;
    const stagedPct = bigCount ? Math.round(stagedCount / bigCount * 100) : null;

    const fbRows = feedbackAvgs.data || [];
    const avgRating = fbRows.length ? (fbRows.reduce((s, r) => s + (r.rating || 0), 0) / fbRows.length).toFixed(1) : null;
    const avgResultsRating = fbRows.length ? (fbRows.reduce((s, r) => s + (r.results_rating || 0), 0) / fbRows.length).toFixed(1) : null;

    const recentRuns = recentRunsRes.data || [];
    const dayMap = {};
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dayMap[d.toISOString().slice(0, 10)] = 0;
    }
    recentRuns.forEach(r => {
      const key = r.created_at.slice(0, 10);
      if (key in dayMap) dayMap[key]++;
    });
    const runsPerDay = Object.entries(dayMap).map(([date, count]) => ({ date, count }));

    res.json({
      totalRuns: totalRuns.count || 0,
      runsToday: runsToday.count || 0,
      activeUsers7d: uniqueUsers,
      avgRating,
      avgResultsRating,
      feedbackCount: fbRows.length,
      categoryCounts,
      destCounts,
      complexityCounts,
      avgQuestionsPerRun,
      stagedPct,
      unrestrictedMode: unrestricted,
      runsPerDay
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: runs feed ──────────────────────────────────────────────────────────
app.get("/api/admin/runs", requireAdmin, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || "0"));
  const limit = 20;
  const { category, destination, date_from, date_to } = req.query;
  try {
    let q = supabaseAdmin
      .from("runs")
      .select("id, created_at, request, destination, category, complexity, mode, user_id", { count: "exact" })
      .order("created_at", { ascending: false });
    if (category) q = q.eq("category", category);
    if (destination) q = q.eq("destination", destination);
    if (date_from) q = q.gte("created_at", date_from + "T00:00:00.000Z");
    if (date_to) q = q.lte("created_at", date_to + "T23:59:59.999Z");
    const { data: runs, count, error } = await q.range(page * limit, (page + 1) * limit - 1);
    if (error) throw error;
    if (runs && runs.length) {
      const userIds = [...new Set(runs.map(r => r.user_id).filter(Boolean))];
      const { data: profiles } = await supabaseAdmin.from("profiles").select("id, email").in("id", userIds);
      const emailMap = Object.fromEntries((profiles || []).map(p => [p.id, p.email]));
      runs.forEach(r => { r.user_email = emailMap[r.user_id] || null; });
    }
    res.json({ runs: runs || [], total: count || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/runs/:id", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("runs")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: users ──────────────────────────────────────────────────────────────
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || "0"));
  const limit = 20;
  try {
    const { data: profiles, count } = await supabaseAdmin
      .from("profiles")
      .select("id, email, is_admin, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);

    const userIds = (profiles || []).map(p => p.id);
    let countMap = {};
    if (userIds.length) {
      const { data: runRows } = await supabaseAdmin
        .from("runs")
        .select("user_id")
        .in("user_id", userIds);
      (runRows || []).forEach(r => { countMap[r.user_id] = (countMap[r.user_id] || 0) + 1; });
    }

    res.json({
      users: (profiles || []).map(p => ({ ...p, runCount: countMap[p.id] || 0 })),
      total: count || 0,
      page,
      limit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: feedback feed ──────────────────────────────────────────────────────
app.get("/api/admin/feedback", requireAdmin, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page || "0"));
  const limit = 20;
  try {
    const { data, count, error } = await supabaseAdmin
      .from("feedback")
      .select("id, created_at, rating, results_rating, comment, run_id, user_id", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);
    if (error) throw error;
    res.json({ feedback: data || [], total: count || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: update settings ────────────────────────────────────────────────────
app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: "key and value required" });
  try {
    const { error } = await supabaseAdmin
      .from("settings")
      .upsert({ key, value: String(value), updated_at: new Date().toISOString() });
    if (error) throw error;
    _unrestrictedExpiry = 0; // invalidate unrestricted cache
    applySettingRow(key, String(value)); // update in-memory values immediately
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: get all app settings ─────────────────────────────────────────────
app.get("/api/admin/app-settings", requireAdmin, (req, res) => {
  res.json({
    client_quick_timeout:    clientQuickTimeoutMs   / 1000,
    client_generate_timeout: clientGenerateTimeoutMs / 1000,
    server_quick_timeout:    serverQuickTimeoutMs   / 1000,
    server_generate_timeout: serverGenerateTimeoutMs / 1000,
    monthly_run_limit:       monthlyRunLimit,
    small_crit_cap:          smallCritCap,
    big_crit_cap:            bigCritCap,
    small_enrich_cap:        smallEnrichCap,
    big_enrich_cap:          bigEnrichCap
  });
});

// ─── Admin: toggle user admin status ──────────────────────────────────────────
app.post("/api/admin/users/:id/toggle-admin", requireAdmin, async (req, res) => {
  try {
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("is_admin")
      .eq("id", req.params.id)
      .single();
    if (!profile) return res.status(404).json({ error: "User not found" });
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ is_admin: !profile.is_admin })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true, is_admin: !profile.is_admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Gemini key stats ───────────────────────────────────────────────────
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  const rows = keyStats.map(stat => {
    const key = API_KEYS[stat.key_index] || "";
    resetTodayIfNeeded(stat);
    return {
      key_index: stat.key_index,
      suffix: key ? "…" + key.slice(-6) : "missing",
      enabled: stat.enabled,
      daily_limit: stat.daily_limit,
      calls_today: stat.calls_today,
      calls_total: stat.calls_total,
      error_count_429: stat.error_count_429,
      last_used_at: stat.last_used_at,
      last_429_at: stat.last_429_at,
    };
  });
  res.json({ keys: rows });
});

app.post("/api/admin/keys/:index", requireAdmin, async (req, res) => {
  const idx = parseInt(req.params.index);
  const stat = keyStats.find(s => s.key_index === idx);
  if (!stat) return res.status(404).json({ error: "Key not found" });
  const { enabled, daily_limit } = req.body;
  if (enabled !== undefined) stat.enabled = Boolean(enabled);
  if (daily_limit !== undefined) stat.daily_limit = Math.max(0, parseInt(daily_limit) || 0);
  persistKeyStat(stat);
  res.json({ ok: true, stat });
});

// ─── Admin: rate limit toggle ─────────────────────────────────────────────────
app.get("/api/admin/rate-limit", requireAdmin, (req, res) => {
  res.json({ enabled: rateLimitEnabled, max: 200, window_minutes: 10 });
});

app.post("/api/admin/rate-limit", requireAdmin, async (req, res) => {
  if (req.body.enabled !== undefined) {
    rateLimitEnabled = Boolean(req.body.enabled);
    if (supabaseAdmin) {
      await supabaseAdmin.from("settings").upsert(
        { key: "rate_limit_enabled", value: rateLimitEnabled ? "true" : "false" },
        { onConflict: "key" }
      );
    }
  }
  res.json({ ok: true, enabled: rateLimitEnabled });
});

// ─── Admin: errors feed ───────────────────────────────────────────────────────
app.get("/api/admin/errors", requireAdmin, async (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page || "0"));
  const limit = 20;
  try {
    const [recentRes, summaryRes] = await Promise.all([
      supabaseAdmin.from("errors")
        .select("id, created_at, step, error_type, error_message, request_preview, category, destination, complexity", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * limit, (page + 1) * limit - 1),
      supabaseAdmin.from("errors").select("step, error_type")
    ]);
    // Build summary counts
    const byStep = {}, byType = {};
    (summaryRes.data || []).forEach(r => {
      byStep[r.step] = (byStep[r.step] || 0) + 1;
      byType[r.error_type] = (byType[r.error_type] || 0) + 1;
    });
    res.json({
      errors: recentRes.data || [],
      total:  recentRes.count || 0,
      page, limit, byStep, byType
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: export runs as CSV ────────────────────────────────────────────────
app.get("/api/admin/export/runs", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("runs")
      .select("id, created_at, user_id, request, destination, category, complexity, stakes, mode")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const cols = ["id", "created_at", "user_id", "request", "destination", "category", "complexity", "stakes", "mode"];
    const csvEsc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = (data || []).map(r => cols.map(c => csvEsc(r[c])).join(","));
    const csv = [cols.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="runs-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Share routes ─────────────────────────────────────────────────────────────
// Public — no auth required. Run IDs are UUIDs (hard to guess).
app.get("/api/share/:id", async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: "DB not configured" });
  try {
    const { data, error } = await supabaseAdmin
      .from("runs")
      .select("id, created_at, request, destination, category, generated_prompts")
      .eq("id", req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA route — serves index.html so /share/:id works as a direct URL
app.get("/share/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
loadKeyStats().then(() => {
  app.listen(PORT, () => {
    console.log(`Draft & Stamp running at http://localhost:${PORT}`);
    console.log(`API keys loaded: ${API_KEYS.length} (rotation active)`);
    console.log(`Supabase: ${supabaseAdmin ? "connected" : "not configured — running without auth/DB"}`);
  });
});
