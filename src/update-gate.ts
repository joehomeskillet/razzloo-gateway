// Update-gate decision (§14, F3). The gateway is the decision authority +
// kill-switch + staged-rollout point. It hosts/proxies/redirects NO binaries —
// there are NO /:asset or latest.yml endpoints. JSON decision only.

import { config } from "./config.js";

export interface ChannelConfig {
  latestVersion: string;
  // killSwitch: when true, everyone gets "hold" regardless of version.
  killSwitch: boolean;
  // minVersion: clients at or above this get "go"; below get "hold" (staged
  // rollout / version floor). Compared with simple semver-ish ordering.
  minVersion: string;
  notes?: string;
}

// Simple in-process channel config (a config file / systemd env in prod).
// Flip killSwitch / bump minVersion to control rollout — no client change.
export const channels: Record<string, ChannelConfig> = {
  stable: {
    latestVersion: process.env.STABLE_LATEST_VERSION ?? "0.4.3",
    killSwitch: process.env.STABLE_KILL_SWITCH === "1",
    minVersion: process.env.STABLE_MIN_VERSION ?? "0.0.0",
    notes: process.env.STABLE_NOTES ?? "Fixes UPnP candidate ordering.",
  },
  beta: {
    latestVersion: process.env.BETA_LATEST_VERSION ?? "0.5.0-beta.1",
    killSwitch: process.env.BETA_KILL_SWITCH === "1",
    minVersion: process.env.BETA_MIN_VERSION ?? "0.0.0",
    notes: process.env.BETA_NOTES,
  },
};

export interface UpdateDecision {
  decision: "go" | "hold";
  latestVersion: string;
  notes?: string;
  repo: typeof config.repo;
}

// Parse "0.4.2" / "0.5.0-beta.1" loosely into comparable numeric tuple.
function parseVersion(v: string): number[] {
  const core = v.split("-")[0] ?? "0";
  return core.split(".").map((n) => {
    const x = Number(n);
    return Number.isFinite(x) ? x : 0;
  });
}

function gte(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true; // equal
}

export function decide(channel: string, appVersion: string): UpdateDecision {
  const ch = channels[channel]!; // caller guarantees channel exists
  const go = !ch.killSwitch && gte(appVersion, ch.minVersion);
  const decision: UpdateDecision = {
    decision: go ? "go" : "hold",
    latestVersion: ch.latestVersion,
    repo: config.repo,
  };
  if (ch.notes) decision.notes = ch.notes;
  return decision;
}
