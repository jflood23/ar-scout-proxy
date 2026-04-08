const express  = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHARTEX_BASE = "https://api.chartex.com/external/v1";
const CM_BASE      = "https://api1.chartmetric.com/api";

// In-memory Chartmetric token cache — resets on process restart
const cmToken = { value: null, expires: 0 };

async function cmAuth() {
  if (cmToken.value && Date.now() < cmToken.expires - 60_000) return cmToken.value;
  const refreshToken = process.env.CHARTMETRIC_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("CHARTMETRIC_REFRESH_TOKEN not set");
  const res = await fetch(CM_BASE + "/token", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ refreshtoken: refreshToken }),
  });
  if (!res.ok) throw new Error("Chartmetric auth " + res.status);
  const d = await res.json();
  cmToken.value   = d.token;
  cmToken.expires = Date.now() + (d.expires_in || 3600) * 1000;
  console.log("[chartmetric] token refreshed, expires in " + Math.round((cmToken.expires - Date.now()) / 1000) + "s");
  return cmToken.value;
}

async function cmGet(apiPath, params) {
  const token = await cmAuth();
  const qs    = params ? "?" + new URLSearchParams(params).toString() : "";
  const res   = await fetch(CM_BASE + apiPath + qs, {
    headers: { "Authorization": "Bearer " + token },
  });
  if (!res.ok) throw new Error("Chartmetric " + res.status + " on " + apiPath);
  return res.json();
}

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

async function askClaude(prompt, attempt) {
  attempt = attempt || 1;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await res.json();
  if ((res.status === 529 || res.status === 500) && attempt <= 4) {
    const wait = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s
    console.log("[claude] 529 overloaded — retrying in " + wait + "ms (attempt " + attempt + ")");
    await new Promise(r => setTimeout(r, wait));
    return askClaude(prompt, attempt + 1);
  }
  if (!res.ok) throw new Error("Claude " + res.status + ": " + JSON.stringify(d));
  return (d.content || []).map(b => b.text || "").join("");
}

// Pre-filter using Chartex label field before spending Claude credits
// Returns: "signed" | "unsigned" | null (needs Claude)
function preFilterLabel(labelName) {
  if (!labelName) return null; // no label data, needs Claude

  const l = labelName.toLowerCase();

  // Known signed labels — return signed immediately
  const signedPatterns = [
    "universal", "umg", "sony", "columbia", "atlantic", "warner", "interscope",
    "republic", "capitol", "rca", "island", "epic", "virgin", "parlophone",
    "polydor", "def jam", "motown", "aftermath", "cash money", "roc nation",
    "tde", "top dawg", "bad boy", "300 entertainment", "kobalt", "concord",
    "ninja tune", "warp", "sub pop", "merge records", "epitaph", "beggars",
    "secretly group", "bighit", "big hit", "hybe", "sm entertainment",
    "jyp", "yg entertainment", "cnco", "geffen", "mca", "emi",
  ];
  if (signedPatterns.some(p => l.includes(p))) return "signed";

  // Known distributors — unsigned
  const distributorPatterns = [
    "distrokid", "tunecore", "cd baby", "cdbaby", "amuse", "united masters",
    "unitedmasters", "onrpm", "stem disintermedia", "soundrop", "fresh tunes",
    "south-atlantic", "south atlantic", "santa anna", "open shift",
    "records dk", // DistroKid auto-generated label names like "9484832 Records DK"
    "exclusively distributed",
  ];
  if (distributorPatterns.some(p => l.includes(p))) return "unsigned";

  return null; // unknown label, needs Claude
}

