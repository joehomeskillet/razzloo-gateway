// §13 — per-IP rate-limit (429) + join-miss lockout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./helpers.js";

test("rate-limit returns 429 after threshold (POST /sessions, 10/10min)", async () => {
  const { app } = await makeApp({ rateLimit: true });
  let saw429 = false;
  let lastStatus = 0;
  for (let i = 0; i < 12; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {
        hostId: "h_9f3c2a1b7e4d8051",
        protocolVersion: 1,
        appVersion: "0.4.2",
        candidates: [{ kind: "lan", url: "http://192.168.1.42:7777", priority: 0, verified: false }],
      },
    });
    lastStatus = res.statusCode;
    if (res.statusCode === 429) {
      saw429 = true;
      assert.equal(res.json().error, "rate_limited");
      assert.ok(res.headers["retry-after"], "429 carries Retry-After");
      break;
    }
  }
  assert.ok(saw429, `expected a 429 within 12 requests (last=${lastStatus})`);
  await app.close();
});

test("join lockout: repeated misses from an IP -> locked out with 429", async () => {
  const { app } = await makeApp({ rateLimit: false }); // isolate lockout from token-bucket
  // Default threshold = 10 misses. Hit a wrong code 10 times -> 404, then locked.
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({ method: "GET", url: "/api/v1/join/ZZZZZZ" });
    assert.equal(res.statusCode, 404);
  }
  const locked = await app.inject({ method: "GET", url: "/api/v1/join/ZZZZZZ" });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error, "rate_limited");
  await app.close();
});
