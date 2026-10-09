// GET /api/download?u=<https url on Instagram's CDN>
// Streams the file back with Content-Disposition: attachment so the browser saves it instead of opening it.
// SSRF protection: https only, allow-listed CDN hostnames, no redirects, no credentials/ports, size + time caps, rate limit.
const ALLOW = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const MAX = 80 * 1024 * 1024; // 80 MB
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}
const text = (status, msg) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

export async function GET(req) {
  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (limited(ip)) return text(429, "Too many requests. Please wait a minute.");
  let t;
  try { t = new URL(new URL(req.url).searchParams.get("u") || ""); } catch { return text(400, "Invalid link."); }
  if (t.protocol !== "https:" || t.username || t.password || t.port || !ALLOW.test(t.hostname)) return text(400, "This host is not allowed.");
  let r;
  try { r = await fetch(t.href, { redirect: "error", signal: AbortSignal.timeout(50000) }); } catch { return text(502, "Could not fetch the file."); }
  if (!r.ok || !r.body) return text(502, "The file is no longer available. Try processing the link again.");
  const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!EXT[type]) return text(415, "Unsupported file type.");
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX) return text(413, "File is too large.");
  let n = 0;
  const cap = new TransformStream({ transform(c, ctl) { n += c.byteLength; n > MAX ? ctl.error(new Error("too_large")) : ctl.enqueue(c); } });
  const headers = {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="downexa-${Date.now()}.${EXT[type]}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (len) headers["Content-Length"] = String(len);
  return new Response(r.body.pipeThrough(cap), { headers });
}
