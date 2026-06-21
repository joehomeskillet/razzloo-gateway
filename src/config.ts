// Operational config (§12, §14). Override via env; sensible MVP defaults.

const num = (v: string | undefined, d: number): number =>
  v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;

const bool = (v: string | undefined, d: boolean): boolean => {
  if (v === undefined) return d;
  const lower = v.toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
};

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? "127.0.0.1",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://gw.razzoozle.xyz",

  // Relay tunnel (R0 contract + R1 hardening §A).
  relayPort: num(process.env.RELAY_PORT, 8788),
  relayEnabled: bool(process.env.RELAY_ENABLED, true),
  // Per-session cap on parked (un-claimed) player streams; new player conns are
  // rejected with HTTP 503 once exceeded (§A P1 fairness/leak guard).
  relayMaxPendingStreams: num(process.env.RELAY_MAX_PENDING_STREAMS, 64),
  // Park window: a player conn waits this long for its DATA ws before 504.
  relayParkMs: num(process.env.RELAY_PARK_MS, 10 * 1000),

  // TTL / heartbeat / offline (§12), in milliseconds.
  ttlMs: num(process.env.SESSION_TTL_MS, 30 * 60 * 1000), // 30 min
  offlineGraceMs: num(process.env.OFFLINE_GRACE_MS, 90 * 1000), // 90 s
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 15 * 1000),

  // Body size cap (§11 checklist: <= 4 KB).
  bodyLimitBytes: num(process.env.BODY_LIMIT_BYTES, 4 * 1024),

  // Join brute-force lockout (§13).
  joinMissThreshold: num(process.env.JOIN_MISS_THRESHOLD, 10),
  joinLockoutWindowMs: num(process.env.JOIN_LOCKOUT_WINDOW_MS, 5 * 60 * 1000),
  joinLockoutMs: num(process.env.JOIN_LOCKOUT_MS, 10 * 60 * 1000),

  repo: "joehomeskillet/razzoozle-desktop" as const,
};

export type Config = typeof config;