function fmt(n) {
  if (n == null) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// ── Chartmetric enrichment ────────────────────────────────────────────────────
const CM_DELAY = 500; // ms between Chartmetric calls (rate-limit courtesy)

async function enrichWithChartmetric(artistName) {
  const result = {
    cm_artist_id:              null,
    cm_artist_url:             null,
    spotify_monthly_listeners: null,
    spotify_followers:         null,
    spotify_popularity:        null,
    instagram_followers:       null,
    instagram_engagement:      null,
    youtube_subscribers:       null,
    youtube_views:             null,
    tiktok_cm_followers:       null,
    tiktok_cm_video_views:     null,
    label_from_cm:             null,
    cm_error:                  null,
  };

  try {
    // 1. Search for artist by name
    await new Promise(r => setTimeout(r, CM_DELAY));
    const searchData = await cmGet("/search/artist", { q: artistName, limit: 5 });
    const artists = (searchData.obj && searchData.obj.artists) || searchData.data || [];
    if (!artists.length) {
      result.cm_error = "not found in Chartmetric";
      return result;
    }
    const match = artists[0];
    result.cm_artist_id  = match.id;
    result.cm_artist_url = "https://app.chartmetric.com/artist/" + match.id;

    // 2. Artist profile (label info)
    await new Promise(r => setTimeout(r, CM_DELAY));
    try {
      const profile = await cmGet("/artist/" + match.id);
      const obj = (profile.obj || profile.data || {});
      result.label_from_cm = obj.label || null;
    } catch (e) { console.warn("[cm] profile failed:", e.message); }

    // Stat endpoints return a time-series array in obj; we want the most recent entry.
    // Docs require a `since` date param. We request the last 30 days and take the last element.
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    function latestStat(data) {
      const arr = data.obj || data.data || [];
      if (!Array.isArray(arr) || !arr.length) return {};
      return arr[arr.length - 1] || {};
    }

    // 3. Spotify stats
    await new Promise(r => setTimeout(r, CM_DELAY));
    try {
      const spData = await cmGet("/artist/" + match.id + "/stat/spotify", { since: since30 });
      const sp = latestStat(spData);
      // API returns `listeners` (monthly listeners) and `followers`, `popularity`
      result.spotify_monthly_listeners = sp.listeners  || sp.monthly_listeners || null;
      result.spotify_followers         = sp.followers  || null;
      result.spotify_popularity        = sp.popularity || null;
    } catch (e) { console.warn("[cm] spotify stats failed:", e.message); }

    // 4. Instagram stats
    await new Promise(r => setTimeout(r, CM_DELAY));
    try {
      const igData = await cmGet("/artist/" + match.id + "/stat/instagram", { since: since30 });
      const ig = latestStat(igData);
      result.instagram_followers  = ig.followers       || null;
      result.instagram_engagement = ig.engagement_rate || null;
    } catch (e) { console.warn("[cm] instagram stats failed:", e.message); }

    // 5. YouTube stats — source is "youtube_channel" per API docs
    await new Promise(r => setTimeout(r, CM_DELAY));
    try {
      const ytData = await cmGet("/artist/" + match.id + "/stat/youtube_channel", { since: since30 });
      const yt = latestStat(ytData);
      result.youtube_subscribers = yt.subscribers || null;
      result.youtube_views       = yt.views       || null;
    } catch (e) { console.warn("[cm] youtube stats failed:", e.message); }

    // 6. TikTok stats (from Chartmetric)
    await new Promise(r => setTimeout(r, CM_DELAY));
    try {
      const ttData = await cmGet("/artist/" + match.id + "/stat/tiktok", { since: since30 });
      const tt = latestStat(ttData);
      result.tiktok_cm_followers   = tt.followers   || null;
      result.tiktok_cm_video_views = tt.video_views || null;
    } catch (e) { console.warn("[cm] tiktok stats failed:", e.message); }

  } catch (e) {
    console.error("[cm] enrichWithChartmetric failed for \"" + artistName + "\":", e.message);
    result.cm_error = e.message;
  }

  return result;
}

// ── GET /chartmetric/artist ───────────────────────────────────────────────────
app.get("/chartmetric/artist", async (req, res) => {
  if (!process.env.CHARTMETRIC_REFRESH_TOKEN) return res.status(500).json({ error: "CHARTMETRIC_REFRESH_TOKEN not set" });
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name query param required" });
  try {
    const data = await enrichWithChartmetric(name);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/version", (_, res) => res.json({
  version: "v36-debug",
  anthropic_key_set:    !!process.env.ANTHROPIC_API_KEY,
  resend_key_set:       !!process.env.RESEND_API_KEY,
  chartex_key_set:      !!process.env.CHARTEX_APP_ID,
  chartmetric_key_set:  !!process.env.CHARTMETRIC_REFRESH_TOKEN,
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
        ${a.deep_scan ? `
        <tr><td style="color:#555;padding:3px 0">Spotify listeners/mo</td><td style="color:#bbb">${a.spotify_monthly_listeners != null ? fmtN(a.spotify_monthly_listeners) : "—"}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Spotify followers</td><td style="color:#bbb">${a.spotify_followers != null ? fmtN(a.spotify_followers) : "—"}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Instagram followers</td><td style="color:#bbb">${a.instagram_followers != null ? fmtN(a.instagram_followers) : "—"}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Instagram engagement</td><td style="color:#bbb">${a.instagram_engagement != null ? (a.instagram_engagement * 100).toFixed(2) + "%" : "—"}</td></tr>
        <tr><td style="color:#555;padding:3px 0">YouTube subscribers</td><td style="color:#bbb">${a.youtube_subscribers != null ? fmtN(a.youtube_subscribers) : "—"}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Platform score</td><td style="color:#bbb">${a.platform_score||"—"}</td></tr>
        <tr><td style="color:#555;padding:3px 0">Signing urgency</td><td style="color:${{"immediate":"#ff3d3d","this-quarter":"#f0a500","monitor":"#888"}[a.signing_urgency]||"#888"};font-weight:700">${(a.signing_urgency||"—").toUpperCase()}</td></tr>
        ` : ""}
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
        ${a.spotify_link ? `<a href="${a.spotify_link}" style="color:#1db954;margin-right:12px">↗ Spotify Track</a>` : ""}
        ${a.cm_artist_url ? `<a href="${a.cm_artist_url}" style="color:#00a9ff">↗ Chartmetric Profile</a>` : ""}
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
  // Diagnostic endpoint — shows how many sounds pass each filter stage
  const out = { stages: {}, sounds_sample: [] };
  try {
    const data = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count", country_codes: "US", limit: 20, page: 1, label_categories: "OTHERS"
    });
    const candidates = (data.data && data.data.items) || [];
    out.stages.chartex_returned = candidates.length;

    // Fetch real counts for first 5 only (quick check)
    const sample = candidates.slice(0, 5);
    const withCounts = await Promise.all(sample.map(async function(s) {
      try {
        const stats = await cxGet("/tiktok-sounds/" + s.tiktok_sound_id + "/stats/tiktok-video-counts/", { mode: "total" });
        const realTotal = (stats.data && stats.data.tiktok_total_video_count) || 0;
        return { name: s.tiktok_sound_creator_name, stats_ok: true, real_total: realTotal, list_total: s.tiktok_total_video_count, week: s.tiktok_last_7_days_video_count, label: s.label_name };
      } catch (e) {
        return { name: s.tiktok_sound_creator_name, stats_ok: false, stats_error: e.message, list_total: s.tiktok_total_video_count, week: s.tiktok_last_7_days_video_count, label: s.label_name };
      }
    }));
    out.sounds_sample = withCounts;

    const seen = loadSeen();
    out.stages.seen_count = seen.size;
    out.stages.filter_logic = "stats_ok ? real_total<=50000 : pass_through";
  } catch (e) { out.error = e.message; }
  res.json(out);
});

