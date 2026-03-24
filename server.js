const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHARTEX_BASE = "https://api.chartex.com/external/v1";

// Chartex label_categories=OTHERS already filters UMG/Sony/WMG/BMG/BigIndie
// For remaining sounds, Claude uses its training knowledge to identify signed artists
// Spotify API no longer provides label/followers/genres in Development Mode (Feb 2026 change)
const SIGNED  = "UMG, Universal Music Group, Sony Music, Columbia Records, Atlantic Records, Warner Music, Warner Bros Records, BMG, Interscope, Republic Records, Capitol Records, RCA Records, Island Records, Epic Records, Virgin Music, Parlophone, Polydor, Mercury Records, Def Jam, Cash Money, Young Money, Roc Nation, TDE, Top Dawg Entertainment, Aftermath, Bad Boy Records, Motown, 300 Entertainment, Kobalt, Concord, Secretly Group, Beggars Group, Epitaph, Sub Pop, Merge Records, Ninja Tune, Warp Records, AWAL, Believe, Stem, Amuse (label deals)";
const DISTROS = "DistroKid, TuneCore, CD Baby, Amuse, United Masters, ONErpm, Soundrop, Fresh Tunes";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function cxGet(apiPath, params) {
  const qs  = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(CHARTEX_BASE + apiPath + qs, {
    headers: { "X-APP-ID": process.env.CHARTEX_APP_ID, "X-APP-TOKEN": process.env.CHARTEX_APP_TOKEN },
  });
  if (!res.ok) throw new Error("Chartex " + res.status + " on " + apiPath);
  return res.json();
}

async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error("Claude " + res.status + ": " + JSON.stringify(d));
  return (d.content || []).map(b => b.text || "").join("");
}

function fmt(n) {
  if (n == null) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1) + "K";
  return String(n);
}

app.get("/version", (_, res) => res.json({
  version: "v20-no-spotify",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
}));

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.get("/debug", async (req, res) => {
  try {
    const data = await cxGet("/tiktok-sounds/", { sort_by: "tiktok_last_7_days_video_count", country_codes: "US", limit: 3, page: 1, label_categories: "OTHERS" });
    res.json({ sounds: (data.data && data.data.items) || [] });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID) return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  const limit = Math.min(parseInt((req.body || {}).limit) || 20, 100);
  console.log("[scan] limit=" + limit);

  let sounds;
  try {
    const data = await cxGet("/tiktok-sounds/", { sort_by: "tiktok_last_7_days_video_count", country_codes: "US", limit, page: 1, label_categories: "OTHERS" });
    sounds = (data.data && data.data.items) || [];
    console.log("[scan] " + sounds.length + " sounds");
  } catch (e) { return res.status(502).json({ error: e.message }); }

  const enriched = [];
  for (let i = 0; i < sounds.length; i += 5) {
    const rows = await Promise.all(sounds.slice(i, i + 5).map(async function(s) {
      let inf = null;
      try { inf = await cxGet("/tiktok-sounds/" + s.tiktok_sound_id + "/influencer-statistics/", { limit: 5 }); } catch (e) {}
      return {
        tiktok_sound_id:                s.tiktok_sound_id,
        author_name:                    s.tiktok_sound_creator_name || s.tiktok_sound_creator_username || "",
        title:                          s.tiktok_name_of_sound || "",
        tiktok_last_7_days_video_count: s.tiktok_last_7_days_video_count || 0,
        tiktok_total_video_count:       s.tiktok_total_video_count || 0,
        label_name:                     s.label_name || "",
        artists:                        s.artists || "",
        song_name:                      s.song_name || "",
        tiktok_official_link:           s.tiktok_official_link || "",
        spotify_id:                     s.spotify_id || "",
        total_video_views:              s.total_video_views || 0,
        total_video_likes:              s.total_video_likes || 0,
        top_influencers: inf && inf.data && inf.data.items ? inf.data.items.slice(0, 3) : [],
      };
    }));
    enriched.push(...rows);
  }
  res.json({ sounds: enriched });
});

