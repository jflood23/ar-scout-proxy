const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHARTEX_BASE = "https://api.chartex.com/external/v1";

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Chartex helper ────────────────────────────────────────────────────────────
async function cx(path, params = {}) {
  const appId    = process.env.CHARTEX_APP_ID;
  const appToken = process.env.CHARTEX_APP_TOKEN;
  const qs       = new URLSearchParams(params).toString();
  const url      = `${CHARTEX_BASE}${path}${qs ? "?" + qs : ""}`;
  const res      = await fetch(url, {
    headers: { "X-APP-ID": appId, "X-APP-TOKEN": appToken },
  });
  if (!res.ok) throw new Error(`Chartex ${res.status} on ${path}`);
  return res.json();
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Scan endpoint ─────────────────────────────────────────────────────────────
app.post("/scan", async (req, res) => {
  const appId    = process.env.CHARTEX_APP_ID;
  const appToken = process.env.CHARTEX_APP_TOKEN;

  if (!appId || !appToken) {
    return res.status(500).json({
      error: "CHARTEX_APP_ID / CHARTEX_APP_TOKEN env vars not set on server"
    });
  }

  const limit = Math.min(parseInt(req.body?.limit) || 20, 100);
  console.log(`[scan] Starting — limit=${limit}`);

  // 1. Fetch trending sounds
  let sounds;
  try {
    const data = await cx("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count",
      country_codes: "US",
      limit,
      page: 1,
    });
    sounds = data.results || data.data || (Array.isArray(data) ? data : []);
    console.log(`[scan] Got ${sounds.length} sounds`);
  } catch (e) {
    console.error("[scan] Chartex error:", e.message);
    return res.status(502).json({ error: e.message });
  }

  // 2. Enrich in batches of 5
  const enriched = [];
  for (let i = 0; i < sounds.length; i += 5) {
    const batch = sounds.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (s) => {
      const sid = s.tiktok_sound_id || s.id;
      let meta = null, influencers = null;
      try { meta        = await cx(`/tiktok-sounds/${sid}/metadata/`); }        catch {}
      try { influencers = await cx(`/tiktok-sounds/${sid}/influencer-statistics/`, { limit: 5 }); } catch {}
      return {
        tiktok_sound_id:                sid,
        author_name:                    s.author_name  || s.artist_name || s.username || "",
        title:                          s.title        || s.sound_title || s.name     || "",
        tiktok_last_7_days_video_count: s.tiktok_last_7_days_video_count || 0,
        tiktok_total_video_count:       s.tiktok_total_video_count || 0,
        label:             meta?.label || meta?.record_label || s.label || "",
        spotify_track_id:  meta?.spotify_track_id  || s.spotify_track_id  || "",
        spotify_artist_id: meta?.spotify_artist_id || s.spotify_artist_id || "",
        top_influencers:   influencers
          ? (influencers.results || influencers || []).slice(0, 3)
          : [],
      };
    }));
    enriched.push(...results);
    console.log(`[scan] Enriched ${Math.min(i + 5, sounds.length)}/${sounds.length}`);
  }

  console.log(`[scan] Done — ${enriched.length} sounds`);
  res.json({ sounds: enriched });
});

// ── Serve app for any other GET (SPA fallback) ────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
