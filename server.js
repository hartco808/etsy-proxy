import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allow requests from your dashboard (localhost in dev, your domain in prod).
// Update ALLOWED_ORIGIN in .env if you deploy the dashboard to a custom domain.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Apply CORS to every route — must come before all route definitions.
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "x-proxy-secret"],
    optionsSuccessStatus: 200, // some sandboxed environments need 200 not 204
  })
);

// Explicitly handle preflight OPTIONS for all routes
app.options("*", cors());

app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ETSY_BASE = "https://api.etsy.com/v3/application";

// Optional: lock down so only requests carrying the right proxy secret pass
// through. Set PROXY_SECRET in .env and send it as x-proxy-secret header.
const PROXY_SECRET = process.env.PROXY_SECRET || null;

function authMiddleware(req, res, next) {
  if (!PROXY_SECRET) return next();
  const header = req.headers["x-proxy-secret"];
  if (header !== PROXY_SECRET) {
    return res.status(401).json({ error: "Unauthorized proxy request" });
  }
  next();
}

// ─── HEALTH ──────────────────────────────────────────────────────────────────
// Defined after cors() middleware so CORS headers are present on this route too.
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── ETSY PROXY ──────────────────────────────────────────────────────────────
// All Etsy API calls go through /etsy/*
// The dashboard sends:  GET /etsy/listings/active?keywords=...
// The proxy forwards:   GET https://api.etsy.com/v3/application/listings/active?keywords=...
// The Etsy API key is read from the x-api-key header and forwarded transparently.

app.get("/etsy/*", authMiddleware, async (req, res) => {
  const etsyApiKey = req.headers["x-api-key"];

  if (!etsyApiKey) {
    return res.status(400).json({ error: "Missing x-api-key header" });
  }

  // Build the upstream URL: strip the leading /etsy prefix
  const etsyPath = req.path.replace(/^\/etsy/, "");
  const queryString = new URLSearchParams(req.query).toString();
  const upstreamUrl = `${ETSY_BASE}${etsyPath}${queryString ? "?" + queryString : ""}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        "x-api-key": etsyApiKey,
        Accept: "application/json",
      },
    });

    const body = await upstream.json();

    // Forward the exact status code Etsy returned
    res.status(upstream.status).json(body);
  } catch (err) {
    console.error("[proxy error]", err.message);
    res.status(502).json({ error: "Upstream request failed", detail: err.message });
  }
});

// ─── ETSY PING ───────────────────────────────────────────────────────────────
// Convenience endpoint: POST /ping with { apiKey } to test a key without
// exposing it in a query string.
app.post("/ping", authMiddleware, async (req, res) => {
  const apiKey = req.body?.apiKey || req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing apiKey" });

  try {
    const r = await fetch(`${ETSY_BASE}/openapi-ping`, {
      headers: { "x-api-key": apiKey },
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Etsy CORS proxy running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Etsy proxy:   http://localhost:${PORT}/etsy/<path>`);
  if (PROXY_SECRET) {
    console.log(`   🔒  Proxy secret protection: ON`);
  } else {
    console.log(`   ⚠️   No PROXY_SECRET set — proxy is open to any caller`);
  }
  console.log();
});
