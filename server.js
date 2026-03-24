const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHARTEX_BASE  = "https://api.chartex.com/external/v1";
const SPOTIFY_BASE  = "https://api.spotify.com/v1";
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

// ── Spotify: Client Credentials (public catalog, no user scopes needed) ──────
let _spToken  = null;
let _spExpiry = 0;

async function getSpotifyToken() {
  if (_spToken && Date.now() < _spExpiry) return _spToken;
  const creds = Buffer.from(
    process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
  ).toString("base64");
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method:  "POST",
    headers: { "Authorization": "Basic " + creds, "Content-Type": "application/x-www-form-urlencoded" },
    body:    "grant_type=client_credentials",
  });
  const d = await res.json();
  if (!res.ok) throw new Error("Spotify auth " + res.status + ": " + (d.error_description || d.error));
  _spToken  = d.access_token;
  _spExpiry = Date.now() + (d.expires_in - 60) * 1000;
  console.log("[spotify] token refreshed");
  return _spToken;
}

// Fetch with 429 backoff per Retry-After header
async function spFetch(endpoint, attempt) {
  attempt = attempt || 1;
  const token = await getSpotifyToken();
  const res   = await fetch(SPOTIFY_BASE + endpoint, {
    headers: { "Authorization": "Bearer " + token },
  });
  if (res.status === 429 && attempt <= 3) {
    const wait = Math.max(parseInt(res.headers.get("Retry-After") || "2") * 1000, Math.pow(2, attempt) * 500);
    console.log("[spotify] 429 — waiting " + wait + "ms before retry " + (attempt + 1));
    await new Promise(r => setTimeout(r, wait));
    return spFetch(endpoint, attempt + 1);
  }
  if (res.status === 401 && attempt <= 2) {
    _spToken = null; // force token refresh
    return spFetch(endpoint, attempt + 1);
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error("Spotify " + res.status + " on " + endpoint + ": " + ((e.error && e.error.message) || "unknown"));
  }
  return res.json();
}

