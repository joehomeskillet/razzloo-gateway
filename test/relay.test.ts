// R0/R1 relay tunnel tests. Exercises the SHARED tunnels map end-to-end
// (P0-1 regression guard), the re-dial clobber fix (P0-2), token-in-header
// security, and the 4401 / 4404 / 404 error paths.
//
// A fresh shared map is injected per harness into BOTH attachRelay() and
// startRelayListener(), exactly mirroring src/server.ts wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { makeApp, registerBody } from "./helpers.js";
import { config } from "../src/config.js";
import {
  attachRelay,
  startRelayListener,
  type Tunnel,
} from "../src/relay/tunnel-server.js";
import type { SessionStore } from "../src/store.js";
import type { FastifyInstance } from "fastify";

// ── small helpers ──────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const closeServer = (server: net.Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

// A relay instance bound to EPHEMERAL ports (port 0). The fixed config.port /
// config.relayPort are avoided so the suite never collides with whatever is
// running on the host. `gwPort` is the bound fastify HTTP port (WS upgrades);
// `relayPort` is the bound raw-TCP player listener port.
interface RelayInstance {
  tunnels: Map<string, Tunnel>;
  relay: net.Server;
  gwPort: number;
  relayPort: number;
}

async function spawnRelay(app: FastifyInstance, store: SessionStore): Promise<RelayInstance> {
  const tunnels = new Map<string, Tunnel>();
  await attachRelay(app, store, config, tunnels);
  // The WS upgrade handler lives on app.server, so the fastify HTTP server must
  // actually be listening (app.inject does not bind a socket). Bind port 0.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const gwPort = (app.server.address() as net.AddressInfo).port;
  // Bind the raw player listener on an ephemeral port via a config override.
  const relay = startRelayListener(store, { ...config, relayPort: 0 }, tunnels);
  await wait(50); // let the net listener bind
  const relayPort = (relay.address() as net.AddressInfo).port;
  return { tunnels, relay, gwPort, relayPort };
}

// Open a CONTROL ws with the host token in the Authorization header (NOT query).
function openControl(gwPort: number, sessionId: string, hostToken: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${gwPort}/relay?sessionId=${sessionId}`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
}

const onceOpen = (ws: WebSocket, label: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error(`${label} open timeout`)), 2000);
  });

// A fake host: holds the CONTROL ws, and on every {t:'open'} dials a DATA ws,
// connects to the fake backend, and bridges raw bytes both directions (mirrors
// the desktop tunnel-client). Returns a close() to tear everything down.
function fakeHost(opts: {
  gwPort: number;
  sessionId: string;
  hostToken: string;
  backendPort: number;
}): { control: WebSocket; close: () => void; ready: Promise<void> } {
  const control = openControl(opts.gwPort, opts.sessionId, opts.hostToken);
  const dataSockets: WebSocket[] = [];
  const locals: net.Socket[] = [];

  control.on("message", (raw: Buffer) => {
    let parsed: { t?: string; stream?: string };
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (parsed.t !== "open" || !parsed.stream) return;

    const dataWs = new WebSocket(
      `ws://127.0.0.1:${opts.gwPort}/relay-data?stream=${parsed.stream}&sessionId=${opts.sessionId}`,
      { headers: { Authorization: `Bearer ${opts.hostToken}` } },
    );
    dataSockets.push(dataWs);

    dataWs.on("open", () => {
      const local = net.connect(opts.backendPort, "127.0.0.1");
      locals.push(local);
      dataWs.on("message", (m: Buffer) => {
        local.write(Buffer.isBuffer(m) ? m : Buffer.from(m as ArrayBuffer));
      });
      local.on("data", (d: Buffer) => dataWs.send(d, { binary: true }));
      local.on("close", () => dataWs.close());
      local.on("error", () => dataWs.close());
      dataWs.on("close", () => local.destroy());
    });
  });

  return {
    control,
    ready: onceOpen(control, "CONTROL"),
    close: () => {
      for (const l of locals) l.destroy();
      for (const d of dataSockets) d.close();
      control.close();
    },
  };
}

