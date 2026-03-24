const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BASE    = "https://api.chartex.com/external/v1";
const SIGNED  = "UMG, Sony Music, WMG, Warner, BMG, 300 Entertainment, Kobalt, Concord, Secretly Group, Beggars Group, Epitaph, Sub Pop, Merge, Ninja Tune, Warp, Def Jam, Interscope, Columbia, Atlantic, Republic, Capitol, RCA, Island, Epic, Virgin, Parlophone, Polydor, Cash Money, Roc Nation, TDE, Aftermath, Bad Boy, Motown";
const DISTROS = "DistroKid, TuneCore, CD Baby, Amuse, United Masters, ONErpm, Stem, Soundrop, Fresh Tunes";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function cxGet(apiPath, params) {
  const qs  = params ? "?" + new URLSearchParams(params).toString() : "";
  const url = BASE + apiPath + qs;
  const res = await fetch(url, {
    headers: {
      "X-APP-ID":    process.env.CHARTEX_APP_ID,
      "X-APP-TOKEN": process.env.CHARTEX_APP_TOKEN,
    },
  });
  if (!res.ok) throw new Error("Chartex " + res.status + " on " + apiPath);
  return res.json();
}

async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 900,
      messages:   [{ role: "user", content: prompt }],
    }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error("Claude " + res.status + ": " + JSON.stringify(d));
  return (d.content || []).map(b => b.text || "").join("");
}

function fmt(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// ── /version ──────────────────────────────────────────────────────────────────
app.get("/version", (_, res) => res.json({
  version:           "v6-two-files",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
}));

// ── /health ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── /debug ────────────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  try {
    const list   = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count",
      country_codes: "US", limit: 3, page: 1,
    });
    const sounds = (list.data && list.data.items) || [];
    const first  = sounds[0] || null;
    let meta = null;
    if (first) {
      try { meta = await cxGet("/tiktok-sounds/" + first.tiktok_sound_id + "/metadata/"); } catch (e) { meta = { error: e.message }; }
    }
    res.json({ sound_count: sounds.length, first_sound: first, first_sound_meta: meta });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /scan ─────────────────────────────────────────────────────────────────────
app.post("/scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID) return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  const limit = Math.min(parseInt((req.body || {}).limit) || 20, 100);
  console.log("[scan] limit=" + limit);

  let sounds;
  try {
    const data = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count",
      country_codes: "US", limit: limit, page: 1,
    });
    sounds = (data.data && data.data.items) || [];
    console.log("[scan] " + sounds.length + " sounds");
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const enriched = [];
  for (let i = 0; i < sounds.length; i += 5) {
    const batch = sounds.slice(i, i + 5);
    const rows  = await Promise.all(batch.map(async function(s) {
      const sid = s.tiktok_sound_id;
      let inf = null;
      try { inf = await cxGet("/tiktok-sounds/" + sid + "/influencer-statistics/", { limit: 5 }); } catch (e) {}
      return {
        tiktok_sound_id:                sid,
        author_name:                    s.tiktok_sound_creator_name || s.tiktok_sound_creator_username || "",
        title:                          s.tiktok_name_of_sound || "",
        tiktok_last_7_days_video_count: s.tiktok_last_7_days_video_count || 0,
        tiktok_total_video_count:       s.tiktok_total_video_count || 0,
        label_name:                     s.label_name || "",
        artists:                        s.artists || "",
        song_name:                      s.song_name || "",
        tiktok_official_link:           s.tiktok_official_link || "",
        spotify_id:                     s.spotify_id || "",
        top_influencers: inf && inf.data && inf.data.items
          ? inf.data.items.slice(0, 3)
          : [],
      };
    }));
    enriched.push(...rows);
    console.log("[scan] enriched " + Math.min(i + 5, sounds.length) + "/" + sounds.length);
  }

  res.json({ sounds: enriched });
});

// ── /analyze ──────────────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const sounds = (req.body || {}).sounds || [];
  if (!sounds.length) return res.json({ results: [] });

  const results = [];
  for (const s of sounds) {
    const label   = s.label_name || "";
    const artists = s.artists    || "";
    const inf     = s.top_influencers && s.top_influencers.length
      ? JSON.stringify(s.top_influencers) : "none";

    const prompt =
      "You are an A&R scout finding UNSIGNED artists trending on TikTok.\n\n" +
      "Sound: \"" + s.title + "\"\n" +
      "Creator: " + s.author_name + "\n" +
      "Artists listed: " + (artists || "(none)") + "\n" +
      "Label from Chartex: " + (label || "null — no label data") + "\n" +
      "TikTok videos last 7 days: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "TikTok videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "Top influencers: " + inf + "\n\n" +
      "RULES:\n" +
      "1. label null/empty = is_unsigned true\n" +
      "2. label is a known major label = is_unsigned false. Known: " + SIGNED + "\n" +
      "3. label is a distributor only = is_unsigned true. Distributors: " + DISTROS + "\n" +
      "4. Unknown small production name = is_unsigned true\n" +
      "5. DEFAULT TO TRUE when uncertain\n\n" +
      "Reply ONLY valid JSON, no markdown:\n" +
      "{\"is_unsigned\": true, \"label_assessment\": \"...\", \"niche\": \"...\", \"pitch\": \"...\", \"tiktok_momentum\": \"hot|growing|stable|declining\", \"algo_notes\": \"...\"}";

    let analysis;
    try {
      const raw  = await askClaude(prompt);
      const clean = raw.replace(/```json|```/g, "").trim();
      analysis   = JSON.parse(clean);
    } catch (e) {
      console.error("[analyze] failed for " + s.author_name + ": " + e.message);
      analysis   = {
        is_unsigned:      true,
        label_assessment: "Parse error — review manually",
        niche:            "indie",
        pitch:            s.author_name + "'s track is trending on TikTok.",
        tiktok_momentum:  "growing",
        algo_notes:       "Review manually.",
      };
    }

    console.log("[analyze] " + s.author_name + " → unsigned=" + analysis.is_unsigned + " label=" + (s.label_name || "null"));
    results.push(Object.assign({}, s, analysis));
  }

  res.json({ results: results });
});

// ── Fallback → serve index.html ───────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Listening on " + PORT); });
