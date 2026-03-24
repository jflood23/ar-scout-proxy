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

// ── Spotify token (Client Credentials — public catalog only, no user scopes) ─
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

// Fetch with 429/Retry-After handling per Spotify spec
async function spFetch(endpoint, attempt) {
  attempt = attempt || 1;
  const token = await getSpotifyToken();
  const res   = await fetch(SPOTIFY_BASE + endpoint, {
    headers: { "Authorization": "Bearer " + token },
  });
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

// ── Spotify data lookup ───────────────────────────────────────────────────────
// NOTE: GET /artists/{id} returns a stripped SimplifiedArtistObject in Spotify
// Development Mode (no followers/genres/popularity). The Search API returns the
// full ArtistObject. We use search results directly to get complete data.
// Label comes from GET /tracks/{id} → album.label which works fine in all modes.
async function getSpotifyData(trackId, artistName, trackName) {
  if (!process.env.SPOTIFY_CLIENT_ID) return null;
  try {
    let track = null;
    let labelFromTrack = "";

    // Step 1: get track for label (direct ID or search)
    if (trackId) {
      try {
        track = await spFetch("/tracks/" + trackId);
        labelFromTrack = (track.album && track.album.label) || "";
      } catch (e) {
        console.log("[spotify] track fetch failed: " + e.message);
      }
    }
    if (!track && artistName && trackName) {
      try {
        const q  = encodeURIComponent("artist:" + artistName + " track:" + trackName);
        const sr = await spFetch("/search?q=" + q + "&type=track&limit=1&market=US");
        track = (sr.tracks && sr.tracks.items && sr.tracks.items[0]) || null;
        if (track) labelFromTrack = (track.album && track.album.label) || "";
      } catch (e) {
        console.log("[spotify] track search failed: " + e.message);
      }
    }

    // Step 2: search for artist to get full object (followers/genres/popularity)
    // Using search because /artists/{id} is stripped in Development Mode
    let artistFromSearch = null;
    const searchName = (track && track.artists && track.artists[0] && track.artists[0].name) || artistName;
    if (searchName) {
      try {
        const q  = encodeURIComponent(searchName);
        const sr = await spFetch("/search?q=" + q + "&type=artist&limit=1&market=US");
        artistFromSearch = (sr.artists && sr.artists.items && sr.artists.items[0]) || null;
      } catch (e) {
        console.log("[spotify] artist search failed: " + e.message);
      }
    }

    const followers   = artistFromSearch && artistFromSearch.followers && artistFromSearch.followers.total != null
      ? artistFromSearch.followers.total : null;
    const genres      = (artistFromSearch && artistFromSearch.genres) || [];
    const popularity  = (artistFromSearch && artistFromSearch.popularity != null) ? artistFromSearch.popularity : null;
    const artistUrl   = (artistFromSearch && artistFromSearch.external_urls && artistFromSearch.external_urls.spotify) ||
                        (track && track.artists && track.artists[0] && track.artists[0].external_urls && track.artists[0].external_urls.spotify) || null;

    console.log("[spotify] " + searchName +
      " | followers=" + followers +
      " | label=" + (labelFromTrack || "none") +
      " | genres=" + genres.slice(0, 2).join(", ") +
      " | popularity=" + popularity);

    return {
      label:             labelFromTrack,
      track_name:        track ? track.name : null,
      track_popularity:  track ? track.popularity : null,
      release_date:      (track && track.album && track.album.release_date) || "",
      album_type:        (track && track.album && track.album.album_type) || "",
      followers:         followers,
      artist_popularity: popularity,
      genres:            genres,
      artist_url:        artistUrl,
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
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
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
  version:           "v18-direct-artist-test",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
  spotify_key_set:   !!process.env.SPOTIFY_CLIENT_ID,
}));

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.get("/spotify-test", async (req, res) => {
  try {
    const token = await getSpotifyToken();
    // Dump raw search response for artist
    const raw = await fetch(SPOTIFY_BASE + "/search?q=Still+Haven&type=artist&limit=1&market=US", {
      headers: { "Authorization": "Bearer " + token }
    });
    const data = await raw.json();
    const artist = data.artists && data.artists.items && data.artists.items[0];
    res.json({
      raw_artist_keys: artist ? Object.keys(artist) : [],
      followers_field: artist ? artist.followers : "missing",
      genres_field:    artist ? artist.genres : "missing",
      popularity:      artist ? artist.popularity : "missing",
      full_artist:     artist || null,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/debug", async (req, res) => {
  try {
    const list   = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count", country_codes: "US",
      limit: 3, page: 1, label_categories: "OTHERS",
    });
    const sounds = (list.data && list.data.items) || [];
    let spotifyTest = null;
    if (sounds[0]) {
      spotifyTest = await getSpotifyData(sounds[0].spotify_id, sounds[0].tiktok_sound_creator_name, sounds[0].tiktok_name_of_sound);
    }
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
    const data = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count",
      country_codes: "US", limit, page: 1,
      label_categories: "OTHERS",
    });
    sounds = (data.data && data.data.items) || [];
    console.log("[scan] " + sounds.length + " sounds (OTHERS filter)");
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

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
    const popularity     = sp ? sp.artist_popularity : null;
    const trackPop       = sp ? sp.track_popularity : null;
    const releaseDate    = (sp && sp.release_date) || "";
    const albumType      = (sp && sp.album_type) || "";
    const artistUrl      = (sp && sp.artist_url) || null;
    const inf            = s.top_influencers && s.top_influencers.length ? JSON.stringify(s.top_influencers) : "none";

    const prompt =
      "You are a senior A&R scout at an independent label. Analyze this TikTok-trending sound and determine if the artist is unsigned and worth pursuing.\n\n" +
      "TIKTOK DATA:\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited: " + (s.artists || "none listed") + "\n" +
      "  New TikTok videos this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Total TikTok videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "  Top influencers using this sound: " + inf + "\n\n" +
      "SPOTIFY DATA:\n" +
      "  Label on Spotify: " + (effectiveLabel || "none found — artist may be unsigned or not on Spotify") + "\n" +
      "  Spotify followers: " + (followers != null ? fmt(followers) : "not found") + "\n" +
      "  Artist popularity (0-100): " + (popularity != null ? popularity : "not found") + "\n" +
      "  Track popularity (0-100): " + (trackPop != null ? trackPop : "not found") + "\n" +
      "  Genres: " + (genres.length ? genres.join(", ") : "not found") + "\n" +
      "  Release date: " + (releaseDate || "unknown") + "\n" +
      "  Release type: " + (albumType || "unknown") + "\n\n" +
      "SIGNING STATUS RULES — apply in order:\n" +
      "1. If label matches a MAJOR or NOTABLE INDIE → is_unsigned: false\n" +
      "   Signed labels: " + SIGNED + "\n" +
      "2. If label is a DISTRIBUTOR ONLY → is_unsigned: true\n" +
      "   Distributors: " + DISTROS + "\n" +
      "3. If label is null/empty/not found → is_unsigned: true\n" +
      "4. If label is a small unknown production company → is_unsigned: true\n" +
      "5. When uncertain → is_unsigned: true\n\n" +
      "PITCH RULES — be specific, not generic:\n" +
      "- Cite the exact weekly video count and what the velocity signals about organic reach\n" +
      "- Reference the Spotify follower count and what it means for deal leverage and upside\n" +
      "- Name the specific subgenre and why it has commercial momentum right now\n" +
      "- State why this is the right moment — early enough to acquire, proven enough to commit\n" +
      "- BANNED phrases: 'has shown impressive growth', 'worth monitoring', 'is trending', '[artist] is [doing thing]'\n\n" +
      "ALGO NOTES RULES:\n" +
      "- Name specific Spotify editorial playlists realistic for this genre (e.g. 'Fresh Finds', 'Lorem', 'Pollen', 'mint', 'bedroom pop')\n" +
      "- Comment on the gap between follower count and popularity score — a high popularity/low follower ratio signals strong algo momentum\n\n" +
      "Reply ONLY with this JSON, no markdown:\n" +
      "{\"is_unsigned\":true,\"label_assessment\":\"exact label or reason unsigned\",\"niche\":\"2-4 specific subgenre tags\",\"pitch\":\"3-4 sentences with real numbers\",\"tiktok_momentum\":\"hot or growing or stable or declining\",\"algo_notes\":\"specific playlists and algo angle\"}";

    let analysis;
    try {
      const raw   = await askClaude(prompt);
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON in response: " + clean.slice(0, 200));
      analysis = JSON.parse(match[0]);
      if (typeof analysis.is_unsigned !== "boolean") throw new Error("is_unsigned not boolean");
    } catch (e) {
      console.error("[analyze] FAILED for " + s.author_name + ": " + e.message);
      analysis = {
        is_unsigned: null,
        label_assessment: "Analysis error: " + e.message,
        niche: genres.join(", ") || "unknown",
        pitch: "Analysis failed — manual review required.",
        tiktok_momentum: "unknown",
        algo_notes: "Manual review required.",
      };
    }

    console.log("[analyze] " + s.author_name +
      " | unsigned=" + analysis.is_unsigned +
      " | label=" + (effectiveLabel || "none") +
      " | followers=" + (followers != null ? fmt(followers) : "null") +
      " | genres=" + genres.slice(0, 2).join(", "));

    results.push(Object.assign({}, s, analysis, {
      spotify_label:      effectiveLabel,
      spotify_artist_url: artistUrl,
      spotify_followers:  followers != null ? fmt(followers) : null,
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
