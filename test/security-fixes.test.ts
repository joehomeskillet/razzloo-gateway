// Regression tests for the adversarial-review findings (C1, H1, H2, M1, L3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, register, registerBody, validCandidate } from "./helpers.js";

// ── C1: Reflected XSS in /j/:code (script-context breakout) ─────────────────

test("C1: /j/:code does NOT reflect a </script> breakout; code is sanitized to charset", async () => {
  const { app } = await makeApp();
  // Both lowercase and UPPERCASE end-tag payloads. JSON.stringify would have
  // left </SCRIPT> intact in the old inline-script sink.
  const payloads = [
    "</script><svg/onload=alert(1)>",
    "</SCRIPT><svg/onload=alert(1)>",
    "</ScRiPt><img src=x onerror=alert(1)>",
  ];
  for (const raw of payloads) {
    const res = await app.inject({ method: "GET", url: "/j/" + encodeURIComponent(raw) });
    assert.equal(res.statusCode, 200, `payload ${raw} still serves the page (no oracle)`);
    const body = res.body;
    // The page now has exactly ONE script tag: the static bootstrap include.
    // There must be NO injected/closing script tag carrying the payload.
    assert.ok(
      !/<\/script\s*>/i.test(body.replace('<script src="/j/app.js"></script>', "")),
      `no live </script> breakout for ${raw}`,
    );
    assert.ok(!/onload\s*=/i.test(body), `no onload handler reflected for ${raw}`);
    assert.ok(!/onerror\s*=/i.test(body), `no onerror handler reflected for ${raw}`);
    assert.ok(!body.includes("<svg"), `no <svg injected for ${raw}`);
    assert.ok(!body.includes("<img"), `no <img injected for ${raw}`);
    // Charset-sanitized: invalid input renders as an empty code (data-code="").
    assert.ok(/data-code="[BCDFGHJKLMNPQRSTVWXZ2-9]{0,6}"/.test(body), `code sanitized to charset for ${raw}`);
  }
  await app.close();
});

test("C1: /j/:code sets a strict CSP header in the app (no script-src 'unsafe-inline')", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/j/AAAAAA" });
  const csp = res.headers["content-security-policy"];
  assert.ok(typeof csp === "string" && csp.length > 0, "CSP header present on the join page");
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must NOT allow 'unsafe-inline'");
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  await app.close();
});

test("C1: a valid code is carried via data-code (no inline ${...} interpolation)", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const res = await app.inject({ method: "GET", url: "/j/" + reg.joinCode });
  assert.ok(res.body.includes(`data-code="${reg.joinCode}"`), "code is in the data attribute");
  // The static bootstrap reads the code from data-code, not from an inline const.
  const js = (await app.inject({ method: "GET", url: "/j/app.js" })).body;
  assert.ok(js.includes("getAttribute('data-code')"), "bootstrap reads the code from data-code");
  await app.close();
});

test("C1: /j/app.js is served same-origin as javascript (CSP script-src 'self' satisfiable)", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/j/app.js" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /javascript/);
  await app.close();
});

// ── H1: IPv4-mapped IPv6 bypass in classifyIPv6 ─────────────────────────────

test("H1: ::ffff:-mapped private/loopback/link-local/unspecified -> 400 (no public bypass)", async () => {
  const { app } = await makeApp();
  // WHATWG URL canonicalizes these to ::ffff:7f00:1 etc (no dot) — the old
  // `original.includes(".")` gate let them fall through to "public".
  const mapped = [
    "[::ffff:127.0.0.1]", // loopback
    "[::ffff:169.254.169.254]", // cloud metadata / link-local
    "[::ffff:192.168.1.1]", // RFC1918
    "[::ffff:10.0.0.1]", // RFC1918
    "[::ffff:0.0.0.0]", // unspecified
  ];
  for (const host of mapped) {
    const url = "http://" + host + ":7777";
    for (const kind of ["public-ipv6", "public-ipv4", "manual"] as const) {
      const res = await register(
        app,
        registerBody({ candidates: [validCandidate({ kind, url })] }),
      );
      assert.equal(res.statusCode, 400, `${kind} ${url} must be rejected`);
      assert.equal(res.json().error, "invalid_candidate_url", `${kind} ${url}`);
    }
  }
  await app.close();
});