app.post("/scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID) return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  const limit = Math.min(parseInt((req.body || {}).limit) || 20, 100);
  console.log("[scan] limit=" + limit);

  let sounds;
  try {
    // Fetch 5x to have enough candidates after the 50k filter
    // (most OTHERS sounds have >50k all-time creates, so we need a big pool)
    const fetchLimit = 100; // always fetch max from Chartex
    const data = await cxGet("/tiktok-sounds/", {
      sort_by:          "tiktok_last_7_days_video_count",
      country_codes:    "US",
      limit:            fetchLimit,
      page:             1,
      label_categories: "OTHERS",
    });
    const candidates = (data.data && data.data.items) || [];
    console.log("[scan] " + candidates.length + " candidates from Chartex");

    // For each sound, fetch real all-time creates from stats endpoint
    // (tiktok_total_video_count in the list API is stale/wrong — stats endpoint has the real number)
    const withRealCounts = await Promise.all(candidates.map(async function(s) {
      try {
        const stats = await cxGet("/tiktok-sounds/" + s.tiktok_sound_id + "/stats/tiktok-video-counts/", { mode: "total" });
        const realTotal = (stats.data && stats.data.tiktok_total_video_count) || 0;
        return Object.assign({}, s, { real_total_creates: realTotal });
      } catch (e) {
        return Object.assign({}, s, { real_total_creates: s.tiktok_total_video_count || 0 });
      }
    }));

    // Filter: under 50k all-time creates
    sounds = withRealCounts
      .filter(s => s.real_total_creates > 0 && s.real_total_creates <= 50000)
      .slice(0, limit);

    console.log("[scan] " + sounds.length + " sounds after 50k all-time creates filter");
    sounds.forEach(s => console.log("  [pass] " + s.tiktok_sound_creator_name + " real_total=" + s.real_total_creates + " week=" + s.tiktok_last_7_days_video_count));
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
        tiktok_total_video_count:       s.real_total_creates    || s.tiktok_total_video_count || 0,
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

    // Pre-filter using label field — skip Claude entirely when we can determine status
    const preFilter = preFilterLabel(label);
    if (preFilter === "signed") {
      console.log("[analyze] PRE-FILTER signed: " + s.author_name + " | label=" + label);
      results.push(Object.assign({}, s, { is_unsigned: false, label_assessment: label + " (pre-filtered)", niche: "", pitch: "", tiktok_momentum: "unknown", algo_notes: "", spotify_link: null }));
      continue;
    }
    if (preFilter === "unsigned") {
      console.log("[analyze] PRE-FILTER unsigned: " + s.author_name + " | label=" + label + " (distributor)");
      // Still needs Claude for pitch/niche/algo — fall through to Claude but hint the label status
    }

    const prompt =
      "You are a senior A&R scout at an independent label. Analyze this TikTok-trending sound.\n\n" +
      "TIKTOK DATA:\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited by Chartex: " + (s.artists || "none listed") + "\n" +
      "  Label listed by Chartex: " + (label || "none — not in any major label system") + (preFilter === "unsigned" ? " [DISTRIBUTOR — artist is unsigned]" : "") + "\n" +
      "  New TikTok videos this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Total TikTok videos all time (real): " + fmt(s.tiktok_total_video_count) + "\n" +
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

    // Small delay between Claude calls to avoid 529 overload
    await new Promise(r => setTimeout(r, 1000)); // 1s between calls to avoid 529

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

    // Small delay between calls to avoid 529 overload
    await new Promise(r => setTimeout(r, 1000)); // 1s between calls

    results.push(Object.assign({}, s, analysis, {
      spotify_link: s.spotify_id ? "https://open.spotify.com/track/" + s.spotify_id : null,
    }));
  }
  res.json({ results: results });
});

