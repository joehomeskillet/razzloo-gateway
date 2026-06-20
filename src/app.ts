// Fastify app factory. buildApp() returns a configured (not-yet-listening)
// instance so tests can use app.inject(). All routes implement protocol.md
// exactly. The gateway NEVER fetches/probes a candidate URL — there is no
// outbound HTTP client anywhere in this file or its imports (S2/SSRF).

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";

import { config } from "./config.js";
import {
  RegisterBody,
  PatchBody,
  UpdateChannel,
  SUPPORTED_PROTOCOL_VERSIONS,
  JOIN_CODE_RE,
  type StoredCandidate,
} from "./schemas.js";
import { SessionStore, type SessionRecord } from "./store.js";
import { JoinLockout } from "./lockout.js";
import { channels, decide } from "./update-gate.js";
import { renderJoinPage } from "./join-page.js";
import { qrSvg } from "./qr.js";
import { codeHash } from "./log.js";
import { randomUUID } from "node:crypto";

export interface AppDeps {
  store?: SessionStore;
  lockout?: JoinLockout;
  enableRateLimit?: boolean;
}

// Map a zod error to a protocol error code. Unknown-key issues => forbidden_field.
function zodToError(err: ZodError): {
  error: string;
  offendingFields?: string[];
  message: string;
} {
  const unknownKeys: string[] = [];
  let badUrl = false;
  for (const issue of err.issues) {
    if (issue.code === "unrecognized_keys") {
      unknownKeys.push(...(issue as { keys: string[] }).keys);
    }
    if (issue.path[issue.path.length - 1] === "url") badUrl = true;
  }
  if (unknownKeys.length > 0) {
    return {
      error: "forbidden_field",
      offendingFields: unknownKeys,
      message:
        "The gateway is rendezvous-only and accepts only its declared fields.",
    };
  }
  if (badUrl) {
    return { error: "invalid_candidate_url", message: "A candidate url failed write-time validation." };
  }
  return { error: "invalid_body", message: "Request body failed schema validation." };
}

// Normalize a validated input candidate into a stored candidate (fill id).
function toStored(c: {
  id?: string;
  kind: StoredCandidate["kind"];
  url: string;
  priority: number;
  observedFrom?: StoredCandidate["observedFrom"];
  verified: boolean;
  lastVerifiedAt?: string;
}): StoredCandidate {
  const out: StoredCandidate = {
    id: c.id ?? randomUUID(),
    kind: c.kind,
    url: c.url,
    priority: c.priority,
    verified: c.verified,
  };
  if (c.observedFrom !== undefined) out.observedFrom = c.observedFrom;
  if (c.lastVerifiedAt !== undefined) out.lastVerifiedAt = c.lastVerifiedAt;
  return out;
}

