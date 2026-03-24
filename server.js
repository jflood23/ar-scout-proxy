const express  = require("express");
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
  version: "v28-stats-debug",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  resend_key_set:    !!process.env.RESEND_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
}));

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Seen artists persistence ──────────────────────────────────────────────────
const fs         = require("fs");
const SEEN_FILE  = "/tmp/ar_seen_artists.json";

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); } catch (e) { return new Set(); }
}
function saveSeen(set) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...set])); } catch (e) { console.error("saveSeen failed:", e.message); }
}

// ── Email sender ──────────────────────────────────────────────────────────────
function buildEmailHtml(artists) {
  const d = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const rows = artists.map(a => `
    <div style="background:#0f0f1a;border:1px solid #1e1e2e;border-radius:8px;padding:24px;margin-bottom:20px;font-family:'Courier New',monospace;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <span style="color:#555;font-size:12px">#${a.rank}</span>
          <h2 style="color:#e8e8f0;margin:4px 0 2px;font-size:18px;">${a.author_name}</h2>
          <div style="color:#888;font-size:13px">"${a.title}"</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
            ${(a.niche||"").split(",").map(n=>`<span style="background:#1a1a2e;color:#aaa;font-size:10px;padding:2px 7px;border-radius:3px">${n.trim()}</span>`).join("")}
          </div>
        </div>
        <div style="text-align:right">
          <div style="color:#c8ff00;font-size:22px;font-weight:700">${fmtN(a.tiktok_last_7_days_video_count)}</div>
          <div style="color:#555;font-size:11px">videos / 7 days</div>
          <div style="margin-top:4px;background:${{"hot":"#ff3d3d","growing":"#c8ff00","stable":"#f0a500","declining":"#555"}[a.tiktok_momentum]||"#555"};color:#000;font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;text-transform:uppercase;display:inline-block">${a.tiktok_momentum||""}</div>
        </div>
      </div>
      <table style="width:100%;margin-top:14px;font-size:12px;border-collapse:collapse;font-family:'Courier New',monospace">
        <tr><td style="color:#555;padding:3px 0;width:160px">All-time TikTok videos</td><td style="color:#bbb">${fmtN(a.tiktok_total_video_count)}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Total views</td><td style="color:#bbb">${fmtN(a.total_video_views)}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Total likes</td><td style="color:#bbb">${fmtN(a.total_video_likes)}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Label status</td><td style="color:#bbb">${a.label_assessment||""}</td></tr>
      </table>
      <div style="margin-top:14px;font-size:12px">
        <div style="color:#c8ff00;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">A&R Pitch</div>
        <div style="color:#ccc;line-height:1.7">${a.pitch||""}</div>
      </div>
      <div style="margin-top:12px;font-size:12px">
        <div style="color:#555;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:5px">Streaming Algo</div>
        <div style="color:#888;font-style:italic;line-height:1.6">${a.algo_notes||""}</div>
      </div>
      <div style="margin-top:14px;font-size:12px">
        ${a.tiktok_official_link ? `<a href="${a.tiktok_official_link}" style="color:#c8ff00;margin-right:12px">↗ TikTok Sound</a>` : ""}
        ${a.spotify_link ? `<a href="${a.spotify_link}" style="color:#1db954">↗ Spotify Track</a>` : ""}
      </div>
    </div>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0f">
  <div style="max-width:680px;margin:0 auto;padding:32px 20px;font-family:'Courier New',monospace;color:#e8e8f0">
    <div style="border-bottom:1px solid #1e1e2e;padding-bottom:20px;margin-bottom:32px">
      <div style="font-size:11px;color:#555;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">A&R Scout — Weekly Report</div>
      <h1 style="color:#c8ff00;margin:0;font-size:24px">🎵 ${artists.length} Unsigned Artists</h1>
      <div style="color:#555;font-size:12px;margin-top:6px">${d} · US TikTok · Under 50K total videos · Unsigned only</div>
    </div>
    ${rows}
    <div style="border-top:1px solid #1e1e2e;padding-top:16px;margin-top:8px;font-size:10px;color:#333;letter-spacing:1px">
      AUTO-GENERATED BY A&R SCOUT — CHARTEX × CLAUDE — EVERY MONDAY
    </div>
  </div>
</body></html>`;
}

function fmtN(n) {
  if (n == null) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1) + "K";
  return String(n);
}

