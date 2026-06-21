// In-memory ephemeral session store (no DB — MVP). Holds metadata +
// HostCandidate[] + host-token HASH (never the raw token, §11). Background sweep
// handles offline transition + hard expiry (§12).

import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config.js";
import type { SessionStatus, StoredCandidate } from "./schemas.js";

export interface SessionRecord {
  sessionId: string;
  joinCode: string;
  hostId: string;
  protocolVersion: number;
  appVersion: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
  lastHeartbeatAt: number; // epoch ms
  status: SessionStatus;
  candidates: StoredCandidate[];
  hostTokenHash: string; // sha256 hex of the raw token
}

const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"; // 32 symbols, §10

function genJoinCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

function genHostToken(): string {
  // ht_ prefix + 32 bytes CSPRNG (256 bits), base64url.
  return "ht_" + randomBytes(32).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class SessionStore {
  private byId = new Map<string, SessionRecord>();
  private byCode = new Map<string, string>(); // joinCode -> sessionId
  private sweepTimer: NodeJS.Timeout | null = null;

  // Optional hook fired with a joinCode whenever its row leaves the store
  // (sweep-reap on expiry OR explicit delete/unregister). The relay binds this
  // to tear down the matching tunnel (close control WS + destroy pending socks)
  // so a session row is never dropped while its tunnel is still open (§A P0-3).
  private onExpire: ((joinCode: string) => void) | null = null;

  setOnExpire(cb: ((joinCode: string) => void) | null): void {
    this.onExpire = cb;
  }

  // ── Create (POST) ─────────────────────────────────────────────────────────
  create(input: {
    hostId: string;
    protocolVersion: number;
    appVersion: string;
    candidates: StoredCandidate[];
  }): { record: SessionRecord; rawToken: string } {
    const now = Date.now();
    const sessionId = randomUUID();

    let joinCode = genJoinCode();
    // Collision check against currently-live codes (§10).
    while (this.byCode.has(joinCode)) joinCode = genJoinCode();

    const rawToken = genHostToken();
    const record: SessionRecord = {
      sessionId,
      joinCode,
      hostId: input.hostId,
      protocolVersion: input.protocolVersion,
      appVersion: input.appVersion,
      createdAt: now,
      expiresAt: now + config.ttlMs,
      lastHeartbeatAt: now,
      status: "waiting",
      candidates: input.candidates,
      hostTokenHash: sha256Hex(rawToken),
    };
    this.byId.set(sessionId, record);
    this.byCode.set(joinCode, sessionId);
    return { record, rawToken };
  }

  // ── Read by id (mutation path; returns even expired so caller decides) ─────
  getById(sessionId: string): SessionRecord | undefined {
    return this.byId.get(sessionId);
  }

  // ── Read by code (join path). Refreshes derived status first. ─────────────
  // Returns undefined for unknown OR expired codes — identical (no oracle, §7).
  getLiveByCode(code: string): SessionRecord | undefined {
    const sessionId = this.byCode.get(code.toUpperCase());
    if (!sessionId) return undefined;
    const rec = this.byId.get(sessionId);
    if (!rec) return undefined;
    this.refreshStatus(rec, Date.now());
    if (rec.status === "expired") return undefined; // tombstoned, withheld
    return rec;
  }

  // ── Heartbeat / candidate mutation (PATCH) ────────────────────────────────
  // `candidates` defaults to null so the relay can slide the TTL on live tunnel
  // traffic via a bare `store.heartbeat(rec)` (no candidate mutation, §A P0-3).
  heartbeat(rec: SessionRecord, candidates: StoredCandidate[] | null = null): void {
    const now = Date.now();
    if (candidates !== null) rec.candidates = candidates;
    rec.lastHeartbeatAt = now;
    rec.expiresAt = now + config.ttlMs; // slide forward
    rec.status = "online";
  }

  delete(sessionId: string): void {
    const rec = this.byId.get(sessionId);
    if (!rec) return;
    const joinCode = rec.joinCode;
    this.byCode.delete(joinCode);
    this.byId.delete(sessionId);
    // Notify the relay AFTER the row is gone so its teardown can't observe a
    // stale live row (and a re-entrant getById returns undefined).
    this.onExpire?.(joinCode);
  }

  // Constant-time token check bound to this session (§11).
  tokenMatches(rec: SessionRecord, rawToken: string): boolean {
    const presented = Buffer.from(sha256Hex(rawToken), "hex");
    const stored = Buffer.from(rec.hostTokenHash, "hex");
    if (presented.length !== stored.length) return false;
    return timingSafeEqual(presented, stored);
  }

  // ── Derived status (§12): waiting/online -> offline -> expired ─────────────
  refreshStatus(rec: SessionRecord, now: number): void {
    if (now > rec.expiresAt) {
      rec.status = "expired";
      return;
    }
    if (rec.status === "expired") return;
    const sinceHeartbeat = now - rec.lastHeartbeatAt;
    if (rec.status === "online" && sinceHeartbeat > config.offlineGraceMs) {
      rec.status = "offline";
    }
  }

  // ── Background sweep: transition + tombstone-reap expired rows (§12) ───────
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), config.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  sweep(): void {
    const now = Date.now();
    // Collect reaped joinCodes first; fire onExpire after mutation completes so
    // the relay teardown runs outside this iteration and observes a clean store.
    const reaped: string[] = [];
    for (const rec of this.byId.values()) {
      this.refreshStatus(rec, now);
      if (rec.status === "expired") {
        // Tombstone reap: drop expired rows entirely (gateway holds no
        // long-term data). A subsequent lookup is then "unknown" === expired.
        this.byCode.delete(rec.joinCode);
        this.byId.delete(rec.sessionId);
        reaped.push(rec.joinCode);
      }
    }
    for (const joinCode of reaped) this.onExpire?.(joinCode);
  }

  size(): number {
    return this.byId.size;
  }
}