// Session -> response body (NEVER includes hostToken / hostTokenHash, §11).
function sessionView(rec: SessionRecord) {
  return {
    sessionId: rec.sessionId,
    joinCode: rec.joinCode,
    hostId: rec.hostId,
    protocolVersion: rec.protocolVersion,
    appVersion: rec.appVersion,
    createdAt: new Date(rec.createdAt).toISOString(),
    expiresAt: new Date(rec.expiresAt).toISOString(),
    lastHeartbeatAt: new Date(rec.lastHeartbeatAt).toISOString(),
    status: rec.status,
    candidates: rec.candidates,
  };
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t === "" ? null : t;
}

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const store = deps.store ?? new SessionStore();
  const lockout = deps.lockout ?? new JoinLockout();
  const enableRateLimit = deps.enableRateLimit ?? true;

  const app = Fastify({
    logger: false,
    bodyLimit: config.bodyLimitBytes, // body size cap (§11)
    trustProxy: true, // behind Caddy — use X-Forwarded-For for client IP
  });

  if (enableRateLimit) {
    await app.register(rateLimit, {
      global: false, // per-route opt-in
      keyGenerator: (req) => req.ip,
      // Emit the protocol's error shape + Retry-After (§13).
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: "rate_limited",
        message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      }),
    });
  }

  // Reject non-JSON bodies on mutate is implicit (Fastify content-type parser).
  // Body-too-large -> 413 from Fastify automatically.

  const rl = (max: number, timeWindow: string): { rateLimit?: { max: number; timeWindow: string } } =>
    enableRateLimit ? { rateLimit: { max, timeWindow } } : {};

  // ── POST /api/v1/sessions (§5) ────────────────────────────────────────────
  app.post(
    "/api/v1/sessions",
    { config: rl(10, "10 minutes") },
    async (req, reply) => {
      const parsed = RegisterBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(zodToError(parsed.error));
      }
      const body = parsed.data;
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(body.protocolVersion)) {
        return reply
          .code(400)
          .send({ error: "unsupported_protocol_version", message: "protocolVersion not supported." });
      }
      const candidates = body.candidates.map(toStored);
      const { record, rawToken } = store.create({
        hostId: body.hostId,
        protocolVersion: body.protocolVersion,
        appVersion: body.appVersion,
        candidates,
      });
      req.log?.info?.({ codeHash: codeHash(record.joinCode), outcome: "registered" });
      return reply.code(201).send({
        sessionId: record.sessionId,
        joinCode: record.joinCode,
        joinUrl: `${config.publicBaseUrl}/j/${record.joinCode}`,
        expiresAt: new Date(record.expiresAt).toISOString(),
        hostToken: rawToken, // shown ONCE; never persisted raw, never re-returned
        protocolVersion: record.protocolVersion,
      });
    },
  );

  // ── PATCH /api/v1/sessions/:id (§6) ───────────────────────────────────────
  app.patch<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    { config: rl(4, "1 minute") },
    async (req, reply) => {
      const token = bearer(req);
      if (token === null) {
        return reply.code(401).send({ error: "missing_token", message: "Authorization Bearer token required." });
      }
      const rec = store.getById(req.params.sessionId);
      // Refresh + treat expired as not found (§12).
      if (rec) store.refreshStatus(rec, Date.now());
      if (!rec || rec.status === "expired") {
        // Don't leak existence: a valid-looking token against an unknown session
        // still returns 404. (Token check happens only for an existing session.)
        return reply.code(404).send({ error: "session_not_found", message: "Unknown or expired session." });
      }
      if (!store.tokenMatches(rec, token)) {
        return reply.code(403).send({ error: "token_mismatch", message: "Token does not own this session." });
      }

      const parsed = PatchBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(zodToError(parsed.error));
      }
      const body = parsed.data;

      let nextCandidates: StoredCandidate[] | null = null;
      if (body.candidateOp === "replace") {
        if (!body.candidates) {
          return reply.code(400).send({ error: "invalid_body", message: "replace requires candidates." });
        }
        nextCandidates = body.candidates.map(toStored);
      } else if (body.candidateOp === "add") {
        if (!body.candidates) {
          return reply.code(400).send({ error: "invalid_body", message: "add requires candidates." });
        }
        // upsert by id
        const byId = new Map(rec.candidates.map((c) => [c.id, c]));
        for (const c of body.candidates.map(toStored)) byId.set(c.id, c);
        nextCandidates = [...byId.values()].slice(0, 8);
      } // omitted => pure heartbeat

      store.heartbeat(rec, nextCandidates);
      req.log?.info?.({ codeHash: codeHash(rec.joinCode), outcome: "heartbeat" });
      return reply.code(200).send(sessionView(rec));
    },
  );

  // ── DELETE /api/v1/sessions/:id (§6) ──────────────────────────────────────
  app.delete<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    { config: rl(10, "1 minute") },
    async (req, reply) => {
      const token = bearer(req);
      if (token === null) {
        return reply.code(401).send({ error: "missing_token", message: "Authorization Bearer token required." });
      }
      const rec = store.getById(req.params.sessionId);
      if (!rec) {
        return reply.code(204).send(); // idempotent
      }
      if (!store.tokenMatches(rec, token)) {
        return reply.code(403).send({ error: "token_mismatch", message: "Token does not own this session." });
      }
      store.delete(rec.sessionId);
      return reply.code(204).send();
    },
  );

  // ── GET /api/v1/join/:code (§7) — resolve, no probing ─────────────────────
  app.get<{ Params: { joinCode: string } }>(
    "/api/v1/join/:joinCode",
    { config: rl(60, "1 minute") },
    async (req, reply) => {
      const ip = req.ip;
      if (lockout.isLocked(ip)) {
        reply.header("Retry-After", "600");
        return reply.code(429).send({ error: "rate_limited", message: "Too many failed lookups. Try later." });
      }
      const raw = req.params.joinCode ?? "";
      const code = raw.toUpperCase();
      const rec = JOIN_CODE_RE.test(code) ? store.getLiveByCode(code) : undefined;
      if (!rec) {
        // Wrong AND expired => identical 404, no oracle (§7, F7).
        lockout.recordMiss(ip);
        return reply.code(404).send({ error: "unknown_join_code" });
      }
      lockout.recordHit(ip);
      return reply.code(200).send(joinResolveView(rec));
    },
  );

  // ── GET /j/:code (§8) — human navigation page ─────────────────────────────
  app.get<{ Params: { joinCode: string } }>(
    "/j/:joinCode",
    { config: rl(60, "1 minute") },
    async (req, reply) => {
      // The page is served regardless of code validity; its script resolves via
      // /api/v1/join and shows the same 404 copy. This keeps the HTML cacheable
      // and avoids a second exists-oracle.
      reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(renderJoinPage(req.params.joinCode ?? ""));
    },
  );

  // ── GET /j/:code/qr.svg — same-origin QR for the navigation URL ──────────
  app.get<{ Params: { joinCode: string } }>(
    "/j/:joinCode/qr.svg",
    { config: rl(60, "1 minute") },
    async (req, reply) => {
      const code = (req.params.joinCode ?? "").toUpperCase();
      const rec = JOIN_CODE_RE.test(code) ? store.getLiveByCode(code) : undefined;
      if (!rec || rec.candidates.length === 0) {
        return reply.code(404).send({ error: "unknown_join_code" });
      }
      const sorted = [...rec.candidates].sort((a, b) => a.priority - b.priority);
      reply.header("content-type", "image/svg+xml; charset=utf-8");
      reply.header("cache-control", "no-store");
      return reply.send(await qrSvg(sorted[0]!.url));
    },
  );

  // ── GET /api/v1/update/:channel (§14) — decision only, no binary ──────────
  app.get<{ Params: { channel: string }; Querystring: { appVersion?: string } }>(
    "/api/v1/update/:channel",
    { config: rl(120, "1 minute") },
    async (req, reply) => {
      const ch = UpdateChannel.safeParse(req.params.channel);
      if (!ch.success || !channels[ch.data]) {
        return reply.code(404).send({ error: "unknown_channel" });
      }
      const appVersion = req.query.appVersion ?? "0.0.0";
      return reply.code(200).send(decide(ch.data, appVersion));
    },
  );

  return app;
}

// JoinResolveResponse view (§7): omits hostId / observedFrom / hostToken.
function joinResolveView(rec: SessionRecord) {
  const sorted = [...rec.candidates].sort((a, b) => a.priority - b.priority);
  const candidates = sorted.map((c) => {
    const out: {
      id: string;
      kind: string;
      url: string;
      priority: number;
      verified: boolean;
      lastVerifiedAt?: string;
    } = {
      id: c.id,
      kind: c.kind,
      url: c.url,
      priority: c.priority,
      verified: c.verified,
    };
    if (c.lastVerifiedAt !== undefined) out.lastVerifiedAt = c.lastVerifiedAt;
    return out;
  });
  const message =
    rec.status === "waiting"
      ? "Host registered but no player has connected yet."
      : rec.status === "offline"
        ? "Host stopped responding. Candidates may be stale."
        : null;
  return {
    joinCode: rec.joinCode,
    status: rec.status,
    candidates,
    expiresAt: new Date(rec.expiresAt).toISOString(),
    message,
  };
}
