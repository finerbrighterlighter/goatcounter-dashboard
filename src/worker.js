// Proxies GoatCounter stats API calls with a server-side token.
// Static assets are served by the assets binding; only /api/* reaches here.

const TTL = 3600;
const PAGE = /^[A-Za-z0-9_]+$/;
const ID = /^[A-Za-z0-9 _.,:+-]+$/;

const text = (body, status, headers = {}) => new Response(body, { status, headers });

// Returns the upstream path for an allowed stats request, else null.
function allowedPath(pathname) {
  let segs;
  try {
    segs = pathname.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  // ["", "api", "v0", "stats", page, id?]
  if (segs.length < 5 || segs.length > 6) return null;
  const [lead, api, v0, stats, page, id] = segs;
  if (lead !== "" || api !== "api" || v0 !== "v0" || stats !== "stats") return null;
  if (!PAGE.test(page)) return null;
  if (id === undefined) return `/api/v0/stats/${page}`;
  if (!ID.test(id) || id === "." || id === "..") return null;
  return `/api/v0/stats/${page}/${encodeURIComponent(id)}`;
}

export async function handleApi(request, env, ctx, cache) {
  if (request.method !== "GET") return text("Method not allowed", 405, { Allow: "GET" });

  const url = new URL(request.url);
  const path = allowedPath(url.pathname);
  if (!path) return text("Not found", 404);

  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await env.API_LIMITER.limit({ key });
  if (!success) return text("Too many requests", 429, { "Retry-After": "60" });

  const cacheKey = new Request(request.url);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("X-Analytics-Cache", "HIT");
    return res;
  }

  const upstream = await fetch(env.GOATCOUNTER_URL + path + url.search, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await env.GOATCOUNTER_TOKEN.get()}`,
    },
  });
  const res = new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
  });
  if (upstream.status === 200) {
    res.headers.set("Cache-Control", `public, max-age=${TTL}`);
    await cache.put(cacheKey, res.clone());
  }
  res.headers.set("X-Analytics-Cache", "MISS");
  return res;
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx, caches.default);
    }
    return env.ASSETS.fetch(request);
  },
};
