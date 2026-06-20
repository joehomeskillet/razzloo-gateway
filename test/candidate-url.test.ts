// F6 / §6.1 — write-time candidate.url validation (validation, NOT probing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, register, registerBody, validCandidate } from "./helpers.js";

test("public-* candidate with a private IP -> 400 invalid_candidate_url", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({
      candidates: [validCandidate({ kind: "public-ipv4", url: "http://192.168.1.5:7777" })],
    }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_candidate_url");
  await app.close();
});

test("public-ipv4 candidate pointing at loopback -> 400", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "public-ipv4", url: "http://127.0.0.1:7777" })] }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_candidate_url");
  await app.close();
});

test("public-ipv4 candidate at cloud metadata 169.254.169.254 -> 400", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "public-ipv4", url: "http://169.254.169.254:80" })] }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_candidate_url");
  await app.close();
});

test("javascript: candidate.url -> 400 invalid_candidate_url", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({ candidates: [validCandidate({ url: "javascript:alert(1)" })] }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_candidate_url");
  await app.close();
});

test("file: and data: schemes -> 400", async () => {
  const { app } = await makeApp();
  for (const url of ["file:///etc/passwd", "data:text/html,<script>1</script>"]) {
    const res = await register(app, registerBody({ candidates: [validCandidate({ url })] }));
    assert.equal(res.statusCode, 400, `scheme of ${url}`);
    assert.equal(res.json().error, "invalid_candidate_url");
  }
  await app.close();
});

test("lan candidate with a PUBLIC host -> 400 (lan must be RFC1918/link-local)", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "lan", url: "http://203.0.113.7:7777" })] }),
  );
  // 203.0.113/24 is TEST-NET (reserved) -> not a valid lan range -> reject.
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_candidate_url");
  await app.close();
});

test("lan candidate with RFC1918 host -> 201", async () => {
  const { app } = await makeApp();
  for (const url of [
    "http://10.0.0.5:7777",
    "http://172.16.3.4:7777",
    "http://192.168.1.42:7777",
    "http://169.254.10.10:7777",
  ]) {
    const res = await register(app, registerBody({ candidates: [validCandidate({ kind: "lan", url })] }));
    assert.equal(res.statusCode, 201, `lan url ${url} should pass`);
  }
  await app.close();
});

test("public-ipv4 with a genuine public IP -> 201", async () => {
  const { app } = await makeApp();
  const res = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "public-ipv4", url: "http://8.8.8.8:7777" })] }),
  );
  assert.equal(res.statusCode, 201);
  await app.close();
});

test("public-ipv6 with a global v6 -> 201; ULA fc00::/7 -> 400", async () => {
  const { app } = await makeApp();
  const ok = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "public-ipv6", url: "http://[2606:4700:4700::1111]:7777" })] }),
  );
  assert.equal(ok.statusCode, 201);
  const bad = await register(
    app,
    registerBody({ candidates: [validCandidate({ kind: "public-ipv6", url: "http://[fc00::1]:7777" })] }),
  );
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_candidate_url");
  await app.close();
});

test("url with userinfo / path / query rejected (host:port only)", async () => {
  const { app } = await makeApp();
  for (const url of [
    "http://user:pass@192.168.1.5:7777",
    "http://192.168.1.5:7777/admin",
    "http://192.168.1.5:7777/?x=http://evil",
  ]) {
    const res = await register(app, registerBody({ candidates: [validCandidate({ kind: "lan", url })] }));
    assert.equal(res.statusCode, 400, `url ${url}`);
    assert.equal(res.json().error, "invalid_candidate_url");
  }
  await app.close();
});
