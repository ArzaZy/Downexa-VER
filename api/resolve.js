// POST /api/resolve  { "url": "https://www.instagram.com/p/XXXX/" }
// The API key is read ONLY from the MEDIA_API_KEY environment variable (Vercel > Project Settings > Environment Variables).

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status, error, message) => json(status, { error, message });

// Best-effort rate limit (in-memory, resets on cold start). Use Upstash Redis or similar for a durable one.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60_000, max = 8;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

// Only accept public instagram.com post/reel/tv URLs. Hostname is allow-listed, so internal IPs / other hosts are never fetched.
function parse(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!/^(www\.)?instagram\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)\/?$/i);
  return m ? `https://www.instagram.com/${m[1].toLowerCase() === "reels" ? "reel" : m[1].toLowerCase()}/${m[2]}/` : null;
}

// SaverAPI: GET https://saverapi.net/api/all-in-one-downloader-api?url=...  (header x-api-key)
// NOTE: the response shape below is NOT verified against the docs. The parser accepts common shapes and
// fails safely (returns "unsupported") when nothing recognizable is found. Adjust pickItems() once you see a real response.
const ENDPOINT = "https://saverapi.net/api/all-in-one-downloader-api";
const URLKEYS = ["url", "download_url", "downloadUrl", "link", "src", "video_url", "image_url"];
const THUMBKEYS = ["thumbnail", "thumb", "cover", "preview", "image"];
const isHttps = v => typeof v === "string" && /^https:\/\//.test(v);
const first = (o, keys) => { for (const k of keys) if (isHttps(o?.[k])) return o[k]; return ""; };

function pickItems(d) {
  const root = d?.data ?? d?.result ?? d;
  const list = [root?.medias, root?.media, root?.links, root?.items, root?.downloads, root?.data, root]
    .find(x => Array.isArray(x));
  const arr = list || [root];
  const items = [];
  for (const m of arr) {
    if (typeof m === "string" && isHttps(m)) { items.push({ downloadUrl: m, thumbnail: "", kind: /\.(mp4|mov|webm)/i.test(m) ? "video" : "image" }); continue; }
    const dl = first(m, URLKEYS);
    if (!dl) continue;
    const t = String(m.type || m.kind || m.extension || "");
    items.push({ downloadUrl: dl, thumbnail: first(m, THUMBKEYS), kind: /video|mp4|mov|webm/i.test(t) || /\.(mp4|mov|webm)/i.test(dl) ? "video" : "image" });
  }
  return items;
}

async function fetchFromProvider(cleanUrl, apiKey) {
  const r = await fetch(`${ENDPOINT}?url=${encodeURIComponent(cleanUrl)}`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) throw new Error("unsupported");
  if (r.status === 403) throw new Error("private");
  if (!r.ok) throw new Error("upstream");
  const d = await r.json();
  const items = pickItems(d);
  if (!items.length) throw new Error("unsupported");
  const multi = items.length > 1;
  const type = multi ? "carousel" : items[0].kind === "video" ? (/\/reel/.test(cleanUrl) ? "reel" : "video") : "photo";
  return { type, items };
}

export async function POST(req) {
  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (limited(ip)) return fail(429, "rate_limited", "Too many requests. Please wait a minute and try again.");

  let body; try { body = await req.json(); } catch { return fail(400, "invalid_url", "Invalid request."); }
  const clean = parse(body?.url);
  if (!clean) return fail(400, "invalid_url", "Paste a public Instagram post, Reel, or video link.");

  const key = process.env.MEDIA_API_KEY;
  if (!key) return fail(503, "upstream_failed", "The service isn't configured yet.");

  try {
    const data = await fetchFromProvider(clean, key);
    const items = (data.items || [])
      .map(i => ({ thumbnail: i.thumbnail, kind: i.kind === "video" ? "video" : "image", downloadUrl: i.downloadUrl }))
      .filter(i => /^https:\/\//.test(i.downloadUrl || ""))
      .slice(0, 20);
    if (!items.length) return fail(422, "unsupported", "No downloadable media was found for this link.");
    return json(200, { type: data.type, items });
  } catch (e) {
    if (e.message === "private") return fail(403, "private", "This media is private.");
    if (e.message === "unsupported") return fail(422, "unsupported", "This media type isn't supported.");
    return fail(502, "upstream_failed", "We couldn't process this link right now.");
  }
}
