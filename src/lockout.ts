// Per-IP join-miss lockout (§13, F7). Repeated failed join codes from one IP
// trip a temporary lockout — beyond the per-request rate-limit. In-memory.

import { config } from "./config.js";

interface MissState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

// Hard cap on tracked IPs (bounded growth, M2). A flood of distinct source IPs
// (spoofed XFF or a botnet) must not grow the map without bound. Map preserves
// insertion order, so on overflow we evict the oldest entry — an approximate
// LRU sufficient for this abuse-mitigation map. Generous vs. realistic IP fan-out.
const MAX_TRACKED_IPS = 50_000;

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
      this.evictIfFull();
      this.byIp.set(ip, s);
    }
    s.count += 1;
    if (s.count >= config.joinMissThreshold) {
      s.lockedUntil = now + config.joinLockoutMs;
    }
  }

  // Bound the map: prune dead entries first, then hard-evict oldest if still full.
  private evictIfFull(): void {
    if (this.byIp.size < MAX_TRACKED_IPS) return;
    this.prune();
    while (this.byIp.size >= MAX_TRACKED_IPS) {
      const oldest = this.byIp.keys().next().value;
      if (oldest === undefined) break;
      this.byIp.delete(oldest);
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
