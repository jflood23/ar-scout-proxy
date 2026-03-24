const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHARTEX_BASE      = "https://api.chartex.com/external/v1";
const SPOTIFY_BASE      = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

const SIGNED  = "UMG, Universal Music Group, Sony Music, Columbia Records, Atlantic Records, Warner Music, Warner Bros Records, BMG, Interscope, Republic Records, Capitol Records, RCA Records, Island Records, Epic Records, Virgin Music, Parlophone, Polydor, Mercury Records, Def Jam, Cash Money, Young Money, Roc Nation, TDE, Top Dawg Entertainment, Aftermath, Bad Boy Records, Motown, 300 Entertainment, Kobalt, Concord, Secretly Group, Beggars Group, Epitaph, Sub Pop, Merge Records, Ninja Tune, Warp Records";
const DISTROS = "DistroKid, TuneCore, CD Baby, Amuse, United Masters, ONErpm, Stem, Soundrop, Fresh Tunes";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Spotify token (Client Credentials) ───────────────────────────────────────
let _spToken = null, _spExpiry = 0;

async function getSpotifyToken() {
  if (_spToken && Date.now() < _spExpiry) return _spToken;
  const creds = Buffer.from(
    process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
  ).toString("base64");
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Authorization": "Basic " + creds, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d = await res.json();
  if (!res.ok) throw new Error("Spotify auth " + res.status + ": " + (d.error_description || d.error));
  _spToken  = d.access_token;
  _spExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return _spToken;
}

async function spFetch(endpoint, attempt) {
  attempt = attempt || 1;
  const token = await getSpotifyToken();
  const res   = await fetch(SPOTIFY_BASE + endpoint, { headers: { "Authorization": "Bearer " + token } });
  if (res.status === 429 && attempt <= 3) {
    const wait = Math.max(parseInt(res.headers.get("Retry-After") || "2") * 1000, Math.pow(2, attempt) * 500);
    await new Promise(r => setTimeout(r, wait));
    return spFetch(endpoint, attempt + 1);
  }
  if (res.status === 401 && attempt <= 2) { _spToken = null; return spFetch(endpoint, attempt + 1); }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error("Spotify " + res.status + " on " + endpoint + ": " + ((e.error && e.error.message) || "unknown"));
  }
  return res.json();
}

// ── Spotify data ──────────────────────────────────────────────────────────────
// Key insight: many emerging/unsigned artists have stripped Spotify profiles
// (no followers/genres/popularity). This is normal — blank data = early stage artist.
// The most reliable data point we can always get is album.label from GET /tracks/{id}.
// We use that as the primary signing signal and treat missing follower/genre data
// as a positive unsigned indicator rather than an error.
async function getSpotifyData(trackId, artistName, trackName) {
  if (!process.env.SPOTIFY_CLIENT_ID) return null;
  try {
    let track = null;
    let label = "";

    // Get track (for album.label — most reliable signing signal)
    if (trackId) {
      try {
        track = await spFetch("/tracks/" + trackId);
        label = (track.album && track.album.label) || "";
      } catch (e) { console.log("[spotify] track fetch failed: " + e.message); }
    }
    // Search for track if no direct ID
    if (!track && artistName && trackName) {
      try {
        const sr = await spFetch("/search?q=" + encodeURIComponent("artist:" + artistName + " track:" + trackName) + "&type=track&limit=1&market=US");
        track = (sr.tracks && sr.tracks.items && sr.tracks.items[0]) || null;
        if (track) label = (track.album && track.album.label) || "";
      } catch (e) { console.log("[spotify] track search failed: " + e.message); }
    }

    // Search for artist — may return full or partial data depending on profile maturity
    let artist = null;
    const nameToSearch = (track && track.artists && track.artists[0] && track.artists[0].name) || artistName;
    if (nameToSearch) {
      try {
        const sr = await spFetch("/search?q=" + encodeURIComponent(nameToSearch) + "&type=artist&limit=1&market=US");
        artist = (sr.artists && sr.artists.items && sr.artists.items[0]) || null;
      } catch (e) { console.log("[spotify] artist search failed: " + e.message); }
    }

    // Extract what we can — all fields may be null for brand new artists
    const followers  = (artist && artist.followers && artist.followers.total != null) ? artist.followers.total : null;
    const genres     = (artist && artist.genres && artist.genres.length) ? artist.genres : [];
    const popularity = (artist && artist.popularity != null) ? artist.popularity : null;
    const artistUrl  = (artist && artist.external_urls && artist.external_urls.spotify) ||
                       (track && track.artists && track.artists[0] && track.artists[0].external_urls && track.artists[0].external_urls.spotify) || null;

    const onSpotify  = !!(track || artist);

    console.log("[spotify] " + nameToSearch +
      " | on_spotify=" + onSpotify +
      " | label=" + (label || "none") +
      " | followers=" + followers +
      " | genres=" + genres.slice(0, 2).join(", ") +
      " | popularity=" + popularity);

    return { label, followers, genres, popularity, artistUrl, onSpotify,
      trackPopularity: track ? track.popularity : null,
      releaseDate: (track && track.album && track.album.release_date) || "",
      albumType:   (track && track.album && track.album.album_type) || "",
    };
  } catch (e) {
    console.error("[spotify] FAILED for " + artistName + ": " + e.message);
    return null;
  }
}

