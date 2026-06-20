import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);

// All keys are loaded from .env — add more by adding GEMINI_API_KEY_5, etc.
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
].filter(Boolean);

// Tracks which key to try first on the next request. Advances forward
// whenever a key returns a quota error, so the server naturally stays on
// whatever key still has quota without retrying exhausted ones first.
let keyIndex = 0;

async function callWithRotation(model, body) {
  // Try every key once, starting from keyIndex, before giving up.
  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const idx = (keyIndex + attempt) % API_KEYS.length;
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
      // Rotate index forward so next request skips this key immediately
      keyIndex = (idx + 1) % API_KEYS.length;
      continue;
    }

    // Non-quota response (success or a real error) — return it
    keyIndex = idx;
    return { status: upstream.status, data };
  }

  // Every key returned a quota error
  return {
    status: 429,
    data: {
      error: {
        message: `All ${API_KEYS.length} API keys have reached their quota. Please try again later (limits reset daily).`
      }
    }
  };
}

app.post("/api/gemini", async (req, res) => {
  if (API_KEYS.length === 0) {
    return res.status(500).json({
      error: { message: "No API keys found. Add GEMINI_API_KEY to .env and restart." }
    });
  }
  try {
    const { model: requestedModel, ...geminiBody } = req.body;
    const model = (requestedModel && ALLOWED_MODELS.has(requestedModel))
      ? requestedModel
      : DEFAULT_MODEL;

    const { status, data } = await callWithRotation(model, geminiBody);
    res.status(status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Draft & Stamp running at http://localhost:${PORT}`);
  console.log(`API keys loaded: ${API_KEYS.length} (rotation active)`);
});
