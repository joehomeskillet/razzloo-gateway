// Phase 4 (§8) — player /j multi-candidate join UX. The page lists EVERY
// candidate priority-ordered (lan, public-ipv6, public-ipv4, manual; upnp
// last), each a top-level-navigation <a href> button plus a same-origin
// per-candidate QR. These tests pin the candidate ORDER (server is the single
// source of truth for both the JSON resolve view and the qr.svg ?i= index), the
// XSS-inertness of the client renderer, and that no secret ever leaks into the
// page or its bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, register, registerBody, validCandidate } from "./helpers.js";

// A multi-kind session, registered in a deliberately WRONG kind order with
// scrambled numeric priorities, so the test proves the ordering is applied.
function multiKindBody() {
  return registerBody({
    candidates: [
      validCandidate({ kind: "manual", url: "http://host.example.com:7777", priority: 0 }),
      validCandidate({ kind: "public-ipv4", url: "http://8.8.8.8:7777", priority: 50 }),
      validCandidate({ kind: "lan", url: "http://192.168.1.42:7777", priority: 90 }),
      validCandidate({ kind: "public-ipv6", url: "http://[2606:4700:4700::1111]:7777", priority: 10 }),
      validCandidate({ kind: "upnp", url: "http://9.9.9.9:7777", priority: 1 }),
    ],
  });
}

test("candidates resolve in player order: lan, public-ipv6, public-ipv4, manual, upnp last", async () => {
  const { app } = await makeApp();
  const reg = (await register(app, multiKindBody())).json();
  assert.equal(reg && typeof reg.joinCode, "string");
  const res = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode });
  assert.equal(res.statusCode, 200);
  const kinds = res.json().candidates.map((c: { kind: string }) => c.kind);
  // Despite the scrambled input order + numeric priorities, kind-rank wins.
  assert.deepEqual(kinds, ["lan", "public-ipv6", "public-ipv4", "manual", "upnp"]);
  await app.close();
});

test("numeric priority is the tiebreaker WITHIN a kind", async () => {
  const { app } = await makeApp();
  const reg = (
    await register(
      app,
      registerBody({
        candidates: [
          validCandidate({ kind: "lan", url: "http://10.0.0.2:7777", priority: 30 }),
          validCandidate({ kind: "lan", url: "http://10.0.0.1:7777", priority: 5 }),
          validCandidate({ kind: "lan", url: "http://10.0.0.3:7777", priority: 20 }),
        ],
      }),
    )
  ).json();
  const urls = (await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode }))
    .json()
    .candidates.map((c: { url: string }) => c.url);
  assert.deepEqual(urls, [
    "http://10.0.0.1:7777", // priority 5
    "http://10.0.0.3:7777", // priority 20
    "http://10.0.0.2:7777", // priority 30
  ]);
  await app.close();
});

test("per-candidate qr.svg?i=<n> encodes the n-th candidate in the SAME player order", async () => {
  const { app } = await makeApp();
  const reg = (await register(app, multiKindBody())).json();
  // Index 0 = lan, index 2 = public-ipv4 (8.8.8.8). Each ?i serves a valid SVG;
  // each encodes its OWN candidate (distinct payloads => distinct SVG bytes).
  const qr0 = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg?i=0" });
  const qr2 = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg?i=2" });
  assert.equal(qr0.statusCode, 200);
  assert.equal(qr2.statusCode, 200);
  assert.match(qr0.body, /<svg/);
  assert.match(qr2.body, /<svg/);
  assert.notEqual(qr0.body, qr2.body, "different candidates produce different QR payloads");
  // Out-of-range / missing index falls back to the first candidate (index 0).
  const qrOob = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg?i=99" });
  const qrNone = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg" });
  assert.equal(qrOob.body, qr0.body, "out-of-range index falls back to candidate 0");
  assert.equal(qrNone.body, qr0.body, "missing index falls back to candidate 0");
  await app.close();
});

test("zero candidates still resolves gracefully (no candidates => message, no crash)", async () => {
  // A session can reach zero candidates only via the store (schema requires >=1
  // at register/PATCH). Force it directly to exercise the empty path end-to-end.
  const { app, store } = await makeApp();
  const reg = (await register(app)).json();
  const rec = store.getById(reg.sessionId)!;
  rec.candidates = [];
  const res = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().candidates, []);
  // qr.svg for a now-empty session serves the generic placeholder (not a crash).
  const qr = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg?i=0" });
  assert.equal(qr.statusCode, 200);
  assert.match(qr.body, /<svg/);
  await app.close();
});