app.post("/analyze", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const sounds = (req.body || {}).sounds || [];
  if (!sounds.length) return res.json({ results: [] });

  const results = [];
  for (const s of sounds) {
    const inf = s.top_influencers && s.top_influencers.length ? JSON.stringify(s.top_influencers) : "none";
    const label = s.label_name || "";

    const prompt =
      "You are a senior A&R scout at an independent label. Analyze this TikTok-trending sound.\n\n" +
      "TIKTOK DATA:\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited by Chartex: " + (s.artists || "none listed") + "\n" +
      "  Label listed by Chartex: " + (label || "none — not in any major label system") + "\n" +
      "  New TikTok videos this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Total TikTok videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "  Total video views: " + fmt(s.total_video_views) + "\n" +
      "  Total video likes: " + fmt(s.total_video_likes) + "\n" +
      "  Spotify track ID exists: " + (s.spotify_id ? "yes (" + s.spotify_id + ")" : "no — not on Spotify") + "\n" +
      "  Top influencers using this sound: " + inf + "\n\n" +
      "STEP 1 — USE YOUR KNOWLEDGE: You know which artists are signed. DaBaby is on Interscope. Don Toliver is on Cactus Jack/Atlantic. Milky Chance is on Lichtdicht/Geffen. Goo Goo Dolls are on Warner. Use this knowledge alongside the Chartex label field.\n\n" +
      "SIGNING STATUS RULES:\n" +
      "1. If you KNOW this artist is signed to a major or notable indie from your training data → is_unsigned: false\n" +
      "2. If Chartex label field matches a known major/notable indie → is_unsigned: false. Known: " + SIGNED + "\n" +
      "3. If Chartex label is a distributor only → is_unsigned: true. Distributors: " + DISTROS + "\n" +
      "4. If Chartex label is empty/unknown production company AND you don't recognize the artist → is_unsigned: true\n" +
      "5. Not on Spotify → likely unsigned/emerging → is_unsigned: true\n" +
      "6. Uncertain → is_unsigned: true\n\n" +
      "PITCH REQUIREMENTS (only write if is_unsigned: true):\n" +
      "Write 3-4 sentences. Every sentence must contain a specific data point or insight:\n" +
      "  Sentence 1: Exact weekly video count + what the organic velocity at this scale means for market timing\n" +
      "  Sentence 2: Total view/like ratio analysis — what engagement rate signals about audience quality\n" +
      "  Sentence 3: Specific subgenre + why this niche has commercial upside right now\n" +
      "  Sentence 4: The specific window of opportunity — what happens to deal leverage if you wait 3-6 months\n" +
      "BANNED phrases: 'has shown', 'worth monitoring', 'is trending', 'impressive', '[name] is [verb]ing'\n\n" +
      "ALGO NOTES (only if is_unsigned: true):\n" +
      "  Sentence 1: Name 2-3 specific Spotify editorial playlists realistic for this exact subgenre\n" +
      "  Sentence 2: Explain the TikTok-to-Spotify conversion opportunity specific to this genre's listener behavior\n\n" +
      "Reply ONLY with this JSON, no markdown:\n" +
      "{\"is_unsigned\":true,\"label_assessment\":\"exact label found or specific reason unsigned\",\"niche\":\"2-4 specific subgenre tags\",\"pitch\":\"3-4 data-driven sentences\",\"tiktok_momentum\":\"hot or growing or stable or declining\",\"algo_notes\":\"2 specific sentences\"}";

    let analysis;
    try {
      const raw   = await askClaude(prompt);
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON: " + clean.slice(0, 200));
      analysis = JSON.parse(match[0]);
      if (typeof analysis.is_unsigned !== "boolean") throw new Error("is_unsigned not boolean");
    } catch (e) {
      console.error("[analyze] FAILED for " + s.author_name + ": " + e.message);
      analysis = { is_unsigned: null, label_assessment: "Error: " + e.message, niche: "unknown", pitch: "Analysis failed.", tiktok_momentum: "unknown", algo_notes: "Manual review required." };
    }

    console.log("[analyze] " + s.author_name + " | unsigned=" + analysis.is_unsigned + " | chartex_label=" + (label || "none"));

    results.push(Object.assign({}, s, analysis, {
      spotify_link: s.spotify_id ? "https://open.spotify.com/track/" + s.spotify_id : null,
    }));
  }
  res.json({ results: results });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Listening on port " + PORT); });
