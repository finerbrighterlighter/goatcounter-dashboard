import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi } from "../src/worker.js";

const BASE = "https://analytics.htunteza.com";
const UP = "https://finerbrighterlighter.goatcounter.com";
let calls, upstream, limitOk, limitKeys, globalOk, globalKeys, store;

const env = () => ({
  GOATCOUNTER_URL: UP,
  GOATCOUNTER_TOKEN: { get: async () => "tok" },
  API_LIMITER: { limit: async ({ key }) => (limitKeys.push(key), { success: limitOk }) },
  API_LIMITER_GLOBAL: { limit: async ({ key }) => (globalKeys.push(key), { success: globalOk }) },
});
const cache = {
  match: async (r) => store.get(r.url)?.clone(),
  put: async (r, res) => void store.set(r.url, res.clone()),
};
const get = (path, init) => handleApi(new Request(BASE + path, init), env(), {}, cache);

beforeEach(() => {
  calls = []; limitOk = true; limitKeys = []; globalOk = true; globalKeys = []; store = new Map();
  upstream = () => new Response('{"ok":1}', { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url, init) => {
    const req = new Request(url, init);
    calls.push(req);
    return upstream(req);
  };
});

test("forwards stats GET with query", async () => {
  const res = await get("/api/v0/stats/total?start=2026-10-01&end=2026-10-20");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":1}');
  assert.equal(calls[0].url, `${UP}/api/v0/stats/total?start=2026-10-01&end=2026-10-20`);
});

test("uses secret token, not client header", async () => {
  const res = await get("/api/v0/stats/total", { headers: { Authorization: "Bearer evil" } });
  assert.equal(calls[0].headers.get("Authorization"), "Bearer tok");
  assert.ok(!(await res.text()).includes("tok"));
  for (const [k, v] of res.headers) assert.ok(!k.includes("tok") && !v.includes("tok"), k);
});

test("blocks non-stats paths", async () => {
  for (const p of ["/api/v0/me", "/api/v0/sites", "/api/v0/export/1", "/api/v0/stats"]) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal(calls.length, 0);
});

test("rejects encoded traversal", async () => {
  for (const p of ["/api/v0/stats/..%2Fme", "/api/v0/stats/%2e%2e/me", "/api/v0/stats/hits/..", "/api/v0/stats/%E0%A4%A"]) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal(calls.length, 0);
});

test("allows drill-down ids with spaces", async () => {
  const res = await get("/api/v0/stats/browsers/Mobile%20Safari");
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `${UP}/api/v0/stats/browsers/Mobile%20Safari`);
});

test("only GET", async () => {
  const res = await get("/api/v0/stats/total", { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET");
  assert.equal(calls.length, 0);
});

test("caches 200 for an hour", async () => {
  const a = await get("/api/v0/stats/total");
  const b = await get("/api/v0/stats/total");
  assert.equal(calls.length, 1);
  assert.equal(a.headers.get("X-Analytics-Cache"), "MISS");
  assert.equal(b.headers.get("X-Analytics-Cache"), "HIT");
  assert.match(store.get(BASE + "/api/v0/stats/total").headers.get("Cache-Control"), /public, max-age=3600/);
  assert.equal(a.headers.get("Cache-Control"), "no-store");
  assert.equal(b.headers.get("Cache-Control"), "no-store");
});

test("errors are no-store", async () => {
  assert.equal((await get("/api/v0/me")).headers.get("Cache-Control"), "no-store");
  assert.equal((await get("/api/v0/stats/total", { method: "POST" })).headers.get("Cache-Control"), "no-store");
});

test("upstream 401/403 become uncached 502", async () => {
  for (const status of [401, 403]) {
    store.clear();
    upstream = () => new Response("bad token", { status });
    const res = await get("/api/v0/stats/total");
    assert.equal(res.status, 502, String(status));
    assert.equal(res.headers.get("Content-Type"), "application/json");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await res.json(), { error: "upstream unavailable" });
    assert.equal(store.size, 0);
  }
});

test("upstream network error becomes uncached 502", async () => {
  upstream = () => { throw new TypeError("network down"); };
  const res = await get("/api/v0/stats/total");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upstream unavailable" });
  assert.equal(store.size, 0);
});

test("global limit on miss returns 429 without upstream call", async () => {
  globalOk = false;
  const res = await get("/api/v0/stats/total");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(calls.length, 0);
  assert.deepEqual(globalKeys, ["global"]);
});

test("global limit does not apply to cache hits", async () => {
  await get("/api/v0/stats/total");
  globalOk = false;
  const res = await get("/api/v0/stats/total");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Analytics-Cache"), "HIT");
  assert.equal(calls.length, 1);
  assert.equal(globalKeys.length, 1);
});

test("does not cache upstream errors", async () => {
  let n = 0;
  upstream = () => new Response("{}", { status: ++n === 1 ? 429 : 200 });
  const a = await get("/api/v0/stats/total");
  await get("/api/v0/stats/total");
  assert.equal(a.status, 429);
  assert.equal(calls.length, 2);
});

test("rate limits per ip", async () => {
  limitOk = false;
  const res = await get("/api/v0/stats/total", { headers: { "CF-Connecting-IP": "203.0.113.5" } });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(calls.length, 0);
  await get("/api/v0/stats/total");
  assert.deepEqual(limitKeys, ["203.0.113.5", "unknown"]);
});

test("fetch falls back to assets outside /api/", async () => {
  const e = { ...env(), ASSETS: { fetch: async () => new Response("asset") } };
  const res = await worker.fetch(new Request(BASE + "/"), e, {});
  assert.equal(await res.text(), "asset");
});
