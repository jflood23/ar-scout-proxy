const express = require("express");
const app = express();
app.use(express.json());

const CHARTEX_BASE = "https://api.chartex.com/external/v1";

// Allow requests from anywhere (Claude artifact, your own domain, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/chartex", async (req, res) => {
  const { path, params } = req.body;

  // Credentials come from environment variables — never from the client
  const appId    = process.env.CHARTEX_APP_ID;
  const appToken = process.env.CHARTEX_APP_TOKEN;

  if (!appId || !appToken) {
    return res.status(500).json({ error: "Server credentials not configured" });
  }

  if (!path || !path.startsWith("/tiktok-sounds")) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    const qs  = params ? "?" + new URLSearchParams(params).toString() : "";
    const url = `${CHARTEX_BASE}${path}${qs}`;

    const upstream = await fetch(url, {
      headers: {
        "X-APP-ID":    appId,
        "X-APP-TOKEN": appToken,
      },
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Upstream fetch failed", detail: err.message });
  }
});

app.get("/", (_, res) => res.send("A&R Scout proxy — OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
