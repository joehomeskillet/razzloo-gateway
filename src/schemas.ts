import { z } from "zod";
import { validateCandidateUrl } from "./url-validation.js";

// ── Enums (protocol §2.1, §2.2) ─────────────────────────────────────────────

export const HostCandidateKind = z.enum([
  "lan",
  "public-ipv4",
  "public-ipv6",
  "upnp",
  "manual",
]);
export type HostCandidateKind = z.infer<typeof HostCandidateKind>;

export const SessionStatus = z.enum(["waiting", "online", "offline", "expired"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// Join-code alphabet (protocol §10): unambiguous, 32 symbols, 6 chars.
export const JOIN_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ2-9]{6}$/;

// ── HostCandidate (request shape — strict allowlist, §2.1 / §2.3) ────────────
// `.strict()` => any unknown nested key is a hard reject (F5).
// `id` is optional on input; server fills one if absent.
export const HostCandidateInput = z
  .object({
    id: z.string().uuid().optional(),
    kind: HostCandidateKind,
    url: z.string().url().max(2048),
    priority: z.number().int().min(0).max(100),
    observedFrom: z.enum(["host", "stun", "upnp", "manual"]).optional(),
    verified: z.boolean(),
    lastVerifiedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    // F6: write-time URL validation, keyed off kind. Validation, NOT probing.
    const err = validateCandidateUrl(c.url, c.kind);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: err });
    }
  });
export type HostCandidateInput = z.infer<typeof HostCandidateInput>;

// ── Stored / response candidate (server-side, all fields present) ───────────
export interface StoredCandidate {
  id: string;
  kind: HostCandidateKind;
  url: string;
  priority: number;
  observedFrom?: "host" | "stun" | "upnp" | "manual";
  verified: boolean;
  lastVerifiedAt?: string;
}

// ── POST /api/v1/sessions register body (strict allowlist, §5 / §9) ─────────
export const RegisterBody = z
  .object({
    hostId: z.string().min(8).max(128),
    protocolVersion: z.number().int(),
    appVersion: z.string().max(32),
    candidates: z.array(HostCandidateInput).min(1).max(8),
  })
  .strict();
export type RegisterBody = z.infer<typeof RegisterBody>;

// ── PATCH /api/v1/sessions/:id body (strict allowlist, §6 / §9) ─────────────
export const PatchBody = z
  .object({
    candidateOp: z.enum(["replace", "add"]).optional(),
    candidates: z.array(HostCandidateInput).min(1).max(8).optional(),
  })
  .strict();
export type PatchBody = z.infer<typeof PatchBody>;

// ── Update channel param (§14.1) ────────────────────────────────────────────
export const UpdateChannel = z.enum(["stable", "beta"]);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

export const SUPPORTED_PROTOCOL_VERSIONS = new Set<number>([1]);
