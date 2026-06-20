// Operational config (§12, §14). Override via env; sensible MVP defaults.

const num = (v: string | undefined, d: number): number =>
  v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? "127.0.0.1",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://gw.razzoozle.xyz",

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
