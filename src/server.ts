// Entrypoint: build the app, start the background sweep, listen.

import { buildApp } from "./app.js";
import { SessionStore } from "./store.js";
import { JoinLockout } from "./lockout.js";
import { config } from "./config.js";

const store = new SessionStore();
const lockout = new JoinLockout();
store.startSweep();
setInterval(() => lockout.prune(), config.sweepIntervalMs).unref();

const app = await buildApp({ store, lockout });

const shutdown = async (signal: string) => {
  store.stopSweep();
  await app.close();
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
