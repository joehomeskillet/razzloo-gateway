import { buildApp } from "../src/app.js";
import { SessionStore } from "../src/store.js";
import { JoinLockout } from "../src/lockout.js";
import type { FastifyInstance } from "fastify";

export interface Harness {
  app: FastifyInstance;
  store: SessionStore;
  lockout: JoinLockout;
}

// Build an app with rate-limit disabled by default (so functional tests don't
// trip limits); pass enableRateLimit:true for the rate-limit test.
export async function makeApp(opts: { rateLimit?: boolean } = {}): Promise<Harness> {
  const store = new SessionStore();
  const lockout = new JoinLockout();
  const app = await buildApp({
    store,
    lockout,
    enableRateLimit: opts.rateLimit ?? false,
  });
  await app.ready();
  return { app, store, lockout };
}

export function validCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "lan",
    url: "http://192.168.1.42:7777",
    priority: 0,
    verified: false,
    ...overrides,
  };
}

export function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    hostId: "h_9f3c2a1b7e4d8051",
    protocolVersion: 1,
    appVersion: "0.4.2",
    candidates: [validCandidate()],
    ...overrides,
  };
}

export async function register(app: FastifyInstance, body?: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: body ?? registerBody(),
  });
  return res;
}
