import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const APP_VERSION = "v1.19.0";
const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
const MONTHLY_FREE_LIMIT = 20;

// Supabase admin client — uses service role key, never exposed to the browser.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

// ─── Gemini key rotation ───────────────────────────────────────────────────────
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
].filter(Boolean);

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

async function loadKeyStats() {
  if (!supabaseAdmin) return;
  const { data } = await supabaseAdmin.from("gemini_keys").select("*").order("key_index");
  if (data && data.length) keyStats = data;
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

async function callWithRotation(model, body) {
  const today = todayDate();
  // Build ordered list of candidate indices starting from keyIndex
  const candidates = [];
  for (let i = 0; i < API_KEYS.length; i++) {
    candidates.push((keyIndex + i) % API_KEYS.length);
  }

  for (const idx of candidates) {
    const stat = keyStats[idx];
    if (!stat) continue;
    resetTodayIfNeeded(stat);
    // Skip disabled or over daily limit (0 = unlimited)
    if (!stat.enabled) continue;
    if (stat.daily_limit > 0 && stat.calls_today >= stat.daily_limit) continue;

    const key = API_KEYS[idx];
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body)
      }
    );

    const data = await upstream.json();
    const isQuotaError = upstream.status === 429 ||
      (data.error && (data.error.code === 429 || (data.error.message || "").includes("quota")));

    if (isQuotaError) {
      stat.error_count_429 = (stat.error_count_429 || 0) + 1;
      stat.last_429_at = new Date().toISOString();
      persistKeyStat(stat);
      keyIndex = (idx + 1) % API_KEYS.length;
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
    status: 429,
    data: { error: { message: `All API keys are unavailable (disabled or at their daily limit).` } }
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
    unrestrictedMode: unrestricted
  });
});

// ─── Gemini proxy ──────────────────────────────────────────────────────────────
app.post("/api/gemini", async (req, res) => {
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
      if ((count || 0) >= MONTHLY_FREE_LIMIT) {
        return res.status(429).json({
          error: { message: `You've used all ${MONTHLY_FREE_LIMIT} free runs this month. Resets on the 1st.` }
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
    _unrestrictedExpiry = 0; // invalidate cache so next request re-reads from DB
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
