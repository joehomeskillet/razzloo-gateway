// §7, §11, §12 — join resolve, no-oracle 404, host-token auth, heartbeat TTL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, register } from "./helpers.js";

test("wrong code and expired code both -> identical 404 (no oracle, F7)", async () => {
  const { app, store } = await makeApp();
  const reg = (await register(app)).json();

  // wrong / never-registered code
  const wrong = await app.inject({ method: "GET", url: "/api/v1/join/BBBBBB" });
  assert.equal(wrong.statusCode, 404);

  // force the real session to expire, then look it up
  const rec = store.getById(reg.sessionId)!;
  rec.expiresAt = Date.now() - 1;
  const expired = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode });
  assert.equal(expired.statusCode, 404);

  // IDENTICAL status + body
  assert.equal(wrong.statusCode, expired.statusCode);
  assert.deepEqual(wrong.json(), expired.json());
  assert.deepEqual(wrong.json(), { error: "unknown_join_code" });
  await app.close();
});

test("join resolve returns candidates, status, expiresAt; NEVER hostToken/hostId", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const res = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.joinCode, reg.joinCode);
  assert.ok(["waiting", "online", "offline"].includes(body.status));
  assert.ok(Array.isArray(body.candidates) && body.candidates.length === 1);
  // no leaked secret / internal fields anywhere in the response
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("hostToken"));
  assert.ok(!serialized.includes("ht_"));
  assert.ok(!("hostId" in body));
  assert.ok(!("observedFrom" in body.candidates[0]));
  await app.close();
});

test("join is case-insensitive on the code", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const res = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode.toLowerCase() });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("PATCH without host-token -> 401 missing_token", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/sessions/" + reg.sessionId,
    payload: {},
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "missing_token");
  await app.close();
});

test("PATCH with WRONG token for an existing session -> 403 token_mismatch", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer ht_totally_wrong_token_value_aaaaaaaaaaaa" },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "token_mismatch");
  await app.close();
});

test("heartbeat extends TTL and sets status online", async () => {
  const { app, store } = await makeApp();
  const reg = (await register(app)).json();
  const rec = store.getById(reg.sessionId)!;
  const before = rec.expiresAt;
  // wind back so we can observe a forward slide
  rec.expiresAt = Date.now() + 1000;
  rec.lastHeartbeatAt = Date.now() - 5000;
  rec.status = "offline";

  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer " + reg.hostToken },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "online");
  const afterExpiry = new Date(body.expiresAt).getTime();
  assert.ok(afterExpiry > rec.lastHeartbeatAt);
  assert.ok(afterExpiry > Date.now() + 1000, "expiresAt slid forward");
  void before;
  // PATCH response must not include hostToken
  assert.ok(!JSON.stringify(body).includes("ht_"));
  await app.close();
});

test("PATCH candidateOp add merges + re-validates url (poisoned url rejected)", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  // good add
  const ok = await app.inject({
    method: "PATCH",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer " + reg.hostToken },
    payload: {
      candidateOp: "add",
      candidates: [{ kind: "public-ipv4", url: "http://8.8.8.8:7777", priority: 5, verified: false }],
    },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().candidates.length, 2);

  // poisoned add (public-* pointing private) -> 400, re-validated at write time
  const bad = await app.inject({
    method: "PATCH",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer " + reg.hostToken },
    payload: {
      candidateOp: "replace",
      candidates: [{ kind: "public-ipv4", url: "http://10.0.0.9:7777", priority: 0, verified: false }],
    },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_candidate_url");
  await app.close();
});

test("DELETE requires token; idempotent; removes session", async () => {
  const { app } = await makeApp();
  const reg = (await register(app)).json();
  // no token
  const noAuth = await app.inject({ method: "DELETE", url: "/api/v1/sessions/" + reg.sessionId });
  assert.equal(noAuth.statusCode, 401);
  // with token
  const del = await app.inject({
    method: "DELETE",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer " + reg.hostToken },
  });
  assert.equal(del.statusCode, 204);
  // gone -> join 404
  const join = await app.inject({ method: "GET", url: "/api/v1/join/" + reg.joinCode });
  assert.equal(join.statusCode, 404);
  // delete again idempotent
  const again = await app.inject({
    method: "DELETE",
    url: "/api/v1/sessions/" + reg.sessionId,
    headers: { authorization: "Bearer " + reg.hostToken },
  });
  assert.equal(again.statusCode, 204);
  await app.close();
});