// ── POST /deep-scan ───────────────────────────────────────────────────────────
// Full server-side pipeline: Chartex scan → Chartmetric enrichment → Claude analysis
app.post("/deep-scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID)             return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  if (!process.env.CHARTMETRIC_REFRESH_TOKEN)  return res.status(500).json({ error: "CHARTMETRIC_REFRESH_TOKEN not set" });
  if (!process.env.ANTHROPIC_API_KEY)          return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const limit = Math.min(parseInt((req.body || {}).limit) || 20, 100);
  console.log("[deep-scan] limit=" + limit);

  // ── Phase 1: Chartex scan (same logic as /scan) ──────────────────────────
  let sounds;
  try {
    const data = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count", country_codes: "US",
      limit: 100, page: 1, label_categories: "OTHERS",
    });
    const candidates = (data.data && data.data.items) || [];
    console.log("[deep-scan] " + candidates.length + " candidates from Chartex");

    const withRealCounts = await Promise.all(candidates.map(async function(s) {
      try {
        const stats = await cxGet("/tiktok-sounds/" + s.tiktok_sound_id + "/stats/tiktok-video-counts/", { mode: "total" });
        const realTotal = (stats.data && stats.data.tiktok_total_video_count) || 0;
        return Object.assign({}, s, { real_total_creates: realTotal });
      } catch (e) {
        return Object.assign({}, s, { real_total_creates: s.tiktok_total_video_count || 0 });
      }
    }));

    sounds = withRealCounts
      .filter(s => s.real_total_creates > 0 && s.real_total_creates <= 50000)
      .slice(0, limit);

    console.log("[deep-scan] " + sounds.length + " sounds after 50k filter");
  } catch (e) { return res.status(502).json({ error: "Chartex: " + e.message }); }

  // Enrich with influencer stats (batched 5 at a time, same as /scan)
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
        tiktok_total_video_count:       s.real_total_creates || s.tiktok_total_video_count || 0,
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

  // Skip previously seen
  const seen = loadSeen();
  const unseen = enriched.filter(s => !seen.has(s.tiktok_sound_id));
  console.log("[deep-scan] " + enriched.length + " total → " + unseen.length + " unseen");

  // ── Phase 2: Chartmetric enrichment (batched 3 at a time) ────────────────
  console.log("[deep-scan] enriching " + unseen.length + " artists with Chartmetric...");
  const cmEnriched = [];
  for (let i = 0; i < unseen.length; i += 3) {
    const batch = await Promise.all(unseen.slice(i, i + 3).map(async function(s) {
      console.log("[deep-scan] cm enriching: " + s.author_name);
      const cm = await enrichWithChartmetric(s.author_name);
      return Object.assign({}, s, cm);
    }));
    cmEnriched.push(...batch);
  }

  // ── Phase 3: Claude analysis with enriched multi-platform prompt ──────────
  console.log("[deep-scan] running Claude analysis on " + cmEnriched.length + " artists...");
  const results = [];

  for (const s of cmEnriched) {
    const inf   = s.top_influencers && s.top_influencers.length ? JSON.stringify(s.top_influencers) : "none";
    const label = s.label_name || "";

    const preFilter = preFilterLabel(label);
    if (preFilter === "signed") {
      console.log("[deep-scan] PRE-FILTER signed: " + s.author_name + " | label=" + label);
      results.push(Object.assign({}, s, {
        is_unsigned: false, label_assessment: label + " (pre-filtered)",
        niche: "", pitch: "", tiktok_momentum: "unknown", algo_notes: "",
        platform_score: null, signing_urgency: null,
        spotify_link: s.spotify_id ? "https://open.spotify.com/track/" + s.spotify_id : null,
      }));
      continue;
    }

    // Build cross-platform data section for prompt
    const cmLines =
      "  Chartmetric Artist URL: " + (s.cm_artist_url || (s.cm_error ? "not found (" + s.cm_error + ")" : "not found")) + "\n" +
      "  Chartmetric label: " + (s.label_from_cm || "none") + "\n" +
      "  Spotify monthly listeners: " + (s.spotify_monthly_listeners != null ? fmt(s.spotify_monthly_listeners) : "n/a") + "\n" +
      "  Spotify followers: " + (s.spotify_followers != null ? fmt(s.spotify_followers) : "n/a") + "\n" +
      "  Spotify popularity score: " + (s.spotify_popularity != null ? s.spotify_popularity + "/100" : "n/a") + "\n" +
      "  Instagram followers: " + (s.instagram_followers != null ? fmt(s.instagram_followers) : "n/a") + "\n" +
      "  Instagram engagement rate: " + (s.instagram_engagement != null ? (s.instagram_engagement * 100).toFixed(2) + "%" : "n/a") + "\n" +
      "  YouTube subscribers: " + (s.youtube_subscribers != null ? fmt(s.youtube_subscribers) : "n/a") + "\n" +
      "  YouTube total views: " + (s.youtube_views != null ? fmt(s.youtube_views) : "n/a") + "\n" +
      "  TikTok followers (Chartmetric): " + (s.tiktok_cm_followers != null ? fmt(s.tiktok_cm_followers) : "n/a");

    const prompt =
      "You are a senior A&R scout at an independent label. Analyze this multi-platform artist data.\n\n" +
      "TIKTOK DATA (Chartex):\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited by Chartex: " + (s.artists || "none listed") + "\n" +
      "  Label listed by Chartex: " + (label || "none") + (preFilter === "unsigned" ? " [DISTRIBUTOR — artist is unsigned]" : "") + "\n" +
      "  New TikTok videos this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Total TikTok videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "  Total video views: " + fmt(s.total_video_views) + "\n" +
      "  Total video likes: " + fmt(s.total_video_likes) + "\n" +
      "  Spotify track ID exists: " + (s.spotify_id ? "yes (" + s.spotify_id + ")" : "no") + "\n" +
      "  Top influencers using sound: " + inf + "\n\n" +
      "CROSS-PLATFORM DATA (Chartmetric):\n" + cmLines + "\n\n" +
      "SIGNING STATUS RULES:\n" +
      "1. If you KNOW this artist is signed to a major or notable indie from your training data → is_unsigned: false\n" +
      "2. Chartex label matches a known major/notable indie → is_unsigned: false. Known: " + SIGNED + "\n" +
      "3. Chartex label is a distributor only → is_unsigned: true. Distributors: " + DISTROS + "\n" +
      "4. Unknown label AND you don't recognize the artist → is_unsigned: true\n" +
      "5. Not on Spotify → likely unsigned → is_unsigned: true\n" +
      "6. Uncertain → is_unsigned: true\n\n" +
      "PLATFORM SCORE (only if is_unsigned: true):\n" +
      "  strong = established cross-platform presence (100K+ on 2+ platforms)\n" +
      "  moderate = growing on 1-2 platforms (10K-100K range)\n" +
      "  emerging = TikTok-first, minimal presence elsewhere (under 10K everywhere else)\n\n" +
      "SIGNING URGENCY (only if is_unsigned: true):\n" +
      "  immediate = trajectory + platform spread signals deal leverage closes in <90 days\n" +
      "  this-quarter = strong signal, act in 1-3 months\n" +
      "  monitor = early, watch for 60-90 days before approaching\n\n" +
      "PITCH REQUIREMENTS (only if is_unsigned: true):\n" +
      "Write 3-4 sentences. Every sentence must contain a specific data point:\n" +
      "  Sentence 1: TikTok weekly velocity + what the organic scale signals for market timing\n" +
      "  Sentence 2: Cross-platform reach — reference at least one Chartmetric stat (Spotify listeners, Instagram followers, etc.)\n" +
      "  Sentence 3: Specific subgenre + why this niche has commercial upside right now\n" +
      "  Sentence 4: The signing window — what happens to deal leverage if you wait 3-6 months\n" +
      "BANNED phrases: 'has shown', 'worth monitoring', 'is trending', 'impressive', '[name] is [verb]ing'\n\n" +
      "ALGO NOTES (only if is_unsigned: true):\n" +
      "  Sentence 1: Name 2-3 specific Spotify editorial playlists realistic for this exact subgenre\n" +
      "  Sentence 2: TikTok-to-Spotify conversion opportunity specific to this genre's listener behavior\n\n" +
      "Reply ONLY with this JSON, no markdown:\n" +
      "{\"is_unsigned\":true,\"label_assessment\":\"exact label or reason unsigned\",\"niche\":\"2-4 specific subgenre tags\",\"pitch\":\"3-4 data-driven sentences\",\"tiktok_momentum\":\"hot or growing or stable or declining\",\"algo_notes\":\"2 specific sentences\",\"platform_score\":\"strong or moderate or emerging\",\"signing_urgency\":\"immediate or this-quarter or monitor\"}";

    await new Promise(r => setTimeout(r, 1000));

    let analysis;
    try {
      const raw   = await askClaude(prompt);
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON: " + clean.slice(0, 200));
      analysis = JSON.parse(match[0]);
      if (typeof analysis.is_unsigned !== "boolean") throw new Error("is_unsigned not boolean");
    } catch (e) {
      console.error("[deep-scan] Claude FAILED for " + s.author_name + ": " + e.message);
      analysis = {
        is_unsigned: null, label_assessment: "Error: " + e.message,
        niche: "unknown", pitch: "Analysis failed.", tiktok_momentum: "unknown",
        algo_notes: "Manual review required.", platform_score: null, signing_urgency: null,
      };
    }

    console.log("[deep-scan] " + s.author_name + " | unsigned=" + analysis.is_unsigned + " | urgency=" + analysis.signing_urgency + " | cm_id=" + (s.cm_artist_id || "n/a"));
    await new Promise(r => setTimeout(r, 1000));

    results.push(Object.assign({}, s, analysis, {
      spotify_link: s.spotify_id ? "https://open.spotify.com/track/" + s.spotify_id : null,
      deep_scan: true,
    }));
  }

  // Return only unsigned artists
  const unsigned = results.filter(a => a.is_unsigned !== false);
  console.log("[deep-scan] done — " + unsigned.length + " unsigned artists found");
  res.json({ artists: unsigned, total_scanned: cmEnriched.length });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Listening on port " + PORT); });