// GET /tracks/{id} → album.label, artists[0].id, popularity, album.release_date
// GET /artists/{id} → followers.total, genres[], popularity
// GET /artists/{id}/top-tracks?market=US → tracks[].name
// If no trackId, fall back to GET /search?q=artist+track&type=track to find it
async function getSpotifyData(trackId, artistName, trackName) {
  if (!process.env.SPOTIFY_CLIENT_ID) {
    console.log("[spotify] SPOTIFY_CLIENT_ID not set — skipping");
    return null;
  }

  try {
    let track = null;

    // Path 1: direct track lookup by Spotify ID
    if (trackId) {
      console.log("[spotify] fetching track " + trackId);
      track = await spFetch("/tracks/" + trackId);
    }

    // Path 2: search if no ID or track fetch failed
    if (!track && artistName && trackName) {
      const q  = encodeURIComponent("artist:" + artistName + " track:" + trackName);
      console.log("[spotify] searching: " + artistName + " — " + trackName);
      const sr = await spFetch("/search?q=" + q + "&type=track&limit=1&market=US");
      track = sr && sr.tracks && sr.tracks.items && sr.tracks.items[0] || null;
      if (track) console.log("[spotify] search found: " + track.name + " by " + (track.artists[0] && track.artists[0].name));
    }

    // Path 3: search by artist name only if track search failed
    if (!track && artistName) {
      const q  = encodeURIComponent(artistName);
      console.log("[spotify] artist-only search: " + artistName);
      const sr = await spFetch("/search?q=" + q + "&type=artist&limit=1&market=US");
      const foundArtist = sr && sr.artists && sr.artists.items && sr.artists.items[0] || null;
      if (foundArtist) {
        console.log("[spotify] artist search found: " + foundArtist.name);
        const [artistFull, topTracksRes] = await Promise.all([
          spFetch("/artists/" + foundArtist.id),
          spFetch("/artists/" + foundArtist.id + "/top-tracks?market=US"),
        ]);
        return {
          track_name:        null,
          track_popularity:  null,
          label:             null, // no track, so no album.label
          release_date:      null,
          album_type:        null,
          album_name:        null,
          artist_id:         artistFull.id,
          artist_name:       artistFull.name,
          artist_url:        artistFull.external_urls && artistFull.external_urls.spotify,
          followers:         artistFull.followers.total,
          artist_popularity: artistFull.popularity,
          genres:            artistFull.genres || [],
          top_track_names:   (topTracksRes.tracks || []).slice(0, 3).map(t => t.name),
        };
      }
    }

    if (!track) {
      console.log("[spotify] no track found for: " + artistName);
      return null;
    }

    if (!track.artists || !track.artists.length) return null;

    const primaryArtist = track.artists[0];
    const [artistFull, topTracksRes] = await Promise.all([
      spFetch("/artists/" + primaryArtist.id),
      spFetch("/artists/" + primaryArtist.id + "/top-tracks?market=US"),
    ]);

    console.log("[spotify] got data for " + artistFull.name +
      " | followers=" + artistFull.followers.total +
      " | label=" + (track.album && track.album.label || "none") +
      " | genres=" + (artistFull.genres || []).slice(0, 2).join(", "));

    return {
      track_name:        track.name,
      track_popularity:  track.popularity,
      label:             (track.album && track.album.label) || "",
      release_date:      (track.album && track.album.release_date) || "",
      album_type:        (track.album && track.album.album_type) || "",
      album_name:        (track.album && track.album.name) || "",
      artist_id:         artistFull.id,
      artist_name:       artistFull.name,
      artist_url:        artistFull.external_urls && artistFull.external_urls.spotify,
      followers:         artistFull.followers.total,
      artist_popularity: artistFull.popularity,
      genres:            artistFull.genres || [],
      top_track_names:   (topTracksRes.tracks || []).slice(0, 3).map(t => t.name),
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
  version:           "v11-spotify-debug",
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  chartex_key_set:   !!process.env.CHARTEX_APP_ID,
  spotify_key_set:   !!process.env.SPOTIFY_CLIENT_ID,
}));

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── /spotify-test — surface exact Spotify auth error ─────────────────────────
app.get("/spotify-test", async (req, res) => {
  try {
    const creds = Buffer.from(
      process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
    ).toString("base64");
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method:  "POST",
      headers: { "Authorization": "Basic " + creds, "Content-Type": "application/x-www-form-urlencoded" },
      body:    "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(200).json({ step: "token_failed", status: tokenRes.status, body: tokenData });
    }
    // Token worked — try a simple artist lookup (Radiohead)
    const artistRes = await fetch("https://api.spotify.com/v1/artists/4Z8W4fKeB5YxbusRsdQVPb", {
      headers: { "Authorization": "Bearer " + tokenData.access_token },
    });
    const artistData = await artistRes.json();
    if (!artistRes.ok) {
      return res.status(200).json({ step: "artist_fetch_failed", status: artistRes.status, body: artistData });
    }
    // Try search
    const searchRes = await fetch("https://api.spotify.com/v1/search?q=Still+Haven&type=artist&limit=1&market=US", {
      headers: { "Authorization": "Bearer " + tokenData.access_token },
    });
    const searchData = await searchRes.json();
    res.json({
      step:         "all_ok",
      token_ok:     true,
      artist_name:  artistData.name,
      artist_followers: artistData.followers && artistData.followers.total,
      search_result: searchData.artists && searchData.artists.items && searchData.artists.items[0] && {
        name:      searchData.artists.items[0].name,
        followers: searchData.artists.items[0].followers && searchData.artists.items[0].followers.total,
        genres:    searchData.artists.items[0].genres,
      },
    });
  } catch (e) {
    res.status(200).json({ step: "exception", error: e.message });
  }
});

