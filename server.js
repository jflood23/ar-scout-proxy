const express = require("express");
const app = express();
app.use(express.json());

const BASE = "https://api.chartex.com/external/v1";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function headers() {
  return { "X-APP-ID": process.env.CHARTEX_APP_ID, "X-APP-TOKEN": process.env.CHARTEX_APP_TOKEN };
}

async function cxGet(path, params) {
  const qs  = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(BASE + path + qs, { headers: headers() });
  if (!res.ok) throw new Error("Chartex " + res.status + " on " + path);
  return res.json();
}

// ── /health ───────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));
app.get("/version", (_, res) => res.json({ version: "v5-all-server-side", anthropic_key_set: !!process.env.ANTHROPIC_API_KEY, chartex_key_set: !!process.env.CHARTEX_APP_ID }));

// ── /debug  — paste response here to diagnose field names ────────────────────
app.get("/debug", async (req, res) => {
  try {
    const list   = await cxGet("/tiktok-sounds/", { sort_by:"tiktok_last_7_days_video_count", country_codes:"US", limit:3, page:1 });
    const sounds = (list.data && list.data.items) || list.results || (Array.isArray(list) ? list : []);
    const first  = sounds[0] || null;
    let meta = null;
    if (first) {
      const sid = first.tiktok_sound_id || first.id;
      try { meta = await cxGet("/tiktok-sounds/" + sid + "/metadata/"); } catch(e) { meta = { error: e.message }; }
    }
    res.json({
      top_level_keys:    Object.keys(list),
      sound_count:       sounds.length,
      first_sound_keys:  first ? Object.keys(first) : [],
      first_sound:       first,
      first_sound_meta:  meta,
    });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── /scan ─────────────────────────────────────────────────────────────────────
app.post("/scan", async (req, res) => {
  if (!process.env.CHARTEX_APP_ID) return res.status(500).json({ error: "CHARTEX_APP_ID not set" });
  const limit = Math.min(parseInt(req.body && req.body.limit) || 20, 100);
  console.log("[scan] limit=" + limit);

  let sounds;
  try {
    const data = await cxGet("/tiktok-sounds/", { sort_by:"tiktok_last_7_days_video_count", country_codes:"US", limit, page:1 });
    // Real Chartex response shape: { data: { items: [...] } }
    sounds = (data.data && data.data.items) || data.results || (Array.isArray(data) ? data : []);
    console.log("[scan] " + sounds.length + " sounds from Chartex");
  } catch(e) {
    return res.status(502).json({ error: e.message });
  }

  const enriched = [];
  for (let i = 0; i < sounds.length; i += 5) {
    const batch = sounds.slice(i, i + 5);
    const rows  = await Promise.all(batch.map(async function(s) {
      const sid = s.tiktok_sound_id;
      let inf = null;
      try { inf = await cxGet("/tiktok-sounds/" + sid + "/influencer-statistics/", { limit:5 }); } catch(e) {}
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
        top_influencers:                inf ? (inf.data && inf.data.items ? inf.data.items : (inf.results || inf || [])).slice(0,3) : [],
      };
    }));
    enriched.push(...rows);
    console.log("[scan] enriched batch ending at " + Math.min(i+5, sounds.length));
  }

  res.json({ sounds: enriched });
});

// ── App UI (inlined) ──────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A&R Scout</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080810; color: #e0e0f0; font-family: 'Courier New', monospace; font-size: 13px; }
  a { color: #c8ff00; text-decoration: none; }
  a:hover { text-decoration: underline; }

  #app { min-height: 100vh; }

  /* Header */
  .header { background: #0c0c18; border-bottom: 1px solid #1a1a30; padding: 16px 28px;
    display: flex; align-items: center; gap: 12px; }
  .header-title { color: #c8ff00; font-weight: 700; letter-spacing: 3px; font-size: 14px; text-transform: uppercase; }
  .header-sub { color: #333; font-size: 9px; letter-spacing: 1px; }
  .header-actions { margin-left: auto; display: flex; gap: 8px; }

  /* Buttons */
  .btn { border: none; border-radius: 4px; padding: 6px 14px; font-size: 10px;
    font-family: 'Courier New', monospace; font-weight: 700; letter-spacing: 1px;
    cursor: pointer; text-transform: uppercase; }
  .btn-lime  { background: #c8ff00; color: #080810; }
  .btn-dark  { background: #1a1a30; color: #aaa; border: 1px solid #2a2a40; }
  .btn-save  { background: #1a1a30; color: #c8ff00; border: 1px solid #2a2a50; flex: 1; }
  .btn-run   { background: #c8ff00; color: #080810; width: 100%; padding: 13px;
    font-size: 12px; letter-spacing: 2px; margin-top: 0; }

  /* Config */
  .config-wrap { max-width: 520px; margin: 40px auto; padding: 0 20px; }
  .config-box  { background: #0c0c18; border: 1px solid #1a1a30; border-radius: 8px; padding: 34px 30px; }
  .config-head { color: #c8ff00; font-size: 10px; letter-spacing: 2px; margin-bottom: 5px; }
  .config-title { font-size: 19px; font-weight: 700; margin-bottom: 20px; line-height: 1.3; }
  .field { margin-top: 16px; }
  .field label { display: block; font-size: 9px; color: #444; letter-spacing: 1.5px;
    text-transform: uppercase; margin-bottom: 4px; }
  .field input { width: 100%; background: #040409; border: 1px solid #1a1a30;
    border-radius: 4px; padding: 8px 10px; color: #e0e0f0; font-size: 12px;
    font-family: 'Courier New', monospace; outline: none; }
  .field input.narrow { width: 90px; }
  .save-row { display: flex; align-items: center; gap: 10px; margin-top: 20px; }
  .save-ok  { color: #00c48c; font-size: 10px; }
  .divider  { height: 1px; background: #1a1a30; margin: 22px 0; }
  .info-box { margin-top: 14px; background: #060610; border: 1px solid #141428;
    border-radius: 5px; padding: 11px 13px; font-size: 9px; color: #444; line-height: 1.8; }

  /* Running */
  .run-wrap { max-width: 680px; margin: 32px auto; padding: 0 20px; }
  .demo-banner { background: #130d00; border: 1px solid #2e1f00; border-radius: 6px;
    padding: 10px 14px; margin-bottom: 18px; font-size: 10px; color: #c8800a; line-height: 1.8; }
  .progress-bar-wrap { margin-bottom: 18px; }
  .progress-info { display: flex; justify-content: space-between; font-size: 10px;
    color: #555; margin-bottom: 5px; }
  .progress-phase { color: #c8ff00; letter-spacing: 1px; }
  .progress-track { height: 2px; background: #1a1a30; border-radius: 2px; }
  .progress-fill  { height: 100%; background: #c8ff00; border-radius: 2px; transition: width 0.25s; }
  .found-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 14px; }
  .chip { background: #091409; border: 1px solid #162816; color: #00c48c;
    font-size: 9px; padding: 2px 7px; border-radius: 3px; }
  .log-box { background: #040409; border: 1px solid #1a1a30; border-radius: 6px;
    padding: 14px 16px; height: 340px; overflow-y: auto; font-size: 10px; line-height: 2.1; }
  .log-success { color: #c8ff00; }
  .log-warn    { color: #c8800a; }
  .log-error   { color: #ff4444; }
  .log-muted   { color: #886600; }
  .log-info    { color: #555; }

  /* Results */
  .results-wrap { max-width: 840px; margin: 26px auto; padding: 0 20px; }
  .results-header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .results-count  { color: #c8ff00; font-size: 10px; letter-spacing: 2px; }
  .results-line   { flex: 1; height: 1px; background: #1a1a30; }
  .results-date   { font-size: 9px; color: #333; }
  .artist-list    { display: flex; flex-direction: column; gap: 8px; }

  .artist-card { border-radius: 5px; overflow: hidden; }
  .artist-row  { padding: 11px 16px; display: flex; align-items: center; gap: 11px;
    cursor: pointer; user-select: none; }
  .artist-rank  { color: #2a2a2a; width: 20px; text-align: right; font-size: 10px; }
  .artist-name  { font-weight: 700; }
  .artist-track { color: #444; font-size: 10px; margin-top: 1px; }
  .artist-meta  { flex: 1; }
  .niche-tags   { display: flex; gap: 3px; flex-wrap: wrap; }
  .niche-tag    { background: #111122; color: #666; font-size: 8px; padding: 2px 5px; border-radius: 2px; }
  .artist-v7d   { text-align: right; min-width: 68px; }
  .v7d-num      { color: #c8ff00; font-weight: 700; font-size: 13px; }
  .v7d-label    { color: #333; font-size: 8px; }
  .momentum-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .chevron      { color: #333; font-size: 10px; }

  .artist-detail { padding: 2px 16px 16px; border-top: 1px solid #111122; display: none; }
  .artist-detail.open { display: block; }
  .detail-grid  { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 14px; }
  .section-label { font-size: 8px; color: #333; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 7px; }
  .data-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #0d0d1c; }
  .data-label { font-size: 9px; color: #444; }
  .data-value { font-size: 10px; color: #999; max-width: 55%; text-align: right; }
  .data-value.accent { color: #c8ff00; font-weight: 700; }
  .data-value.small  { font-size: 8px; }
  .ext-links { margin-top: 12px; display: flex; flex-direction: column; gap: 4px; }
  .ext-link  { color: #c8ff00; font-size: 9px; letter-spacing: 0.5px; }
  .pitch-text { color: #bbb; font-size: 11px; line-height: 1.75; margin: 0 0 12px; }
  .algo-text  { color: #666; font-size: 10px; line-height: 1.65; font-style: italic; }

  /* Email */
  .email-wrap  { max-width: 720px; margin: 26px auto; padding: 0 20px; }
  .email-label { font-size: 10px; color: #c8ff00; letter-spacing: 2px; margin-bottom: 12px; }
  .email-body  { background: #040409; border: 1px solid #1a1a30; border-radius: 6px;
    padding: 20px 22px; font-size: 11px; line-height: 2.1; white-space: pre-wrap;
    color: #999; max-height: 72vh; overflow-y: auto; }

  .footer { padding: 16px 28px; border-top: 1px solid #0c0c18; margin-top: 48px;
    font-size: 9px; color: #1a1a1a; letter-spacing: 1px; }
</style>
</head>
<body>
<div id="app">

  <!-- HEADER -->
  <div class="header">
    <span style="font-size:20px">🎵</span>
    <div>
      <div class="header-title">A&R Scout</div>
      <div class="header-sub">UNSIGNED ARTIST DISCOVERY — CHARTEX × CLAUDE</div>
    </div>
    <div class="header-actions" id="header-actions"></div>
  </div>

  <!-- VIEWS -->
  <div id="view-config"></div>
  <div id="view-running" style="display:none"></div>
  <div id="view-results" style="display:none"></div>
  <div id="view-email"   style="display:none"></div>

  <div class="footer">A&R SCOUT — CHARTEX × CLAUDE — UNSIGNED ARTISTS ONLY — EVERY MONDAY VIA GITHUB ACTIONS</div>
</div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  proxyUrl: localStorage.getItem("ar_proxyUrl") || window.location.origin,
  scanSize: localStorage.getItem("ar_scanSize") || "20",
  artists:  [],
  emailBody: "",
  isDemo:   false,
  expanded: null,
};

const SIGNED  = "UMG, Sony Music, WMG, Warner, BMG, 300 Entertainment, Kobalt, Concord, Secretly Group, Beggars Group, Epitaph, Sub Pop, Merge, Ninja Tune, Warp, Def Jam, Interscope, Columbia, Atlantic, Republic, Capitol, RCA, Island, Epic, Virgin, Parlophone, Polydor, Cash Money, Roc Nation, TDE, Aftermath, Bad Boy, Motown";
const DISTROS = "DistroKid, TuneCore, CD Baby, Amuse, United Masters, ONErpm, Stem, Soundrop, Fresh Tunes";

function fmt(n) {
  if (n == null || n === "") return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mColor = { hot:"#ff3d3d", growing:"#c8ff00", stable:"#f0a500", declining:"#555" };

// ── Views ─────────────────────────────────────────────────────────────────────
function showView(name) {
  ["config","running","results","email"].forEach(v => {
    document.getElementById("view-"+v).style.display = v===name ? "block" : "none";
  });
  renderHeaderActions(name);
}

function renderHeaderActions(step) {
  const el = document.getElementById("header-actions");
  if (step === "results") {
    el.innerHTML = \`
      <button class="btn btn-dark" onclick="showView('config')">← Config</button>
      <button class="btn btn-lime" onclick="showView('email')">📧 Email Preview</button>\`;
  } else if (step === "email") {
    el.innerHTML = \`
      <button class="btn btn-dark" onclick="showView('results')">← Results</button>
      <button class="btn btn-lime" id="copy-btn" onclick="copyEmail()">Copy Email</button>\`;
  } else {
    el.innerHTML = "";
  }
}

// ── Config view ───────────────────────────────────────────────────────────────
function renderConfig() {
  document.getElementById("view-config").innerHTML = \`
    <div class="config-wrap">
      <div class="config-box">
        <div class="config-head">WEEKLY RUN CONFIG</div>
        <div class="config-title">Find Unsigned Artists<br>Trending on US TikTok</div>

        <div class="field">
          <label>Render Proxy URL</label>
          <input id="inp-proxy" type="text" value="\${S.proxyUrl}"
            placeholder="https://ar-scout-proxy.onrender.com" />
          <div style="font-size:9px;color:#444;margin-top:4px;line-height:1.7">
            Pre-filled with this page's origin. Change only if running the proxy elsewhere.
          </div>
        </div>

        <div class="field">
          <label>Sounds to scan (1–100 · 20 = quick test · 100 = full weekly run)</label>
          <input id="inp-scan" type="number" class="narrow" value="\${S.scanSize}" min="1" max="100" />
        </div>

        <div class="save-row">
          <button class="btn btn-save" onclick="saveConfig()">💾 Save</button>
          <span id="save-ok" class="save-ok" style="display:none">✓ Saved</span>
        </div>
        <div class="divider"></div>
        <button class="btn btn-run" onclick="runPipeline()">▶ RUN DISCOVERY PIPELINE</button>

        <div class="info-box">
          <strong style="color:#666">How it works:</strong>
          This app sends one POST to your Render proxy →
          the proxy calls Chartex server-side (no CORS restriction) →
          returns all enriched sound data →
          Claude runs unsigned checks and A&R pitches here in the browser.
        </div>
      </div>
    </div>\`;
}

function saveConfig() {
  S.proxyUrl = document.getElementById("inp-proxy").value.trim();
  S.scanSize = document.getElementById("inp-scan").value;
  localStorage.setItem("ar_proxyUrl", S.proxyUrl);
  localStorage.setItem("ar_scanSize", S.scanSize);
  const ok = document.getElementById("save-ok");
  ok.style.display = "inline";
  setTimeout(() => ok.style.display = "none", 2000);
}

// ── Running view ──────────────────────────────────────────────────────────────
let logEl, progressFill, progressPhase, progressCount, chipsEl;

function renderRunning() {
  document.getElementById("view-running").innerHTML = \`
    <div class="run-wrap">
      <div id="demo-banner" class="demo-banner" style="display:none">
        ⚠️ <strong>Proxy unreachable</strong> — showing demo data so you can verify the pipeline.
        Open your Render URL in a browser tab first to wake the free-tier service, then run again.
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-info">
          <span class="progress-phase" id="prog-phase">Starting…</span>
          <span id="prog-count">0/0</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="prog-fill" style="width:2%"></div></div>
      </div>
      <div class="found-chips" id="found-chips"></div>
      <div class="log-box" id="log-box"></div>
    </div>\`;
  logEl         = document.getElementById("log-box");
  progressFill  = document.getElementById("prog-fill");
  progressPhase = document.getElementById("prog-phase");
  progressCount = document.getElementById("prog-count");
  chipsEl       = document.getElementById("found-chips");
}

function addLog(msg, type="info") {
  const d = document.createElement("div");
  d.className = "log-" + type;
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(done, total, phase) {
  progressPhase.textContent = phase;
  progressCount.textContent = \`\${done}/\${total}\`;
  progressFill.style.width  = total ? \`\${(done/total)*100}%\` : "2%";
}

function addChip(name) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = name;
  chipsEl.appendChild(span);
  if (chipsEl.children.length > 10) chipsEl.removeChild(chipsEl.firstChild);
}

// ── Results view ──────────────────────────────────────────────────────────────
function renderResults() {
  const list = S.artists;
  const date = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});

  let cards = list.map(a => {
    const tags = (a.niche||"").split(",").slice(0,2)
      .map(n=>\`<span class="niche-tag">\${n.trim()}</span>\`).join("");
    const mc = mColor[a.momentum] || "#444";

    let links = "";
    if (a.tiktokUrl)  links += \`<a class="ext-link" href="\${a.tiktokUrl}"  target="_blank">↗ TikTok Sound</a>\`;
    if (a.spTrackUrl) links += \`<a class="ext-link" href="\${a.spTrackUrl}" target="_blank">↗ Spotify Track</a>\`;
    if (a.spArtUrl)   links += \`<a class="ext-link" href="\${a.spArtUrl}"   target="_blank">↗ Spotify Artist</a>\`;

    return \`
    <div class="artist-card" style="background:#07070e;border:1px solid #111122" id="card-\${a.rank}">
      <div class="artist-row" onclick="toggleCard(\${a.rank})">
        <div class="artist-rank">#\${a.rank}</div>
        <div class="artist-meta">
          <div class="artist-name">\${esc(a.artist)}</div>
          <div class="artist-track">"\${esc(a.track)}"</div>
        </div>
        <div class="niche-tags">\${tags}</div>
        <div class="artist-v7d">
          <div class="v7d-num">\${fmt(a.v7d)}</div>
          <div class="v7d-label">7d videos</div>
        </div>
        <div class="momentum-dot" style="background:\${mc}"></div>
        <div class="chevron" id="chev-\${a.rank}">▼</div>
      </div>
      <div class="artist-detail" id="detail-\${a.rank}">
        <div class="detail-grid">
          <div>
            <div class="section-label">Chartex Data</div>
            <div class="data-row"><span class="data-label">7-day videos</span><span class="data-value accent">\${fmt(a.v7d)}</span></div>
            <div class="data-row"><span class="data-label">All-time</span><span class="data-value">\${fmt(a.vTotal)}</span></div>
            <div class="data-row"><span class="data-label">Momentum</span><span class="data-value" style="color:\${mc}">\${(a.momentum||"").toUpperCase()}</span></div>
            <div class="data-row"><span class="data-label">Label status</span><span class="data-value small">\${esc(a.labelAssessment)}</span></div>
            <div class="ext-links">\${links}</div>
          </div>
          <div>
            <div class="section-label">A&R Pitch</div>
            <p class="pitch-text">\${esc(a.pitch)}</p>
            <div class="section-label">Streaming Algo</div>
            <p class="algo-text">\${esc(a.algoNotes)}</p>
          </div>
        </div>
      </div>
    </div>\`;
  }).join("");

  const demoBanner = S.isDemo ? \`
    <div class="demo-banner">
      ⚠️ Demo results — proxy was unreachable. Open your Render URL in a new tab to wake it,
      then run again for real data.
    </div>\` : "";

  document.getElementById("view-results").innerHTML = \`
    <div class="results-wrap">
      \${demoBanner}
      <div class="results-header">
        <div class="results-count">\${list.length} UNSIGNED ARTISTS FOUND</div>
        <div class="results-line"></div>
        <div class="results-date">\${date}</div>
      </div>
      \${list.length===0
        ? \`<div style="text-align:center;padding:60px 0;color:#333">No unsigned artists found.</div>\`
        : \`<div class="artist-list">\${cards}</div>\`}
    </div>\`;
}

function toggleCard(rank) {
  const detail = document.getElementById("detail-"+rank);
  const chev   = document.getElementById("chev-"+rank);
  const card   = document.getElementById("card-"+rank);
  const open   = detail.classList.contains("open");
  detail.classList.toggle("open", !open);
  chev.textContent = open ? "▼" : "▲";
  card.style.background = open ? "#07070e" : "#0b0b1a";
  card.style.border      = open ? "1px solid #111122" : "1px solid #252540";
}

// ── Email view ────────────────────────────────────────────────────────────────
function renderEmail() {
  document.getElementById("view-email").innerHTML = \`
    <div class="email-wrap">
      <div class="email-label">EMAIL DRAFT — SENT AUTOMATICALLY EVERY MONDAY</div>
      <div class="email-body">\${esc(S.emailBody)}</div>
    </div>\`;
}

function copyEmail() {
  navigator.clipboard.writeText(S.emailBody).then(() => {
    const btn = document.getElementById("copy-btn");
    if (btn) { btn.textContent = "Copied!"; setTimeout(()=>btn.textContent="Copy Email", 2000); }
  });
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return (data.content||[]).map(b=>b.text||"").join("");
}

function buildPrompt(s) {
  const inf = s.top_influencers?.length ? JSON.stringify(s.top_influencers) : "none";
  const labelLine = s.label ? \`Label/Distributor field: "\${s.label}"\` : "Label/Distributor field: (empty — no label data from Chartex)";
  return \`You are an A&R scout. Your job is to find UNSIGNED artists on TikTok.

Artist: \${s.author_name}
Track: "\${s.title}"
\${labelLine}
TikTok videos last 7 days: \${fmt(s.tiktok_last_7_days_video_count)}
TikTok videos all time: \${fmt(s.tiktok_total_video_count)}
Top influencers using sound: \${inf}

IMPORTANT RULES:
- If the label field is EMPTY or missing, the artist is almost certainly UNSIGNED. Set is_unsigned: true.
- Only set is_unsigned: false if the label field EXPLICITLY contains a known major or notable indie:
  \${SIGNED}
- These are DISTRIBUTORS not labels (= unsigned): \${DISTROS}
- When in doubt, lean toward is_unsigned: true. False negatives (missing a signed artist) are better than false positives (rejecting an unsigned one).

Reply ONLY with valid JSON, no markdown fences:
{
  "is_unsigned": true or false,
  "label_assessment": "one sentence: what label/distro was detected, or 'No label data — likely unsigned'",
  "niche": "2-4 genre/niche tags comma separated",
  "pitch": "3-4 sentence A&R pitch covering TikTok virality, streaming potential, niche, audience fit",
  "tiktok_momentum": "hot or growing or stable or declining",
  "algo_notes": "1-2 sentences on Spotify algo opportunities (Discover Weekly, Release Radar, editorial)"
}\`;
}

// ── Demo data ─────────────────────────────────────────────────────────────────
function makeDemoSounds(n) {
  const a = ["velvet.wav","cloudboi99","solarflare","nxtwvng","mirembe","fxrever","bedroompop_","the.oak","lilglitch","staticgirl"];
  const t = ["spiral","nowhere fast","gaslight","soft serve","blue hour","paper planes","echo chamber","lavender","static","afterglow"];
  const signed = ["Sony Music","Atlantic","Republic"];
  return Array.from({length:n},(_,i)=>({
    tiktok_sound_id: String(7100000000000000000n+BigInt(i)),
    author_name: a[i%a.length]+(i>=a.length?\`_\${Math.floor(i/a.length)}\`:""),
    title: t[i%t.length],
    tiktok_last_7_days_video_count: Math.floor(Math.random()*60000)+2000,
    tiktok_total_video_count: Math.floor(Math.random()*300000)+10000,
    label: [0,1,0,0,0,1,0,0,0,0][i%10] ? signed[i%3] : "",
    spotify_track_id:"", spotify_artist_id:"", top_influencers:[],
  }));
}

// ── Build email ───────────────────────────────────────────────────────────────
function buildEmail(list) {
  const d = new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  let t = \`Subject: 🎵 Weekly A&R Report — \${list.length} Unsigned Artists — \${d}\\n\\n\`;
  t += \`Hi team,\\n\\nThis week's scout found \${list.length} unsigned artists with strong US TikTok momentum.\\n\\n\${"─".repeat(48)}\\n\\n\`;
  list.forEach(a => {
    t += \`#\${a.rank} — \${a.artist}\\nTrack: "\${a.track}"\\nNiche: \${a.niche}\\nMomentum: \${(a.momentum||"").toUpperCase()}\\n\\n\`;
    t += \`  TikTok 7-day videos: \${fmt(a.v7d)}\\n  TikTok all-time:     \${fmt(a.vTotal)}\\n  Label status:        \${a.labelAssessment}\\n\\n\`;
    if (a.tiktokUrl)  t += \`🔗 TikTok:          \${a.tiktokUrl}\\n\`;
    if (a.spTrackUrl) t += \`🎧 Spotify Track:   \${a.spTrackUrl}\\n\`;
    if (a.spArtUrl)   t += \`👤 Spotify Artist:  \${a.spArtUrl}\\n\`;
    t += \`\\n💡 Pitch:\\n\${a.pitch}\\n\\n📈 Algo:\\n\${a.algoNotes}\\n\\n\${"─".repeat(48)}\\n\\n\`;
  });
  t += \`Auto-generated by A&R Scout — Chartex × Claude — every Monday.\\n\`;
  return t;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function runPipeline() {
  S.proxyUrl = document.getElementById("inp-proxy").value.trim();
  S.scanSize = document.getElementById("inp-scan").value;
  if (!S.proxyUrl) { alert("Enter your Render proxy URL."); return; }

  const limit = Math.max(1, Math.min(parseInt(S.scanSize)||20, 100));
  S.artists = []; S.isDemo = false;

  renderRunning();
  showView("running");

  // Step 1 — proxy fetches all Chartex data server-side
  let sounds = [];
  addLog("📡 Sending scan request to proxy…");
  try {
    const url = S.proxyUrl.replace(/\\/$/, "") + "/scan";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    });
    if (!res.ok) throw new Error(\`Proxy \${res.status}: \${await res.text()}\`);
    const data = await res.json();
    sounds = data.sounds || [];
    addLog(\`✅ Proxy returned \${sounds.length} enriched sounds\`, "success");
  } catch (e) {
    S.isDemo = true;
    addLog(\`⚠️  Proxy error: \${e.message}\`, "warn");
    addLog(\`   → Check your Render URL and make sure the service is awake.\`, "warn");
    addLog(\`   → Running demo data so you can see the pipeline…\`, "warn");
    document.getElementById("demo-banner").style.display = "block";
    sounds = makeDemoSounds(limit);
  }

  setProgress(0, sounds.length, "Claude is analyzing artists…");

  // Step 2 — proxy runs Claude server-side (ANTHROPIC_API_KEY stored in Render env vars)
  addLog("🤖 Sending to proxy for Claude analysis…");
  setProgress(0, sounds.length, "Claude analyzing artists…");
  let analyzed = [];
  try {
    const url = S.proxyUrl.replace(/\\/$/, "") + "/analyze";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sounds }),
    });
    if (!res.ok) throw new Error(\`/analyze \${res.status}: \${await res.text()}\`);
    const data = await res.json();
    analyzed = data.results || [];
    addLog(\`✅ Claude analyzed \${analyzed.length} sounds\`, "success");
  } catch(e) {
    S.isDemo = true;
    addLog(\`⚠️  Analyze error: \${e.message}\`, "warn");
    analyzed = sounds.map(s => ({...s, is_unsigned: true, label_assessment: "Unverified — review manually", niche: "indie", pitch: s.author_name + "'s track is gaining TikTok traction.", tiktok_momentum: "growing", algo_notes: "Review manually."}));
  }

  for (let i = 0; i < analyzed.length; i++) {
    const a = analyzed[i];
    setProgress(i+1, analyzed.length, \`Processing: \${a.author_name}\`);
    if (!a.is_unsigned) {
      addLog(\`  ↳ SKIPPED (signed): \${a.author_name} — \${a.label_assessment}\`, "muted");
      continue;
    }
    addLog(\`  ✅ UNSIGNED — \${a.author_name} | \${a.niche} | \${a.tiktok_momentum}\`, "success");
    S.artists.push({
      rank:            S.artists.length + 1,
      artist:          a.author_name,
      track:           a.title,
      v7d:             a.tiktok_last_7_days_video_count,
      vTotal:          a.tiktok_total_video_count,
      labelAssessment: a.label_assessment,
      niche:           a.niche,
      pitch:           a.pitch,
      momentum:        a.tiktok_momentum,
      algoNotes:       a.algo_notes,
      tiktokUrl:       a.tiktok_official_link || null,
      spTrackUrl:      a.spotify_id ? "https://open.spotify.com/track/" + a.spotify_id : null,
      spArtUrl:        null,
    });
    addChip(a.author_name);
  }

  addLog(\`\\n🎯 Done — \${S.artists.length} unsigned artists found.\`, "success");
  S.emailBody = buildEmail(S.artists);
  renderResults();
  renderEmail();
  showView("results");
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Init ──────────────────────────────────────────────────────────────────────
renderConfig();
showView("config");
</script>
</body>
</html>
`;

// ── /analyze — Claude analysis, server-side with real API key ─────────────────
app.post("/analyze", async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Render env vars" });

  const sounds = (req.body && req.body.sounds) || [];
  if (!sounds.length) return res.json({ results: [] });

  const SIGNED  = "UMG, Sony Music, WMG, Warner, BMG, 300 Entertainment, Kobalt, Concord, Secretly Group, Beggars Group, Epitaph, Sub Pop, Merge, Ninja Tune, Warp, Def Jam, Interscope, Columbia, Atlantic, Republic, Capitol, RCA, Island, Epic, Virgin, Parlophone, Polydor, Cash Money, Roc Nation, TDE, Aftermath, Bad Boy, Motown";
  const DISTROS = "DistroKid, TuneCore, CD Baby, Amuse, United Masters, ONErpm, Stem, Soundrop, Fresh Tunes";

  async function askClaude(prompt) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error("Claude API " + r.status + ": " + JSON.stringify(d));
    return (d.content || []).map(b => b.text || "").join("");
  }

  function fmt(n) {
    if (!n) return "0";
    if (n >= 1000000) return (n/1000000).toFixed(1) + "M";
    if (n >= 1000) return (n/1000).toFixed(1) + "K";
    return String(n);
  }

  const results = [];
  for (const s of sounds) {
    const label   = s.label_name || "";
    const artists = s.artists    || "";
    const inf     = s.top_influencers && s.top_influencers.length ? JSON.stringify(s.top_influencers) : "none";
    const prompt  = `You are an A&R scout finding UNSIGNED artists trending on TikTok.

Sound: "${s.title}"
Creator: ${s.author_name}
Artists listed: ${artists || "(none)"}
Label from Chartex: ${label || "null (no label data)"}
TikTok videos last 7 days: ${fmt(s.tiktok_last_7_days_video_count)}
TikTok videos all time: ${fmt(s.tiktok_total_video_count)}
Top influencers: ${inf}

RULES:
1. label null/empty = is_unsigned true
2. label is a known major/indie label = is_unsigned false. Labels: ${SIGNED}
3. label is a distributor = is_unsigned true. Distributors: ${DISTROS}
4. Unknown small production name = is_unsigned true
5. DEFAULT TO TRUE when uncertain

Reply ONLY valid JSON, no markdown:
{"is_unsigned": true, "label_assessment": "...", "niche": "...", "pitch": "...", "tiktok_momentum": "hot|growing|stable|declining", "algo_notes": "..."}`;

    let analysis;
    try {
      const raw     = await askClaude(prompt);
      const cleaned = raw.replace(/```json|```/g, "").trim();
      analysis      = JSON.parse(cleaned);
    } catch(e) {
      console.error("[analyze] failed for", s.author_name, e.message);
      analysis = { is_unsigned: true, label_assessment: "Parse error — review manually", niche: "indie", pitch: s.author_name + "'s track is trending.", tiktok_momentum: "growing", algo_notes: "Review manually." };
    }

    console.log("[analyze]", s.author_name, "→ is_unsigned:", analysis.is_unsigned, "| label:", s.label_name || "null");
    results.push({ ...s, ...analysis });
  }

  res.json({ results });
});

  } else if (step === "email") {
    el.innerHTML = \`
      <button class="btn btn-dark" onclick="showView('results')">← Results</button>
      <button class="btn btn-lime" id="copy-btn" onclick="copyEmail()">Copy Email</button>\`;
  } else {
    el.innerHTML = "";
  }
}

// ── Config view ───────────────────────────────────────────────────────────────
function renderConfig() {
  document.getElementById("view-config").innerHTML = \`
    <div class="config-wrap">
      <div class="config-box">
        <div class="config-head">WEEKLY RUN CONFIG</div>
        <div class="config-title">Find Unsigned Artists<br>Trending on US TikTok</div>

        <div class="field">
          <label>Render Proxy URL</label>
          <input id="inp-proxy" type="text" value="\${S.proxyUrl}"
            placeholder="https://ar-scout-proxy.onrender.com" />
          <div style="font-size:9px;color:#444;margin-top:4px;line-height:1.7">
            Pre-filled with this page's origin. Change only if running the proxy elsewhere.
          </div>
        </div>

        <div class="field">
          <label>Sounds to scan (1–100 · 20 = quick test · 100 = full weekly run)</label>
          <input id="inp-scan" type="number" class="narrow" value="\${S.scanSize}" min="1" max="100" />
        </div>

        <div class="save-row">
          <button class="btn btn-save" onclick="saveConfig()">💾 Save</button>
          <span id="save-ok" class="save-ok" style="display:none">✓ Saved</span>
        </div>
        <div class="divider"></div>
        <button class="btn btn-run" onclick="runPipeline()">▶ RUN DISCOVERY PIPELINE</button>

        <div class="info-box">
          <strong style="color:#666">How it works:</strong>
          This app sends one POST to your Render proxy →
          the proxy calls Chartex server-side (no CORS restriction) →
          returns all enriched sound data →
          Claude runs unsigned checks and A&R pitches here in the browser.
        </div>
      </div>
    </div>\`;
}

function saveConfig() {
  S.proxyUrl = document.getElementById("inp-proxy").value.trim();
  S.scanSize = document.getElementById("inp-scan").value;
  localStorage.setItem("ar_proxyUrl", S.proxyUrl);
  localStorage.setItem("ar_scanSize", S.scanSize);
  const ok = document.getElementById("save-ok");
  ok.style.display = "inline";
  setTimeout(() => ok.style.display = "none", 2000);
}

// ── Running view ──────────────────────────────────────────────────────────────
let logEl, progressFill, progressPhase, progressCount, chipsEl;

function renderRunning() {
  document.getElementById("view-running").innerHTML = \`
    <div class="run-wrap">
      <div id="demo-banner" class="demo-banner" style="display:none">
        ⚠️ <strong>Proxy unreachable</strong> — showing demo data so you can verify the pipeline.
        Open your Render URL in a browser tab first to wake the free-tier service, then run again.
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-info">
          <span class="progress-phase" id="prog-phase">Starting…</span>
          <span id="prog-count">0/0</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="prog-fill" style="width:2%"></div></div>
      </div>
      <div class="found-chips" id="found-chips"></div>
      <div class="log-box" id="log-box"></div>
    </div>\`;
  logEl         = document.getElementById("log-box");
  progressFill  = document.getElementById("prog-fill");
  progressPhase = document.getElementById("prog-phase");
  progressCount = document.getElementById("prog-count");
  chipsEl       = document.getElementById("found-chips");
}

function addLog(msg, type="info") {
  const d = document.createElement("div");
  d.className = "log-" + type;
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(done, total, phase) {
  progressPhase.textContent = phase;
  progressCount.textContent = \`\${done}/\${total}\`;
  progressFill.style.width  = total ? \`\${(done/total)*100}%\` : "2%";
}

function addChip(name) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = name;
  chipsEl.appendChild(span);
  if (chipsEl.children.length > 10) chipsEl.removeChild(chipsEl.firstChild);
}

// ── Results view ──────────────────────────────────────────────────────────────
function renderResults() {
  const list = S.artists;
  const date = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});

  let cards = list.map(a => {
    const tags = (a.niche||"").split(",").slice(0,2)
      .map(n=>\`<span class="niche-tag">\${n.trim()}</span>\`).join("");
    const mc = mColor[a.momentum] || "#444";

    let links = "";
    if (a.tiktokUrl)  links += \`<a class="ext-link" href="\${a.tiktokUrl}"  target="_blank">↗ TikTok Sound</a>\`;
    if (a.spTrackUrl) links += \`<a class="ext-link" href="\${a.spTrackUrl}" target="_blank">↗ Spotify Track</a>\`;
    if (a.spArtUrl)   links += \`<a class="ext-link" href="\${a.spArtUrl}"   target="_blank">↗ Spotify Artist</a>\`;

    return \`
    <div class="artist-card" style="background:#07070e;border:1px solid #111122" id="card-\${a.rank}">
      <div class="artist-row" onclick="toggleCard(\${a.rank})">
        <div class="artist-rank">#\${a.rank}</div>
        <div class="artist-meta">
          <div class="artist-name">\${esc(a.artist)}</div>
          <div class="artist-track">"\${esc(a.track)}"</div>
        </div>
        <div class="niche-tags">\${tags}</div>
        <div class="artist-v7d">
          <div class="v7d-num">\${fmt(a.v7d)}</div>
          <div class="v7d-label">7d videos</div>
        </div>
        <div class="momentum-dot" style="background:\${mc}"></div>
        <div class="chevron" id="chev-\${a.rank}">▼</div>
      </div>
      <div class="artist-detail" id="detail-\${a.rank}">
        <div class="detail-grid">
          <div>
            <div class="section-label">Chartex Data</div>
            <div class="data-row"><span class="data-label">7-day videos</span><span class="data-value accent">\${fmt(a.v7d)}</span></div>
            <div class="data-row"><span class="data-label">All-time</span><span class="data-value">\${fmt(a.vTotal)}</span></div>
            <div class="data-row"><span class="data-label">Momentum</span><span class="data-value" style="color:\${mc}">\${(a.momentum||"").toUpperCase()}</span></div>
            <div class="data-row"><span class="data-label">Label status</span><span class="data-value small">\${esc(a.labelAssessment)}</span></div>
            <div class="ext-links">\${links}</div>
          </div>
          <div>
            <div class="section-label">A&R Pitch</div>
            <p class="pitch-text">\${esc(a.pitch)}</p>
            <div class="section-label">Streaming Algo</div>
            <p class="algo-text">\${esc(a.algoNotes)}</p>
          </div>
        </div>
      </div>
    </div>\`;
  }).join("");

  const demoBanner = S.isDemo ? \`
    <div class="demo-banner">
      ⚠️ Demo results — proxy was unreachable. Open your Render URL in a new tab to wake it,
      then run again for real data.
    </div>\` : "";

  document.getElementById("view-results").innerHTML = \`
    <div class="results-wrap">
      \${demoBanner}
      <div class="results-header">
        <div class="results-count">\${list.length} UNSIGNED ARTISTS FOUND</div>
        <div class="results-line"></div>
        <div class="results-date">\${date}</div>
      </div>
      \${list.length===0
        ? \`<div style="text-align:center;padding:60px 0;color:#333">No unsigned artists found.</div>\`
        : \`<div class="artist-list">\${cards}</div>\`}
    </div>\`;
}

function toggleCard(rank) {
  const detail = document.getElementById("detail-"+rank);
  const chev   = document.getElementById("chev-"+rank);
  const card   = document.getElementById("card-"+rank);
  const open   = detail.classList.contains("open");
  detail.classList.toggle("open", !open);
  chev.textContent = open ? "▼" : "▲";
  card.style.background = open ? "#07070e" : "#0b0b1a";
  card.style.border      = open ? "1px solid #111122" : "1px solid #252540";
}

// ── Email view ────────────────────────────────────────────────────────────────
function renderEmail() {
  document.getElementById("view-email").innerHTML = \`
    <div class="email-wrap">
      <div class="email-label">EMAIL DRAFT — SENT AUTOMATICALLY EVERY MONDAY</div>
      <div class="email-body">\${esc(S.emailBody)}</div>
    </div>\`;
}

function copyEmail() {
  navigator.clipboard.writeText(S.emailBody).then(() => {
    const btn = document.getElementById("copy-btn");
    if (btn) { btn.textContent = "Copied!"; setTimeout(()=>btn.textContent="Copy Email", 2000); }
  });
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return (data.content||[]).map(b=>b.text||"").join("");
}

function buildPrompt(s) {
  const label   = s.label_name || "";
  const artists = s.artists    || "";
  const inf     = s.top_influencers && s.top_influencers.length ? JSON.stringify(s.top_influencers) : "none";
  const labelLine  = label   ? "Label from Chartex: \"" + label   + "\""    : "Label from Chartex: null (no label data)";
  const artistLine = artists ? "Artists on sound: \"" + artists + "\"" : "Artists on sound: (none listed)";
  return \`You are an A&R scout finding UNSIGNED artists trending on TikTok.

Sound: "\${s.title}"
Creator: \${s.author_name}
\${artistLine}
\${labelLine}
TikTok videos last 7 days: \${fmt(s.tiktok_last_7_days_video_count)}
TikTok videos all time: \${fmt(s.tiktok_total_video_count)}
Top influencers using this sound: \${inf}

RULES:
1. label null/empty = is_unsigned true (no deal detected)
2. label is a known major/notable indie = is_unsigned false. Known labels: \${SIGNED}
3. label is a distributor only = is_unsigned true. Distributors: \${DISTROS}
4. Small unknown production name with no other evidence = is_unsigned true
5. DEFAULT TO TRUE when uncertain — better to over-include than miss real talent

Reply ONLY with valid JSON, no markdown:
{
  "is_unsigned": true or false,
  "label_assessment": "one sentence on what you found",
  "niche": "2-4 genre/niche tags comma separated",
  "pitch": "3-4 sentence A&R pitch: TikTok traction, streaming potential, niche, audience",
  "tiktok_momentum": "hot or growing or stable or declining",
  "algo_notes": "1-2 sentences on Spotify algo opportunities"
}\`;
}

// ── Demo data ─────────────────────────────────────────────────────────────────
function makeDemoSounds(n) {
  const a = ["velvet.wav","cloudboi99","solarflare","nxtwvng","mirembe","fxrever","bedroompop_","the.oak","lilglitch","staticgirl"];
  const t = ["spiral","nowhere fast","gaslight","soft serve","blue hour","paper planes","echo chamber","lavender","static","afterglow"];
  const signed = ["Sony Music","Atlantic","Republic"];
  return Array.from({length:n},(_,i)=>({
    tiktok_sound_id: String(7100000000000000000n+BigInt(i)),
    author_name: a[i%a.length]+(i>=a.length?\`_\${Math.floor(i/a.length)}\`:""),
    title: t[i%t.length],
    tiktok_last_7_days_video_count: Math.floor(Math.random()*60000)+2000,
    tiktok_total_video_count: Math.floor(Math.random()*300000)+10000,
    label: [0,1,0,0,0,1,0,0,0,0][i%10] ? signed[i%3] : "",
    spotify_track_id:"", spotify_artist_id:"", top_influencers:[],
  }));
}

// ── Build email ───────────────────────────────────────────────────────────────
function buildEmail(list) {
  const d = new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  let t = \`Subject: 🎵 Weekly A&R Report — \${list.length} Unsigned Artists — \${d}\\n\\n\`;
  t += \`Hi team,\\n\\nThis week's scout found \${list.length} unsigned artists with strong US TikTok momentum.\\n\\n\${"─".repeat(48)}\\n\\n\`;
  list.forEach(a => {
    t += \`#\${a.rank} — \${a.artist}\\nTrack: "\${a.track}"\\nNiche: \${a.niche}\\nMomentum: \${(a.momentum||"").toUpperCase()}\\n\\n\`;
    t += \`  TikTok 7-day videos: \${fmt(a.v7d)}\\n  TikTok all-time:     \${fmt(a.vTotal)}\\n  Label status:        \${a.labelAssessment}\\n\\n\`;
    if (a.tiktokUrl)  t += \`🔗 TikTok:          \${a.tiktokUrl}\\n\`;
    if (a.spTrackUrl) t += \`🎧 Spotify Track:   \${a.spTrackUrl}\\n\`;
    if (a.spArtUrl)   t += \`👤 Spotify Artist:  \${a.spArtUrl}\\n\`;
    t += \`\\n💡 Pitch:\\n\${a.pitch}\\n\\n📈 Algo:\\n\${a.algoNotes}\\n\\n\${"─".repeat(48)}\\n\\n\`;
  });
  t += \`Auto-generated by A&R Scout — Chartex × Claude — every Monday.\\n\`;
  return t;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function runPipeline() {
  S.proxyUrl = document.getElementById("inp-proxy").value.trim();
  S.scanSize = document.getElementById("inp-scan").value;
  if (!S.proxyUrl) { alert("Enter your Render proxy URL."); return; }

  const limit = Math.max(1, Math.min(parseInt(S.scanSize)||20, 100));
  S.artists = []; S.isDemo = false;

  renderRunning();
  showView("running");

  // Step 1 — proxy fetches all Chartex data server-side
  let sounds = [];
  addLog("📡 Sending scan request to proxy…");
  try {
    const url = S.proxyUrl.replace(/\\/$/, "") + "/scan";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    });
    if (!res.ok) throw new Error(\`Proxy \${res.status}: \${await res.text()}\`);
    const data = await res.json();
    sounds = data.sounds || [];
    addLog(\`✅ Proxy returned \${sounds.length} enriched sounds\`, "success");
  } catch (e) {
    S.isDemo = true;
    addLog(\`⚠️  Proxy error: \${e.message}\`, "warn");
    addLog(\`   → Check your Render URL and make sure the service is awake.\`, "warn");
    addLog(\`   → Running demo data so you can see the pipeline…\`, "warn");
    document.getElementById("demo-banner").style.display = "block";
    sounds = makeDemoSounds(limit);
  }

  setProgress(0, sounds.length, "Claude is analyzing artists…");

  // Step 2 — Claude analyzes each sound
  for (let i = 0; i < sounds.length; i++) {
    const s = sounds[i];
    setProgress(i+1, sounds.length, \`Analyzing: \${s.author_name}\`);
    addLog(\`🔍 [\${i+1}/\${sounds.length}] \${s.author_name} — "\${s.title}"\`);

    let analysis;
    try {
      const raw = await askClaude(buildPrompt(s));
      const cleaned = raw.replace(/\`\`\`json|\`\`\`/g,"").trim();
      try {
        analysis = JSON.parse(cleaned);
      } catch(parseErr) {
        addLog(\`  ⚠️ JSON parse failed — raw: \${cleaned.slice(0,120)}\`, "warn");
        // Default to unsigned when we can't parse — better to over-include
        analysis = {
          is_unsigned: true,
          label_assessment: "Parse error — defaulting to unsigned for review",
          niche: "indie",
          pitch: \`\${s.author_name}'s "\${s.title}" is gaining TikTok traction with \${fmt(s.tiktok_last_7_days_video_count)} new videos in 7 days.\`,
          tiktok_momentum: "growing",
          algo_notes: "Strong TikTok presence often converts to Discover Weekly and Release Radar.",
        };
      }
    } catch(fetchErr) {
      addLog(\`  ⚠️ Claude fetch error: \${fetchErr.message}\`, "warn");
      analysis = {
        is_unsigned: true,
        label_assessment: "Claude unreachable — defaulting to unsigned for review",
        niche: "indie",
        pitch: \`\${s.author_name}'s "\${s.title}" is gaining TikTok traction with \${fmt(s.tiktok_last_7_days_video_count)} new videos in 7 days.\`,
        tiktok_momentum: "growing",
        algo_notes: "Strong TikTok presence often converts to Discover Weekly and Release Radar.",
      };
    }

    if (!analysis.is_unsigned) {
      addLog(\`  ↳ SKIPPED (signed): \${analysis.label_assessment}\`, "muted");
      await sleep(60); continue;
    }
    addLog(\`  ✅ UNSIGNED — \${analysis.niche} | \${analysis.tiktok_momentum} | \${analysis.label_assessment}\`, "success");

    S.artists.push({
      rank:            S.artists.length + 1,
      artist:          s.author_name,
      track:           s.title,
      v7d:             s.tiktok_last_7_days_video_count,
      vTotal:          s.tiktok_total_video_count,
      labelAssessment: analysis.label_assessment,
      niche:           analysis.niche,
      pitch:           analysis.pitch,
      momentum:        analysis.tiktok_momentum,
      algoNotes:       analysis.algo_notes,
      tiktokUrl:    s.tiktok_sound_id    ? \`https://www.tiktok.com/music/\${encodeURIComponent(s.title)}-\${s.tiktok_sound_id}\` : null,
      spTrackUrl:   s.spotify_track_id   ? \`https://open.spotify.com/track/\${s.spotify_track_id}\`   : null,
      spArtUrl:     s.spotify_artist_id  ? \`https://open.spotify.com/artist/\${s.spotify_artist_id}\` : null,
    });
    addChip(s.author_name);
    await sleep(60);
  }

  addLog(\`\\n🎯 Done — \${S.artists.length} unsigned artists found.\`, "success");
  S.emailBody = buildEmail(S.artists);
  renderResults();
  renderEmail();
  showView("results");
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Init ──────────────────────────────────────────────────────────────────────
renderConfig();
showView("config");
</script>
</body>
</html>
`;

app.get("*", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Listening on " + PORT); });