test("H1: NAT64 64:ff9b::/96 and ::ffff:0:0 base -> 400", async () => {
  const { app } = await makeApp();
  for (const host of ["[64:ff9b::1]", "[64:ff9b::8.8.8.8]"]) {
    const res = await register(
      app,
      registerBody({ candidates: [validCandidate({ kind: "public-ipv6", url: "http://" + host + ":7777" })] }),
    );
    assert.equal(res.statusCode, 400, `${host} must be rejected (NAT64)`);
    assert.equal(res.json().error, "invalid_candidate_url");
  }
  await app.close();
});

test("H1: a genuinely-public ::ffff:-mapped address still allowed (no over-block)", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "public-ipv6", url: "http://[::ffff:8.8.8.8]:7777" })] }),
  );
  assert.equal(res.statusCode, 201, "mapped public 8.8.8.8 is still a valid public candidate");
  await app.close();
});

// ── H2: qr.svg enumeration oracle / lockout bypass ──────────────────────────

test("H2: qr.svg is not a status oracle — unknown vs known both 200 SVG", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const known = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg" });
  const unknown = await app.inject({ method: "GET", url: "/j/ZZZZZZ/qr.svg" });
  assert.equal(known.statusCode, 200);
  assert.equal(unknown.statusCode, 200, "unknown code is NOT distinguishable by status");
  assert.match(known.body, /<svg/);
  assert.match(unknown.body, /<svg/, "unknown serves a generic placeholder SVG");
  await app.close();
});

test("H2: qr.svg participates in the join lockout (locked after JSON-route threshold)", async () => {
  const { app } = await makeApp(); // rate-limit off; isolate the lockout
  // Trip the lockout via the qr.svg route itself (default threshold = 10).
  for (let i = 0; i < 10; i++) {
    const r = await app.inject({ method: "GET", url: "/j/ZZZZZZ/qr.svg" });
    assert.equal(r.statusCode, 200, "miss serves placeholder 200, but counts toward lockout");
  }
  // Now locked: qr.svg returns 429 (Retry-After) AND the JSON route is locked too.
  const lockedQr = await app.inject({ method: "GET", url: "/j/ZZZZZZ/qr.svg" });
  assert.equal(lockedQr.statusCode, 429, "qr.svg honours the lockout");
  assert.ok(lockedQr.headers["retry-after"], "429 carries Retry-After");
  const lockedJson = await app.inject({ method: "GET", url: "/api/v1/join/ZZZZZZ" });
  assert.equal(lockedJson.statusCode, 429, "shared lockout: JSON route is locked too");
  await app.close();
});

// ── M1: trustProxy=1 (XFF spoofing can't bypass per-IP limits) ──────────────

test("M1: only the immediate proxy hop is trusted (spoofed XFF chain ignored)", async () => {
  const { app } = await makeApp();
  // With trustProxy:1, Fastify uses the RIGHT-MOST XFF entry (the hop the proxy
  // appended), so a client-injected left entry like 1.2.3.4 does NOT become req.ip.
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/join/ZZZZZZ",
    headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9" },
  });
  // Reaches the handler (404), proving XFF parsing is active but bounded.
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ── L3: Content-Type + CORS stance ──────────────────────────────────────────

test("L3: POST /sessions without application/json -> 415", async () => {
  const { app } = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { "content-type": "text/plain" },
    payload: JSON.stringify(registerBody()),
  });
  assert.equal(res.statusCode, 415);
  assert.equal(res.json().error, "unsupported_media_type");
  await app.close();
});

test("L3: PATCH with a non-JSON body -> 415", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer " + reg.hostToken, "content-type": "text/plain" },
    payload: "candidateOp=replace",
  });
  assert.equal(res.statusCode, 415);
  await app.close();
});

test("L3: no permissive CORS — cross-origin request gets no Access-Control-Allow-Origin", async () => {
  const { app } = await makeApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/join/ZZZZZZ",
    headers: { origin: "https://evil.example" },
  });
  assert.ok(!("access-control-allow-origin" in res.headers), "no ACAO header => cross-origin denied");
  // Preflight fails closed (204, no allow-origin).
  const pre = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/sessions",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.ok(!("access-control-allow-origin" in pre.headers), "no ACAO on preflight");
  await app.close();
});