// ── XSS / inertness of the client candidate renderer ────────────────────────

test("candidate kind/url are rendered via DOM text APIs, never innerHTML (markup inert)", async () => {
  // app.js is the only place candidate values become DOM. Assert it uses the
  // safe APIs (textContent / setAttribute) and NEVER assigns candidate data to
  // innerHTML — so a hostile url/kind string cannot inject markup. A literal
  // payload like `"><img src=x onerror=alert(1)>` would be inserted as TEXT.
  const { app } = await makeApp();
  const js = (await app.inject({ method: "GET", url: "/j/app.js" })).body;
  assert.ok(js.includes(".textContent = c.kind"), "kind is set via textContent");
  assert.ok(js.includes(".textContent = c.url"), "url is shown via textContent");
  assert.ok(js.includes("setAttribute('href'"), "href is set via setAttribute");
  // No innerHTML assignment carrying candidate data. innerHTML appears only to
  // CLEAR a container (allowed: assigned a constant), never `= c.` (candidate).
  assert.ok(!/innerHTML\s*=\s*[^;]*\bc\./.test(js), "no innerHTML = <candidate data>");
  // Defense-in-depth: a non-http(s) scheme is gated before becoming an href.
  assert.ok(js.includes("u.protocol === 'http:'"), "only http/https urls are clickable");
  await app.close();
});

test("a markup/script-bearing candidate is rejected at write time (never stored, never rendered)", async () => {
  // The renderer is DOM-safe regardless, but write-time validation also makes a
  // markup payload unstorable: an `"><img ...>` url is not a parseable host:port
  // URL, and a `<script>` kind is not in the kind enum. Both => 400, no oracle.
  const { app } = await makeApp();
  const badUrl = await register(
    app,
    registerBody({ candidates: [validCandidate({ url: '"><img src=x onerror=alert(1)>' })] }),
  );
  assert.equal(badUrl.statusCode, 400, "markup url fails write-time validation");
  const badKind = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "<script>", url: "http://192.168.1.42:7777" })] }),
  );
  assert.equal(badKind.statusCode, 400, "non-enum kind fails schema validation");
  await app.close();
});

// ── No secret ever reaches the page or its bootstrap ────────────────────────

test("the /j page body and /j/app.js never contain hostToken or observedFrom", async () => {
  const { app, store } = await makeApp();
  const reg = (
    await register(
      app,
      registerBody({
        candidates: [
          // observedFrom is a valid stored field — assert it never surfaces.
          validCandidate({ kind: "lan", url: "http://192.168.1.42:7777", observedFrom: "host" }),
          validCandidate({ kind: "public-ipv4", url: "http://8.8.8.8:7777", observedFrom: "stun", priority: 10 }),
        ],
      }),
    )
  ).json();
  const page = (await app.inject({ method: "GET", url: "/j/" + reg.joinCode })).body;
  const js = (await app.inject({ method: "GET", url: "/j/app.js" })).body;
  // The raw host token (returned ONCE at register) must never appear anywhere.
  assert.ok(typeof reg.hostToken === "string" && reg.hostToken.startsWith("ht_"));
  for (const surface of [page, js]) {
    assert.ok(!surface.includes(reg.hostToken), "host token absent");
    assert.ok(!surface.includes("ht_"), "no token prefix");
    assert.ok(!/observedFrom/i.test(surface), "observedFrom absent");
    assert.ok(!/\bstun\b/.test(surface), "observedFrom value 'stun' absent");
  }
  // And the JSON resolve view (which the page fetches) also omits observedFrom.
  const resolved = (await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode })).json();
  const serialized = JSON.stringify(resolved);
  assert.ok(!serialized.includes("observedFrom"), "resolve view omits observedFrom");
  assert.ok(!serialized.includes("hostToken"), "resolve view omits hostToken");
  await app.close();
});

test("the static /j page still has exactly one script tag (CSP script-src 'self' intact)", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const page = (await app.inject({ method: "GET", url: "/j/" + reg.joinCode })).body;
  const scriptTags = page.match(/<script\b/gi) || [];
  assert.equal(scriptTags.length, 1, "only the external bootstrap include");
  assert.ok(page.includes('<script src="/j/app.js"></script>'), "the one script is the external bootstrap");
  // Candidate data is NOT inlined into the page (it arrives via fetch at runtime).
  assert.ok(!page.includes("8.8.8.8") && !page.includes("192.168"), "no candidate values inlined in HTML");
  await app.close();
});
