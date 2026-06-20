// S1 / F5 — strict allowlist: gameplay keys AND renamed/unknown keys -> 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, register, registerBody } from "./helpers.js";

test("gameplay key on POST -> 400 forbidden_field", async () => {
  const { app } = await makeApp();
  for (const key of ["quiz", "answers", "score", "players", "gameState"]) {
    const res = await register(app, registerBody({ [key]: { foo: 1 } }));
    assert.equal(res.statusCode, 400, `key ${key} should 400`);
    assert.equal(res.json().error, "forbidden_field", `key ${key}`);
    assert.ok(
      (res.json().offendingFields as string[]).includes(key),
      `offendingFields lists ${key}`,
    );
  }
  await app.close();
});

test("RENAMED / unknown key on POST -> 400 (the case a denylist misses)", async () => {
  const { app } = await makeApp();
  // A field a gameplay-name denylist would never list.
  const res = await register(app, registerBody({ qzData_v2: { q: 1 } }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "forbidden_field");
  assert.ok((res.json().offendingFields as string[]).includes("qzData_v2"));
  await app.close();
});

test("unknown key nested inside a candidate -> 400 (deep strict)", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({
      candidates: [
        { kind: "lan", url: "http://192.168.1.42:7777", priority: 0, verified: false, secretGameField: 1 },
      ],
    }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "forbidden_field");
  await app.close();
});

test("valid body -> 201 with joinCode + hostToken, no reflected token leak shape", async () => {
  const { app } = await makeApp();
  const res = await register(app);
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.joinCode, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{6}$/);
  assert.ok(body.hostToken.startsWith("ht_"));
  assert.ok(body.sessionId);
  assert.ok(body.joinUrl.endsWith("/j/" + body.joinCode));
  await app.close();
});
