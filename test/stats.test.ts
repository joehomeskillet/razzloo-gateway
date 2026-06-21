// Public FLAT-CREAM stats page + aggregate API. Covers store.stats() counting,
// the privacy contract (NO per-session datum), CSP + no-inline-script on GET /,
// and the static asset content-types. Additive — touches no existing test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { SessionStore } from "../src/store.js";
import { JoinLockout } from "../src/lockout.js";
import { register, registerBody } from "./helpers.js";

// Local harness so we can pass a getLiveTunnels stub (the shared helper does not).
async function makeStatsApp(liveTunnels = 0) {
  const store = new SessionStore();
  const lockout = new JoinLockout();
  const app = await buildApp({
    store,
    lockout,
    enableRateLimit: false,
    getLiveTunnels: () => liveTunnels,
  });
  await app.ready();
  return { app, store };
}

test("store.stats() counts by status: create N -> live===N, waiting===N", () => {
  const store = new SessionStore();
  const N = 3;
  const recs = [];
  for (let i = 0; i < N; i++) {
    recs.push(store.create({ hostId: "h", protocolVersion: 1, appVersion: "0", candidates: [] }));
  }
  const s = store.stats();
  assert.equal(s.live, N);
  assert.equal(s.waiting, N);
  assert.equal(s.online, 0);
  assert.equal(s.totalCreated, N);

  // heartbeat one row -> online increments, waiting drops.
  store.heartbeat(recs[0]!.record);
  const s2 = store.stats();
  assert.equal(s2.online, 1);
  assert.equal(s2.waiting, N - 1);
  assert.equal(s2.live, N);
  assert.equal(s2.totalCreated, N); // monotonic, unaffected by status change
});

test("store.stats() totalCreated is monotonic across reaped rows", () => {
  const store = new SessionStore();
  const a = store.create({ hostId: "h", protocolVersion: 1, appVersion: "0", candidates: [] });
  store.delete(a.record.sessionId);
  const s = store.stats();
  assert.equal(s.live, 0);
  assert.equal(s.totalCreated, 1, "cumulative counter not decremented on delete");
});

test("GET /api/v1/stats -> 200 JSON with exactly the aggregate keys; relayTunnels reflects the stub", async () => {
  const { app } = await makeStatsApp(7);
  const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /application\/json/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  const body = res.json();
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, [
    "liveSessions",
    "offline",
    "online",
    "relayTunnels",
    "serverTime",
    "totalRegistered",
    "uptimeSeconds",
    "waiting",
  ]);
  assert.equal(body.relayTunnels, 7);
  assert.equal(typeof body.uptimeSeconds, "number");
  await app.close();
});

test("GET /api/v1/stats totalRegistered increases after POST /api/v1/sessions", async () => {
  const { app } = await makeStatsApp();
  const before = (await app.inject({ method: "GET", url: "/api/v1/stats" })).json();
  await register(app);
  const after = (await app.inject({ method: "GET", url: "/api/v1/stats" })).json();
  assert.equal(after.totalRegistered, before.totalRegistered + 1);
  assert.equal(after.liveSessions, before.liveSessions + 1);
  assert.equal(after.waiting, before.waiting + 1);
  await app.close();
});

test("PRIVACY: /api/v1/stats body contains NO join code / sessionId / hostId", async () => {
  const { app } = await makeStatsApp();
  const reg = (await register(app, registerBody({ hostId: "h_DEADBEEF_secret" }))).json();
  const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
  const raw = res.payload; // raw string body
  assert.ok(!raw.includes(reg.joinCode), "join code must not leak");
  assert.ok(!raw.includes(reg.sessionId), "sessionId must not leak");
  assert.ok(!raw.includes("h_DEADBEEF_secret"), "hostId must not leak");
  assert.ok(!raw.includes("ht_"), "host token must not leak");
  assert.ok(!raw.includes("hostId"), "no hostId key");
  assert.ok(!raw.includes("candidates"), "no candidate data");
  await app.close();
});

test("GET / -> 200 text/html, CSP with script-src 'self', NO inline executable script", async () => {
  const { app } = await makeStatsApp();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  const csp = res.headers["content-security-policy"] as string;
  assert.ok(csp.includes("script-src 'self'"), "CSP locks script-src to 'self'");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  const html = res.payload;
  // the only <script> is the external same-origin /stats.js (no inline logic).
  assert.ok(html.includes('<script src="/stats.js" defer></script>'));
  const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
  assert.equal(scriptTags.length, 1, "exactly one script tag");
  assert.ok(!/<script>[^]*?<\/script>/.test(html), "no inline <script> with a body");
  await app.close();
});

test("GET /stats.js -> 200 application/javascript; GET /stats.css -> 200 text/css", async () => {
  const { app } = await makeStatsApp();
  const js = await app.inject({ method: "GET", url: "/stats.js" });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["content-type"] as string, /application\/javascript/);
  const css = await app.inject({ method: "GET", url: "/stats.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"] as string, /text\/css/);
  // design guardrail: no glass/blur anywhere in the served CSS.
  assert.ok(!css.payload.includes("backdrop-filter"), "no backdrop-filter (flat-only)");
  assert.ok(!css.payload.includes("blur("), "no blur (flat-only)");
  await app.close();
});

test("GET /fonts/rubik.woff2 -> 200 font/woff2 with immutable cache", async () => {
  const { app } = await makeStatsApp();
  const res = await app.inject({ method: "GET", url: "/fonts/rubik.woff2" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "font/woff2");
  assert.match(res.headers["cache-control"] as string, /immutable/);
  assert.ok(res.rawPayload.length > 1000, "real woff2 bytes served");
  await app.close();
});