// Make a raw TCP player request through the relay and collect the full response.
function playerRoundTrip(relayPort: number, joinCode: string, path = "/ping"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let response = "";
    const sock = net.connect(relayPort, "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${joinCode}.gw\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });
    sock.on("close", () => resolve(response));
    sock.on("error", reject);
    setTimeout(() => reject(new Error("player round-trip timeout")), 3000);
  });
}

// A fake backend HTTP server that answers every request with a fixed body.
async function fakeBackend(body: string): Promise<{ port: number; close: () => void }> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(body.length) });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  return { port, close: () => server.close() };
}

// ── tests ────────────────────────────────────────────────────────────────

test("relay: CONTROL ws accepts valid token (header), rejects bad token (4401)", async () => {
  const { app, store } = await makeApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: registerBody(),
  });
  assert.equal(createRes.statusCode, 201);
  const { sessionId, hostToken } = createRes.json();

  const { relay, gwPort } = await spawnRelay(app, store);

  try {
    // valid token in the Authorization header => opens
    const ws1 = openControl(gwPort, sessionId, hostToken);
    await onceOpen(ws1, "CONTROL valid");
    ws1.close();

    // bad token => closed 4401
    const ws2 = openControl(gwPort, sessionId, "ht_invalid");
    await new Promise<void>((resolve, reject) => {
      ws2.on("close", (code) => {
        assert.equal(code, 4401);
        resolve();
      });
      ws2.on("error", reject);
      setTimeout(() => reject(new Error("CONTROL bad-token close timeout")), 2000);
    });
  } finally {
    await closeServer(relay);
    await app.close();
  }
});

test("relay: missing Authorization header on /relay upgrade => 401, no ws", async () => {
  const { app, store } = await makeApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: registerBody(),
  });
  const { sessionId } = createRes.json();
  const { relay, gwPort } = await spawnRelay(app, store);

  try {
    // No Authorization header at all => the upgrade is rejected with 401 before
    // any ws is established (the client sees an error, never 'open').
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/relay?sessionId=${sessionId}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => reject(new Error("upgrade should NOT succeed without a token")));
      ws.on("error", () => resolve()); // expected: handshake rejected
      ws.on("unexpected-response", () => resolve());
      setTimeout(() => reject(new Error("missing-token timeout")), 2000);
    });
  } finally {
    await closeServer(relay);
    await app.close();
  }
});

test("relay: SHARED map end-to-end — raw TCP player round-trips through fake backend (P0-1)", async () => {
  const { app, store } = await makeApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: registerBody(),
  });
  assert.equal(createRes.statusCode, 201);
  const { sessionId, hostToken, joinCode } = createRes.json();

  const backend = await fakeBackend("PONG-FROM-BACKEND");
  const { tunnels, relay, gwPort, relayPort } = await spawnRelay(app, store);

  const host = fakeHost({ gwPort, sessionId, hostToken, backendPort: backend.port });

  try {
    await host.ready;
    // The control tunnel must be registered in the SHARED map the listener reads.
    assert.ok(tunnels.has(joinCode), "control dial must register in the shared map");

    const response = await playerRoundTrip(relayPort, joinCode, "/ping");

    assert.ok(response.includes("200"), `expected 200 from backend, got:\n${response}`);
    assert.ok(
      response.includes("PONG-FROM-BACKEND"),
      `backend body must round-trip to the raw TCP player, got:\n${response}`,
    );
  } finally {
    host.close();
    await closeServer(relay);
    backend.close();
    await app.close();
  }
});