// ── /debug ────────────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  try {
    const list   = await cxGet("/tiktok-sounds/", {
      sort_by: "tiktok_last_7_days_video_count", country_codes: "US", limit: 3, page: 1,
    });
    const sounds = (list.data && list.data.items) || [];
    // Also test Spotify
    let spotifyTest = null;
    if (sounds[0] && sounds[0].tiktok_sound_creator_name) {
      spotifyTest = await getSpotifyData(
        sounds[0].spotify_id,
        sounds[0].tiktok_sound_creator_name,
        sounds[0].tiktok_name_of_sound
      );
    }
    res.json({ sound_count: sounds.length, first_sound: sounds[0] || null, spotify_test: spotifyTest });
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
      sort_by:          "tiktok_last_7_days_video_count",
      country_codes:    "US",
      limit:            limit,
      page:             1,
      label_categories: "OTHERS",
    });
    sounds = (data.data && data.data.items) || [];
    console.log("[scan] " + sounds.length + " sounds after OTHERS label filter");
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
        top_influencers: inf && inf.data && inf.data.items ? inf.data.items.slice(0, 3) : [],
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
    // Spotify: try direct ID first, then search by artist+track name
    const sp = await getSpotifyData(s.spotify_id, s.author_name, s.title);

    const spotifyLabel   = sp && sp.label ? sp.label : "";
    const chartexLabel   = s.label_name || "";
    const effectiveLabel = spotifyLabel || chartexLabel || "";
    const followers      = sp ? sp.followers : null;
    const genres         = sp ? sp.genres : [];
    const popularity     = sp ? sp.artist_popularity : null;
    const trackPop       = sp ? sp.track_popularity : null;
    const releaseDate    = sp ? sp.release_date : "";
    const albumType      = sp ? sp.album_type : "";
    const topTracks      = sp ? sp.top_track_names : [];
    const artistUrl      = sp ? sp.artist_url : null;
    const inf            = s.top_influencers && s.top_influencers.length
      ? JSON.stringify(s.top_influencers) : "none";

    const prompt =
      "You are a senior A&R scout at an independent label. Analyze this TikTok-trending sound.\n\n" +
      "TIKTOK DATA:\n" +
      "  Sound: \"" + s.title + "\"\n" +
      "  Creator: " + s.author_name + "\n" +
      "  Artists credited: " + (s.artists || "none") + "\n" +
      "  New videos this week: " + fmt(s.tiktok_last_7_days_video_count) + "\n" +
      "  Total videos all time: " + fmt(s.tiktok_total_video_count) + "\n" +
      "  Top influencers using sound: " + inf + "\n\n" +
      "SPOTIFY DATA:\n" +
      "  Label on Spotify album: " + (effectiveLabel || "NOT FOUND — no Spotify presence or no label listed") + "\n" +
      "  Artist followers: " + (followers != null ? fmt(followers) : "not found on Spotify") + "\n" +
      "  Artist popularity score (0-100): " + (popularity != null ? popularity : "n/a") + "\n" +
      "  Track popularity score (0-100): " + (trackPop != null ? trackPop : "n/a") + "\n" +
      "  Genres: " + (genres.length ? genres.join(", ") : "not found") + "\n" +
      "  Release date: " + (releaseDate || "unknown") + "\n" +
      "  Release type: " + (albumType || "unknown") + "\n" +
      "  Other top tracks: " + (topTracks.length ? topTracks.join(", ") : "none found") + "\n\n" +
      "STEP 1 — SIGNING STATUS:\n" +
      "Set is_unsigned to FALSE if the Spotify label matches any of these:\n" +
      SIGNED + "\n\n" +
      "Set is_unsigned to TRUE if:\n" +
      "- Label is a distributor only (" + DISTROS + ")\n" +
      "- Label is null/empty/not found\n" +
      "- Label is a small unknown production company\n" +
      "- Artist is not on Spotify at all\n" +
      "- When uncertain, default to TRUE\n\n" +
      "STEP 2 — WRITE THE PITCH (only if is_unsigned is true):\n" +
      "Write 3-4 sentences that are specific and data-driven. You must:\n" +
      "- State the exact weekly video count and what the velocity signals\n" +
      "- Reference the Spotify follower count and what it means for deal leverage\n" +
      "- Name the specific subgenre and why it is commercially relevant right now\n" +
      "- Explain why this is the right moment to approach (early but proven)\n" +
      "Do NOT write: 'has shown impressive growth', 'worth monitoring', 'is trending'\n\n" +
      "STEP 3 — ALGO NOTES (only if is_unsigned is true):\n" +
      "Write 2 sentences naming:\n" +
      "- Specific Spotify editorial playlists this artist could realistically land based on their genre\n" +
      "- Whether the follower/popularity gap signals strong algorithmic upside\n\n" +
      "Reply ONLY with this exact JSON, no markdown, no extra text:\n" +
      "{\"is_unsigned\":true,\"label_assessment\":\"exact label name found, or explanation of why unsigned\",\"niche\":\"2-4 specific subgenre tags separated by commas\",\"pitch\":\"your specific data-driven pitch here\",\"tiktok_momentum\":\"hot or growing or stable or declining\",\"algo_notes\":\"your specific playlist and algo notes here\"}";

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
      // null = skip entirely, don't show as unsigned or signed
      analysis = {
        is_unsigned:      null,
        label_assessment: "Analysis failed: " + e.message,
        niche:            genres.join(", ") || "unknown",
        pitch:            "Analysis failed — manual review required.",
        tiktok_momentum:  "unknown",
        algo_notes:       "Manual review required.",
      };
    }

    console.log("[analyze] " + s.author_name +
      " | unsigned=" + analysis.is_unsigned +
      " | spotify_label=" + (spotifyLabel || "null") +
      " | chartex_label=" + (chartexLabel || "null") +
      " | followers=" + (followers != null ? fmt(followers) : "null") +
      " | genres=" + genres.slice(0, 2).join(", "));

    results.push(Object.assign({}, s, analysis, {
      spotify_label:      effectiveLabel,
      spotify_artist_url: artistUrl,
      spotify_followers:  followers != null ? fmt(followers) : null,
      spotify_popularity: popularity,
      spotify_genres:     genres.join(", "),
      spotify_release:    releaseDate,
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
