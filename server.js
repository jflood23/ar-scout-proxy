const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHARTEX_BASE  = "https://api.chartex.com/external/v1";
const SPOTIFY_BASE  = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";

const SIGNED  = "UMG, Universal Music Group, Sony Music, Columbia Records, Atlantic Records, Warner Music, Warner Bros Records, BMG, Interscope, Republic Records, Capitol Records, RCA Records, Island Records, Epic Records, Virgin Music, Parlophone, Polydor, Mercury Records, Def Jam, Cash Money, Young Money, Roc Nation, TDE, Top Dawg Entertainment, Aftermath, Bad Boy Records, Motown, 300 Entertainment, Kobalt, Concord, Secretly Group, Beggars Group, Epitaph, Sub Pop, Merge Records, Ninja Tune, Warp Records";
const DISTROS = "DistroKid, TuneCore, CD Baby, Amuse, United Masters, ONErpm, Stem, Soundrop, Fresh Tunes";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Spotify: Client Credentials token (public catalog data only, no scopes) ──
// Per spec: POST /token with grant_type=client_credentials
// Client Secret stays server-side only, never exposed to browser
let _spotifyToken  = null;
let _spotifyExpiry = 0;

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken;
  const creds = Buffer.from(
    process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
  ).toString("base64");
  const res = await fetch(SPOTIFY_TOKEN, {
    method:  "POST",
    headers: {
      "Authorization": "Basic " + creds,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const d = await res.json();
  if (!res.ok) throw new Error("Spotify auth " + res.status + ": " + (d.error_description || d.error));
  _spotifyToken  = d.access_token;
  _spotifyExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return _spotifyToken;
}

// ── Spotify fetch with 429 retry + exponential backoff ───────────────────────
// Per spec: respect Retry-After header on 429
async function spotifyFetch(endpoint, attempt) {
  attempt = attempt || 1;
  const token = await getSpotifyToken();
  const res   = await fetch(SPOTIFY_BASE + endpoint, {
    headers: { "Authorization": "Bearer " + token },
  });

  if (res.status === 429 && attempt <= 3) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "2");
    const delay      = Math.max(retryAfter * 1000, Math.pow(2, attempt) * 500);
    console.log("[spotify] 429 on " + endpoint + " — retrying in " + delay + "ms");
    await new Promise(r => setTimeout(r, delay));
    return spotifyFetch(endpoint, attempt + 1);
  }

  if (res.status === 401) {
    // Token expired mid-session — clear and retry once
    _spotifyToken = null;
    if (attempt <= 2) return spotifyFetch(endpoint, attempt + 1);
    throw new Error("Spotify 401: token refresh failed");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error("Spotify " + res.status + ": " + (err.error && err.error.message || "unknown"));
  }

  return res.json();
}

// ── Spotify: get track + artist data ─────────────────────────────────────────
// Endpoints used per OpenAPI spec:
//   GET /tracks/{id}   → TrackObject: album.label, album.release_date, album.album_type, popularity, artists[]
//   GET /artists/{id}  → ArtistObject: followers.total, genres[], popularity
//   GET /artists/{id}/top-tracks?market=US → tracks[].name
async function getSpotifyData(trackId) {
  if (!trackId || !process.env.SPOTIFY_CLIENT_ID) return null;
  try {
    // GET /tracks/{id} — per spec, market is optional for public data
    const track = await spotifyFetch("/tracks/" + trackId);

    if (!track || !track.artists || !track.artists.length) return null;

    const primaryArtist = track.artists[0]; // SimplifiedArtistObject from TrackObject

    // GET /artists/{id} — full ArtistObject with followers + genres
    // GET /artists/{id}/top-tracks — requires market per spec
    const [artistFull, topTracksRes] = await Promise.all([
      spotifyFetch("/artists/" + primaryArtist.id),
      spotifyFetch("/artists/" + primaryArtist.id + "/top-tracks?market=US"),
    ]);

    return {
      // From TrackObject
      track_name:      track.name,
      track_popularity: track.popularity,            // integer 0-100
      label:           track.album.label || "",       // label on the album
      release_date:    track.album.release_date || "",
      album_type:      track.album.album_type || "",  // "album" | "single" | "compilation"
      album_name:      track.album.name || "",
      // From ArtistObject
      artist_id:       artistFull.id,
      artist_name:     artistFull.name,
      artist_url:      artistFull.external_urls.spotify,
      followers:       artistFull.followers.total,   // integer
      artist_popularity: artistFull.popularity,      // integer 0-100
      genres:          artistFull.genres || [],       // string[]
      // From top-tracks
      top_track_names: (topTracksRes.tracks || []).slice(0, 3).map(t => t.name),
    };
  } catch (e) {
    console.error("[spotify] getSpotifyData failed for track " + trackId + ": " + e.message);
    return null;
  }
}

