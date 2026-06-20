// Entrypoint: build the app, start the background sweep, listen.

import { buildApp } from "./app.js";
import { SessionStore } from "./store.js";
import { JoinLockout } from "./lockout.js";
import { config } from "./config.js";

const store = new SessionStore();
const lockout = new JoinLockout();

// buildApp() now wires the store sweep + lockout prune itself (M2), and tears
// them down on app.close(). startSweep() is idempotent if called twice.
const app = await buildApp({ store, lockout });

const shutdown = async (signal: string) => {
  void signal;
  await app.close(); // triggers onClose: stopSweep + clear prune timer
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`razzloo-gateway listening on ${config.host}:${config.port}`);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("failed to start", err);
  process.exit(1);
}