test("relay: re-dial replaces the tunnel without losing the slot; player still round-trips (P0-2)", async () => {
  const { app, store } = await makeApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: registerBody(),
  });
  const { sessionId, hostToken, joinCode } = createRes.json();

  const backend = await fakeBackend("PONG-AFTER-REDIAL");
  const { tunnels, relay, gwPort, relayPort } = await spawnRelay(app, store);

  // First host dials in.
  const host1 = fakeHost({ gwPort, sessionId, hostToken, backendPort: backend.port });
  await host1.ready;
  const firstTunnel = tunnels.get(joinCode);
  assert.ok(firstTunnel, "first dial must register a tunnel");

  // Second host re-dials the SAME code. attachRelay must close the old control
  // and install the new tunnel BEFORE the old close handler runs; the old
  // handler's identity guard must NOT delete the fresh slot.
  const host2 = fakeHost({ gwPort, sessionId, hostToken, backendPort: backend.port });
  await host2.ready;

  try {
    // Let the old control's async close + its (guarded) teardown settle.
    await wait(200);

    const current = tunnels.get(joinCode);
    assert.ok(current, "slot must survive the re-dial (old close must not delete it)");
    assert.notEqual(current, firstTunnel, "re-dial must install a NEW tunnel object");

    // A player after the re-dial must still round-trip via the new tunnel.
    const response = await playerRoundTrip(relayPort, joinCode, "/after-redial");
    assert.ok(response.includes("200"), `expected 200 after re-dial, got:\n${response}`);
    assert.ok(
      response.includes("PONG-AFTER-REDIAL"),
      `body must round-trip after re-dial, got:\n${response}`,
    );
  } finally {
    host1.close();
    host2.close();
    await closeServer(relay);
    backend.close();
    await app.close();
  }
});

test("relay: raw TCP with unknown host code => 404", async () => {
  const { app, store } = await makeApp();
  const { relay, relayPort } = await spawnRelay(app, store);

  try {
    const response = await playerRoundTrip(relayPort, "UNKNOWNCODE", "/");
    assert.ok(response.includes("404"), `expected 404 for unknown code, got:\n${response}`);
  } finally {
    await closeServer(relay);
    await app.close();
  }
});

test("relay: DATA ws with missing stream token => 4404", async () => {
  const { app, store } = await makeApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: registerBody(),
  });
  const { sessionId, hostToken } = createRes.json();
  const { relay, gwPort } = await spawnRelay(app, store);

  // Need an OPEN control tunnel so the data-ws reaches the stream lookup.
  const control = openControl(gwPort, sessionId, hostToken);
  await onceOpen(control, "CONTROL");

  try {
    const dataWs = new WebSocket(
      `ws://127.0.0.1:${gwPort}/relay-data?stream=fake-token&sessionId=${sessionId}`,
      { headers: { Authorization: `Bearer ${hostToken}` } },
    );
    await new Promise<void>((resolve, reject) => {
      dataWs.on("close", (code) => {
        assert.equal(code, 4404);
        resolve();
      });
      dataWs.on("error", reject);
      setTimeout(() => reject(new Error("DATA close timeout")), 2000);
    });
  } finally {
    control.close();
    await closeServer(relay);
    await app.close();
  }
});

test("relay: store delete tears down the tunnel (onExpire) — player then 404s (P0-3)", async () => {
  const { app, store } = await makeApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: registerBody(),
  });
  const { sessionId, hostToken, joinCode } = createRes.json();

  const backend = await fakeBackend("PONG");
  const { tunnels, relay, gwPort, relayPort } = await spawnRelay(app, store);
  const host = fakeHost({ gwPort, sessionId, hostToken, backendPort: backend.port });
  await host.ready;

  try {
    assert.ok(tunnels.has(joinCode), "tunnel registered before delete");

    // Unregister the session in the store -> onExpire must tear the tunnel down.
    store.delete(sessionId);
    await wait(100);

    assert.ok(!tunnels.has(joinCode), "onExpire must remove the tunnel from the shared map");

    const response = await playerRoundTrip(relayPort, joinCode, "/gone");
    assert.ok(response.includes("404"), `expected 404 after teardown, got:\n${response}`);
  } finally {
    host.close();
    await closeServer(relay);
    backend.close();
    await app.close();
  }
});
