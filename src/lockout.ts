// Per-IP join-miss lockout (§13, F7). Repeated failed join codes from one IP
// trip a temporary lockout — beyond the per-request rate-limit. In-memory.

import { config } from "./config.js";

interface MissState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

export class JoinLockout {
  private byIp = new Map<string, MissState>();

  // Returns true if this IP is currently locked out.
  isLocked(ip: string, now = Date.now()): boolean {
    const s = this.byIp.get(ip);
    if (!s) return false;
    return s.lockedUntil > now;
  }

  // Record a failed (miss) lookup. Trips lockout past the threshold.
  recordMiss(ip: string, now = Date.now()): void {
    let s = this.byIp.get(ip);
    if (!s || now - s.windowStart > config.joinLockoutWindowMs) {
      s = { count: 0, windowStart: now, lockedUntil: 0 };
      this.byIp.set(ip, s);
    }
    s.count += 1;
    if (s.count >= config.joinMissThreshold) {
      s.lockedUntil = now + config.joinLockoutMs;
    }
  }

  // A hit (successful resolve) clears the miss counter for that IP.
  recordHit(ip: string): void {
    this.byIp.delete(ip);
  }

  // Periodic cleanup of stale entries to bound memory.
  prune(now = Date.now()): void {
    for (const [ip, s] of this.byIp.entries()) {
      if (
        s.lockedUntil <= now &&
        now - s.windowStart > config.joinLockoutWindowMs
      ) {
        this.byIp.delete(ip);
      }
    }
  }
}