// ── Chartex fetch ─────────────────────────────────────────────────────────────
async function cxGet(apiPath, params) {
  const qs  = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(CHARTEX_BASE + apiPath + qs, {
    headers: {
      "X-APP-ID":    process.env.CHARTEX_APP_ID,
      "X-APP-TOKEN": process.env.CHARTEX_APP_TOKEN,
    },
  });
  if (!res.ok) throw new Error("Chartex " + res.status + " on " + apiPath);
  return res.json();
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function askClaude(prompt, attempt) {
  attempt = attempt || 1;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages:   [{ role: "user", content: prompt }],
    }),
  });
  const d = await res.json();
  // Retry on 500/529 (overloaded/server error) with exponential backoff
  if ((res.status === 500 || res.status === 529) && attempt <= 4) {
    const delay = Math.pow(2, attempt) * 1000;
    console.log("[claude] " + res.status + " on attempt " + attempt + " — retrying in " + delay + "ms");
    await new Promise(r => setTimeout(r, delay));
    return askClaude(prompt, attempt + 1);
  }
  if (!res.ok) throw new Error("Claude " + res.status + ": " + JSON.stringify(d));
  return (d.content || []).map(b => b.text || "").join("");
}

function fmt(n) {
  if (n == null || n === "") return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// ── /version ──────────────────────────────────────────────────────────────────
app.get("/version", (_, res) => res.json({
  version:           "v9-retries",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
  spotify_key_set:   !!process.env.SPOTIFY_CLIENT_ID,
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
    res.json({ sound_count: sounds.length, first_sound: sounds[0] || null });
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
    // label_categories=OTHERS filters out UMG/SMG/WMG/BMG/BIG_INDIE at the Chartex level
    // before we spend any Claude credits — first line of defense per API docs
    const data = await cxGet("/tiktok-sounds/", {
      sort_by:          "tiktok_last_7_days_video_count",
      country_codes:    "US",
      limit:            limit,
      page:             1,
      label_categories: "OTHERS",
    });
    sounds = (data.data && data.data.items) || [];
    console.log("[scan] " + sounds.length + " sounds from Chartex");
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
          ? inf.data.items.slice(0, 3) : [],
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
    // Pull Spotify data using spec-compliant endpoints
    const sp = await getSpotifyData(s.spotify_id);

    // Spotify album.label is the most reliable source for label info
    const spotifyLabel   = sp ? sp.label : "";
    const chartexLabel   = s.label_name || "";
    const effectiveLabel = spotifyLabel || chartexLabel || "";
    const followers      = sp ? sp.followers : null;
    const genres         = sp ? sp.genres : [];
    const popularity     = sp ? sp.artist_popularity : null;
    const releaseDate    = sp ? sp.release_date : "";
    const albumType      = sp ? sp.album_type : "";
    const topTracks      = sp ? sp.top_track_names : [];
    const artistUrl      = sp ? sp.artist_url : null;
    const inf            = s.top_influencers && s.top_influencers.length
      ? JSON.stringify(s.top_influencers) : "none";

    const prompt =
      "You are a senior A&R scout. Analyze this TikTok-trending sound.\n\n" +
      "TIKTOK DATA:\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited: " + (s.artists || "none") + "\n" +
      "  Videos created this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "  Top influencers using sound: " + inf + "\n\n" +
      "SPOTIFY DATA (from Spotify API):\n" +
      "  Track: \"" + (sp ? sp.track_name : "not on Spotify") + "\"\n" +
      "  Label on Spotify: " + (effectiveLabel || "none listed") + "\n" +
      "  Artist followers: " + (followers != null ? fmt(followers) : "not on Spotify") + "\n" +
      "  Artist popularity (0-100): " + (popularity != null ? popularity : "n/a") + "\n" +
      "  Track popularity (0-100): " + (sp ? sp.track_popularity : "n/a") + "\n" +
      "  Genres: " + (genres.length ? genres.join(", ") : "none listed") + "\n" +
      "  Release date: " + (releaseDate || "unknown") + "\n" +
      "  Release type: " + (albumType || "unknown") + "\n" +
      "  Other top tracks: " + (topTracks.length ? topTracks.join(", ") : "none") + "\n\n" +
      "SIGNING STATUS RULES:\n" +
      "  Mark is_unsigned FALSE if label matches: " + SIGNED + "\n" +
      "  Mark is_unsigned TRUE if label is a distributor: " + DISTROS + "\n" +
      "  Mark is_unsigned TRUE if label is null/empty or a small unknown production co\n" +
      "  Mark is_unsigned TRUE when uncertain — err toward inclusion\n\n" +
      "PITCH RULES — write specifically, not generically:\n" +
      "  - Reference the actual video count and growth trajectory\n" +
      "  - Reference actual Spotify follower count and what it means for deal leverage\n" +
      "  - Name the specific genre/subgenre and its current market moment\n" +
      "  - Explain why NOW is the right time (early enough to add value, big enough to be real)\n" +
      "  - Do NOT write phrases like 'has shown impressive growth' or 'worth monitoring'\n\n" +
      "ALGO NOTES RULES — be specific:\n" +
      "  - Name actual Spotify playlist targets based on the genre\n" +
      "  - Reference the follower-to-popularity gap if notable (signals algorithmic upside)\n" +
      "  - Mention Release Radar / Discover Weekly eligibility based on release recency\n\n" +
      "Reply ONLY with this JSON, no markdown, no extra text:\n" +
      "{\"is_unsigned\":true,\"label_assessment\":\"exact label or reason unsigned\",\"niche\":\"2-4 specific subgenre tags\",\"pitch\":\"3-4 sentences with real data\",\"tiktok_momentum\":\"hot|growing|stable|declining\",\"algo_notes\":\"specific playlists and algo angles\"}";

    let analysis;
    try {
      const raw   = await askClaude(prompt);
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object in Claude response: " + clean.slice(0, 300));
      analysis = JSON.parse(match[0]);
      if (typeof analysis.is_unsigned !== "boolean") throw new Error("is_unsigned not boolean: " + analysis.is_unsigned);
    } catch (e) {
      console.error("[analyze] " + s.author_name + " FAILED: " + e.message);
      analysis = {
        is_unsigned:      null, // null = skip, don't default signed or unsigned
        label_assessment: "Analysis error — manual review required",
        niche:            genres.join(", ") || "unknown",
        pitch:            "Analysis failed — review manually.",
        tiktok_momentum:  "unknown",
        algo_notes:       "Manual review required.",
      };
    }

    console.log("[analyze] " + s.author_name +
      " | unsigned=" + analysis.is_unsigned +
      " | spotify_label=" + (spotifyLabel || "null") +
      " | chartex_label=" + (chartexLabel || "null") +
      " | followers=" + (followers != null ? fmt(followers) : "n/a"));

    results.push(Object.assign({}, s, analysis, {
      spotify_label:      effectiveLabel,
      spotify_artist_url: artistUrl,
      spotify_followers:  followers != null ? fmt(followers) : null,
      spotify_popularity: popularity,
      spotify_genres:     genres.join(", "),
      spotify_release:    releaseDate,
      spotify_album_type: albumType,
    }));
  }

  res.json({ results: results });
});

// ── Serve UI ──────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Listening on port " + PORT); });