async function sendEmail(artists) {
  const apiKey   = process.env.RESEND_API_KEY;
  const from     = process.env.RESEND_FROM    || "A&R Scout <onboarding@resend.dev>";
  const to       = process.env.RECIPIENT_EMAIL;
  if (!apiKey)   throw new Error("RESEND_API_KEY not set in Render env vars");
  if (!to)       throw new Error("RECIPIENT_EMAIL not set in Render env vars");

  const d = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
  const res = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    from,
      to:      [to],
      subject: "🎵 Weekly A&R Report — " + artists.length + " Unsigned Artists — " + d,
      html:    buildEmailHtml(artists),
    }),
  });
  const d2 = await res.json();
  if (!res.ok) throw new Error("Resend " + res.status + ": " + JSON.stringify(d2));
  console.log("[email] sent via Resend to " + to + " | id=" + d2.id);
}

// ── /send-email ───────────────────────────────────────────────────────────────
app.post("/send-email", async (req, res) => {
  const { artists } = req.body || {};
  if (!artists || !artists.length) return res.status(400).json({ error: "No artists provided" });
  try {
    await sendEmail(artists);
    // Mark all as seen
    const seen = loadSeen();
    artists.forEach(a => { if (a.tiktok_sound_id) seen.add(a.tiktok_sound_id); });
    saveSeen(seen);
    res.json({ ok: true, sent: artists.length, message: "Email sent and artists marked as seen" });
  } catch (e) {
    console.error("[email] FAILED:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /clear-seen ───────────────────────────────────────────────────────────────
app.post("/clear-seen", (req, res) => {
  saveSeen(new Set());
  res.json({ ok: true, message: "Seen artists cleared" });
});

app.get("/debug", async (req, res) => {
  try {
    // Get Still Haven sound ID = 7579661510428428289
    // Call the historical stats endpoint to get true all-time creates
    const statsTotal = await cxGet("/tiktok-sounds/7579661510428428289/stats/tiktok-video-counts/", {
      mode: "total",
    });
    const statsDaily = await cxGet("/tiktok-sounds/7579661510428428289/stats/tiktok-video-counts/", {
      mode: "daily",
      limit_by_latest_days: 7,
    });
    // Also test max_video_count param with different values on the list endpoint
    const testA = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count", country_codes: "US",
      limit: 3, page: 1, label_categories: "OTHERS",
      max_video_count: 50000,
    });
    const testB = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count", country_codes: "US",
      limit: 3, page: 1, label_categories: "OTHERS",
      max_video_count: 1000,
    });
    res.json({
      still_haven_stats_total: statsTotal,
      still_haven_stats_daily_7d: statsDaily,
      list_max_50k_names:  ((testA.data&&testA.data.items)||[]).map(s=>({name:s.tiktok_sound_creator_name,week:s.tiktok_last_7_days_video_count})),
      list_max_1k_names:   ((testB.data&&testB.data.items)||[]).map(s=>({name:s.tiktok_sound_creator_name,week:s.tiktok_last_7_days_video_count})),
    });
  } catch (e) { res.status(502).json({ error: e.message, stack: e.stack&&e.stack.split("\n").slice(0,3) }); }
});

app.post("/scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID) return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  const limit = Math.min(parseInt((req.body || {}).limit) || 20, 100);
  console.log("[scan] limit=" + limit);

  let sounds;
  try {
    // Fetch extra to account for 7-day filter dropping some
    const fetchLimit = Math.min(limit * 2, 100);
    const data = await cxGet("/tiktok-sounds/", {
      sort_by:          "tiktok_last_7_days_video_count",
      country_codes:    "US",
      limit:            fetchLimit,
      page:             1,
      label_categories: "OTHERS",
    });
    const all = (data.data && data.data.items) || [];
    // Keep sounds with 100–5000 new videos/week — emerging but with real traction
    // tiktok_total_video_count from the API is unreliable (doesn't match website)
    // so we filter on 7-day count which is accurate
    sounds = all
      .filter(s => {
        const w = s.tiktok_last_7_days_video_count || 0;
        return w >= 100 && w <= 5000;
      })
      .slice(0, limit);
    console.log("[scan] " + all.length + " fetched → " + sounds.length + " in 100-5000/week range");
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
  // Filter out previously seen artists
  const seen = loadSeen();
  const filtered = enriched.filter(s => !seen.has(s.tiktok_sound_id));
  console.log("[scan] " + enriched.length + " total → " + filtered.length + " after seen filter (" + (enriched.length - filtered.length) + " skipped)");

  res.json({ sounds: filtered });
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
