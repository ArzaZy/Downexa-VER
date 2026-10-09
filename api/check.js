// TEMPORARY diagnostic: GET /api/check tests the key stored in Vercel against SaverAPI's free /api/infobalans endpoint.
// Never returns the key. DELETE this file once everything works.
export async function GET() {
  const key = process.env.MEDIA_API_KEY;
  const out = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!key) return out({ keyFound: false, hint: "MEDIA_API_KEY is not set in Vercel, or you have not redeployed since adding it." });
  try {
    const r = await fetch("https://saverapi.net/api/infobalans", { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10000) });
    const t = (await r.text()).slice(0, 300);
    return out({ keyFound: true, keyLength: key.length, keyStartsWithSk: key.startsWith("sk_"), hasWhitespace: key !== key.trim(), providerStatus: r.status, providerReply: t });
  } catch (e) {
    return out({ keyFound: true, error: "request_failed" });
  }
}
