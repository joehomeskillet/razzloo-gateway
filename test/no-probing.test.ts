// S2 / §4 — the gateway NEVER opens an outbound socket to a candidate. We assert
// this by monkeypatching the network primitives and exercising the full flow:
// register a candidate, resolve it, fetch the QR. If any outbound connection is
// attempted to a candidate host, the test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { makeApp, register } from "./helpers.js";

test("zero outbound socket / fetch / DNS toward a candidate during the full flow", async () => {
  const outbound: string[] = [];

  const origHttpReq = http.request;
  const origHttpsReq = https.request;
  const origConnect = net.Socket.prototype.connect;
  const origFetch = globalThis.fetch;
  const origLookup = dns.lookup;

  // Trap anything that would touch the network.
  (http as unknown as { request: unknown }).request = (...a: unknown[]) => {
    outbound.push("http.request " + JSON.stringify(a[0]));
    throw new Error("gateway must not make outbound http requests");
  };
  (https as unknown as { request: unknown }).request = (...a: unknown[]) => {
    outbound.push("https.request " + JSON.stringify(a[0]));
    throw new Error("gateway must not make outbound https requests");
  };
  (net.Socket.prototype as unknown as { connect: unknown }).connect = function (
    this: net.Socket,
    ...a: unknown[]
  ) {
    outbound.push("socket.connect " + JSON.stringify(a[0]));
    throw new Error("gateway must not open outbound sockets to candidates");
  };
  (globalThis as unknown as { fetch: unknown }).fetch = (...a: unknown[]) => {
    outbound.push("fetch " + String(a[0]));
    throw new Error("gateway must not fetch candidates");
  };
  (dns as unknown as { lookup: unknown }).lookup = ((...a: unknown[]) => {
    outbound.push("dns.lookup " + String(a[0]));
    const cb = a[a.length - 1];
    if (typeof cb === "function") (cb as (e: Error | null) => void)(new Error("no dns"));
  }) as unknown;

  try {
    const { app } = await makeApp();
    // full exercise: register (validates url, no fetch), resolve, QR render
    const reg = (
      await register(app, {
        hostId: "h_9f3c2a1b7e4d8051",
        protocolVersion: 1,
        appVersion: "0.4.2",
        candidates: [
          { kind: "lan", url: "http://192.168.1.42:7777", priority: 0, verified: false },
          { kind: "public-ipv4", url: "http://8.8.8.8:7777", priority: 10, verified: false },
        ],
      })
    ).json();

    const resolve = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode });
    assert.equal(resolve.statusCode, 200);

    const qr = await app.inject({ method: "GET", url: "/j/" + reg.joinCode + "/qr.svg" });
    assert.equal(qr.statusCode, 200);
    assert.match(qr.body, /<svg/);

    const page = await app.inject({ method: "GET", url: "/j/" + reg.joinCode });
    assert.equal(page.statusCode, 200);

    await app.close();
  } finally {
    http.request = origHttpReq;
    https.request = origHttpsReq;
    net.Socket.prototype.connect = origConnect;
    globalThis.fetch = origFetch;
    (dns as unknown as { lookup: unknown }).lookup = origLookup;
  }

  assert.deepEqual(
    outbound,
    [],
    "gateway opened an outbound connection toward a candidate: " + outbound.join(", "),
  );
});

test("/j page never fetch-probes http candidates (no fetch of candidate urls in bootstrap)", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const page = await app.inject({ method: "GET", url: "/j/" + reg.joinCode });
  // C1: the page no longer inlines its script — the bootstrap is the same-origin
  // static /j/app.js (CSP script-src 'self'). Probe-avoidance is asserted there.
  const js = (await app.inject({ method: "GET", url: "/j/app.js" })).body;
  const html = page.body;
  assert.ok(html.includes("/j/app.js"), "HTML loads the same-origin bootstrap");
  assert.ok(js.includes("/api/v1/join/"), "bootstrap resolves via same-origin gateway");
  // Case-INSENSITIVE: a probe of http:// or ws:// in ANY casing must be absent.
  // (The old test was lowercase-only; an attacker controls neither casing here,
  // but the assertion should not be fooled by HTTP://.)
  assert.ok(!/fetch\(\s*['"`]https?:\/\//i.test(js), "no fetch() of an http candidate");
  assert.ok(!/new WebSocket\(\s*['"`]wss?:\/\//i.test(js), "no ws:// probe in bootstrap");
  await app.close();
});