// ── Chartex ───────────────────────────────────────────────────────────────────
async function cxGet(apiPath, params) {
  const qs  = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(CHARTEX_BASE + apiPath + qs, {
    headers: { "X-APP-ID": process.env.CHARTEX_APP_ID, "X-APP-TOKEN": process.env.CHARTEX_APP_TOKEN },
  });
  if (!res.ok) throw new Error("Chartex " + res.status + " on " + apiPath);
  return res.json();
}

// ── Claude ────────────────────────────────────────────────────────────────────
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

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/version", (_, res) => res.json({
  version: "v19-blank-spotify-is-unsigned",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
  spotify_key_set:   !!process.env.SPOTIFY_CLIENT_ID,
}));

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.get("/spotify-test", async (req, res) => {
  // Test three artists: new/unsigned (Still Haven), known signed (DaBaby), known indie (Milky Chance)
  try {
    const [stillHaven, dababy, milkyChance] = await Promise.all([
      getSpotifyData(null, "Still Haven", "Cycle Syncing Frequency"),
      getSpotifyData("0kav2DxndmxlsiT3pqXZjG", "DaBaby", "POP DAT THANG"),
      getSpotifyData(null, "Milky Chance", "Stolen Dance"),
    ]);
    res.json({ still_haven: stillHaven, dababy: dababy, milky_chance: milkyChance });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/debug", async (req, res) => {
  try {
    const list   = await cxGet("/tiktok-sounds/", { sort_by: "tiktok_last_7_days_video_count", country_codes: "US", limit: 3, page: 1, label_categories: "OTHERS" });
    const sounds = (list.data && list.data.items) || [];
    let spotifyTest = null;
    if (sounds[0]) spotifyTest = await getSpotifyData(sounds[0].spotify_id, sounds[0].tiktok_sound_creator_name, sounds[0].tiktok_name_of_sound);
    res.json({ sound_count: sounds.length, first_sound: sounds[0] || null, spotify_test: spotifyTest });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID) return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  const limit = Math.min(parseInt((req.body || {}).limit) || 20, 100);
  console.log("[scan] limit=" + limit);
  let sounds;
  try {
    const data = await cxGet("/tiktok-sounds/", { sort_by: "tiktok_last_7_days_video_count", country_codes: "US", limit, page: 1, label_categories: "OTHERS" });
    sounds = (data.data && data.data.items) || [];
    console.log("[scan] " + sounds.length + " sounds (OTHERS filter)");
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
        tiktok_official_link:           s.tiktok_official_link || "",
        spotify_id:                     s.spotify_id || "",
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
    const sp = await getSpotifyData(s.spotify_id, s.author_name, s.title);

    const spotifyLabel   = sp && sp.label ? sp.label : "";
    const chartexLabel   = s.label_name || "";
    const effectiveLabel = spotifyLabel || chartexLabel || "";
    const followers      = sp ? sp.followers : null;
    const genres         = (sp && sp.genres) || [];
    const popularity     = sp ? sp.popularity : null;
    const trackPop       = sp ? sp.trackPopularity : null;
    const onSpotify      = sp ? sp.onSpotify : false;
    const releaseDate    = (sp && sp.releaseDate) || "";
    const albumType      = (sp && sp.albumType) || "";
    const artistUrl      = (sp && sp.artistUrl) || null;
    const inf            = s.top_influencers && s.top_influencers.length ? JSON.stringify(s.top_influencers) : "none";

    // Build Spotify context string for Claude
    let spotifyContext = "";
    if (!onSpotify) {
      spotifyContext = "NOT ON SPOTIFY — no presence found. This strongly suggests an emerging unsigned artist.";
    } else {
      spotifyContext =
        "Label: " + (effectiveLabel || "none listed") + "\n" +
        "  Followers: " + (followers != null ? fmt(followers) + " followers" : "profile exists but follower count unavailable — very new artist") + "\n" +
        "  Genres: " + (genres.length ? genres.join(", ") : "not yet categorized — emerging artist") + "\n" +
        "  Artist popularity (0-100): " + (popularity != null ? popularity : "not yet scored") + "\n" +
        "  Track popularity (0-100): " + (trackPop != null ? trackPop : "not yet scored") + "\n" +
        "  Release date: " + (releaseDate || "unknown") + "\n" +
        "  Release type: " + (albumType || "unknown");
    }

    const prompt =
      "You are a senior A&R scout at an independent label. Analyze this TikTok-trending sound.\n\n" +
      "TIKTOK:\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited: " + (s.artists || "none listed") + "\n" +
      "  New TikTok videos this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Total TikTok videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "  Top influencers using sound: " + inf + "\n\n" +
      "SPOTIFY:\n  " + spotifyContext + "\n\n" +
      "SIGNING STATUS — apply in order:\n" +
      "1. Label matches a major/notable indie → is_unsigned: false. Signed labels: " + SIGNED + "\n" +
      "2. Label is a distributor only → is_unsigned: true. Distributors: " + DISTROS + "\n" +
      "3. Label null/empty/not found → is_unsigned: true\n" +
      "4. Artist not on Spotify → is_unsigned: true (emerging artist, no deal yet)\n" +
      "5. Small unknown production co → is_unsigned: true\n" +
      "6. Uncertain → is_unsigned: true\n\n" +
      "PITCH — write 3-4 specific sentences:\n" +
      "- Lead with the exact TikTok video count this week and what organic velocity at this scale means\n" +
      "- Address the Spotify situation honestly: if no followers/genres, frame it as pre-breakout upside\n" +
      "- Name the subgenre and its current commercial moment\n" +
      "- State the timing case: why approach now vs waiting\n" +
      "- BANNED: 'has shown', 'worth monitoring', 'is trending', generic filler\n\n" +
      "ALGO NOTES — 2 sentences:\n" +
      "- Name specific realistic Spotify editorial playlists for this genre\n" +
      "- If the artist has no Spotify footprint yet, explain why that's an opportunity (clean slate for algorithmic seeding)\n\n" +
      "Reply ONLY with this JSON, no markdown:\n" +
      "{\"is_unsigned\":true,\"label_assessment\":\"exact label or reason unsigned\",\"niche\":\"2-4 specific subgenre tags\",\"pitch\":\"3-4 sentences\",\"tiktok_momentum\":\"hot or growing or stable or declining\",\"algo_notes\":\"2 sentences\"}";

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
      analysis = { is_unsigned: null, label_assessment: "Error: " + e.message, niche: genres.join(", ") || "unknown", pitch: "Analysis failed.", tiktok_momentum: "unknown", algo_notes: "Manual review required." };
    }

    console.log("[analyze] " + s.author_name + " | unsigned=" + analysis.is_unsigned + " | label=" + (effectiveLabel || "none") + " | on_spotify=" + onSpotify + " | followers=" + (followers != null ? fmt(followers) : "null"));

    results.push(Object.assign({}, s, analysis, {
      spotify_label:      effectiveLabel,
      spotify_artist_url: artistUrl,
      spotify_followers:  followers != null ? fmt(followers) : (onSpotify ? "New artist" : "Not on Spotify"),
      spotify_popularity: popularity,
      spotify_genres:     genres.join(", "),
    }));
  }
  res.json({ results: results });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Listening on port " + PORT); });
