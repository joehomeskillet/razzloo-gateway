// Entrypoint: build the app, start the background sweep, listen.

import { buildApp } from "./app.js";
import { SessionStore } from "./store.js";
import { JoinLockout } from "./lockout.js";
import { config } from "./config.js";
import { UptimeRecorder, type SampleStatus } from "./uptime.js";
import { attachRelay, startRelayListener, type Tunnel } from "./relay/tunnel-server.js";
import type net from "node:net";

const store = new SessionStore();
const lockout = new JoinLockout();

// P0-1: ONE shared tunnels map, passed by reference into BOTH the WS upgrade
// handler (attachRelay) and the raw TCP player listener (startRelayListener).
// Declared BEFORE buildApp so its .size feeds the public stats route.
const tunnels = new Map<string, Tunnel>();

// Status-page uptime recorder. sample() reports each component's current health;
// it folds into per-UTC-day rollups persisted under config.stateDir (best-effort,
// never fatal). Honest: 'relay-public' is DEGRADED until the *.gw wildcard TLS
// is deployed (config.relayPublicReady).
const uptime = new UptimeRecorder({
  stateDir: config.stateDir,
  sample: (): Record<string, SampleStatus> => ({
    rendezvous: "operational",
    "relay-control": config.relayEnabled ? "operational" : "maintenance",
    "relay-public": config.relayPublicReady ? "operational" : "degraded",
  }),
});
uptime.start();

// buildApp() now wires the store sweep + lockout prune itself (M2), and tears
// them down on app.close(). startSweep() is idempotent if called twice.
const app = await buildApp({
  store,
  lockout,
  getLiveTunnels: () => tunnels.size,
  uptime,
});

// Stop the recorder (and flush) when the app closes (best-effort).
app.addHook("onClose", async () => {
  uptime.stop();
});

// Wire the relay tunnel if enabled
let relayServer: net.Server | undefined;
if (config.relayEnabled) {
  await attachRelay(app, store, config, tunnels);
}

const shutdown = async (signal: string) => {
  void signal;
  if (relayServer) {
    relayServer.close();
  }
  await app.close(); // triggers onClose: stopSweep + clear prune timer
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`razzloo-gateway listening on ${config.host}:${config.port}`);

  // Start relay listener after the fastify server is listening
  if (config.relayEnabled) {
    relayServer = startRelayListener(store, config, tunnels);
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("failed to start", err);
  process.exit(1);
}
