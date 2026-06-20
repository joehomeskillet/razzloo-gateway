# Razzoozle Rendezvous + Update Protocol

**Service:** `gw.razzoozle.xyz` (razzloo-gateway)
**Protocol version:** `1`
**API prefix:** `/api/v1`
**Status:** Phase-0 design contract (FINAL decisions locked)

This document is the wire contract between three parties:

1. **Desktop host** — the Razzoozle Electron client (`razzoozle-desktop`) running on a player's Windows machine. It runs the real game server locally (`@razzoozle/web` + `@razzoozle/socket`) and registers a session with the gateway so other players can find it.
2. **Gateway** — `gw.razzoozle.xyz`, a public rendezvous + update-decision service. It stores **session metadata + host candidate endpoints only**, and answers an **update-gate** decision. It is a discovery + decision authority. It never touches gameplay and never hosts binaries.
3. **Player browser** — a remote player who opens a join link, resolves the session via the gateway, **navigates top-level to the host's own origin**, and then connects **directly** to one of the host's candidate endpoints.

**House stack:** Caddy + Gitea + systemd, self-hosted. No AWS, no Cloudflare, no Vault, no CAPTCHA, no SMS.

---

## 1. Overview — Rendezvous Only

The gateway exists to solve exactly one problem: a player who wants to join a game hosted on someone else's desktop needs to discover **where that host is reachable**. The host machine is behind NAT, may have a LAN address, one or more public addresses, a UPnP-mapped port, or a manually configured tunnel. The gateway is a small, public, always-on directory that maps a short **join code** to a set of **candidate URLs** the host advertised.

What the gateway does:

- Issues a `sessionId` + `joinCode` + `hostToken` when a host registers.
- Stores session metadata and a list of `HostCandidate` endpoints the host *claims* to be reachable on.
- Serves those candidates to a joining player so the player's **browser** can navigate to / try them.
- Tracks liveness via host heartbeats and expires stale sessions.
- Answers an **update-gate decision** (`go`/`hold`) so the client knows whether to update — it is the update **decision authority + kill-switch + staged-rollout point**.

What the gateway **never** does (hard rules):

- **It never carries, stores, proxies, or relays gameplay.** No quiz, questions, answers, players, leaderboard, scores, game state, or WebSocket payloads ever pass through or rest in the gateway. The connection between player and host is **direct, peer-to-peer**, and the gateway is not on that path. (See §9, S1.)
- **It never probes, fetches, pings, or health-checks a candidate URL or host IP.** All reachability testing is done **client-side, in the player's browser** (or by top-level navigation). The gateway treats candidate URLs as opaque strings supplied by the host and never dereferences them. This is a deliberate SSRF-prevention rule. (See §7, S2.)
- **It hosts, proxies, and 302-redirects no binaries.** The update path is a **decision**, not a download. The gateway returns a `go`/`hold` verdict; the client then fetches `latest.yml` + the `.exe` itself, directly from the GitHub Release, via electron-updater's native `github` provider. There are **no** `latest.yml`/`:asset` redirect endpoints. (See §14, D4.)

The trust model: the gateway is **untrusted with gameplay by design**. A compromised gateway can disrupt discovery (deny, mislead) but cannot read or alter a single game answer, because gameplay never flows through it. It can withhold or pin updates (kill-switch) but cannot forge an update, because the client independently verifies the **minisign/Ed25519 signature over `latest.yml`** before applying any update.

---

## 2. Data Model

All shapes below are presented as zod-validatable schemas. They are the canonical definitions; request/response bodies in later sections are instances of these. **All request schemas are `.strict()` (`additionalProperties: false`): any field not named here is a hard `400` (S1, §9).**

### 2.1 `HostCandidate`

A single endpoint the host claims to be reachable on. A session carries **several** of these (S3) — never collapse to a single `internal_ip`/`external_ip` pair.

```ts
import { z } from "zod";

export const HostCandidateKind = z.enum([
  "lan",          // RFC1918 / link-local LAN address, only useful to same-subnet players
  "public-ipv4",  // host's public IPv4 + forwarded port
  "public-ipv6",  // host's global IPv6 + port
  "upnp",         // port opened via UPnP/NAT-PMP on the gateway router
  "manual",       // operator-supplied URL (e.g. a tunnel / DDNS hostname)
]);

export const HostCandidate = z.object({
  id:            z.string().uuid(),                // stable per-candidate id
  kind:          HostCandidateKind,
  url:           z.string().url().max(2048),       // opaque to the gateway; never fetched. Write-time validated, §6.1
  priority:      z.number().int().min(0).max(100), // lower = try first, client-side
  observedFrom:  z.enum(["host", "stun", "upnp", "manual"]).optional(),
  verified:      z.boolean(),                       // CLIENT-set claim; gateway never sets true
  lastVerifiedAt: z.string().datetime().optional(),
}).strict();

export type HostCandidate = z.infer<typeof HostCandidate>;
```

Notes:

- `url` is stored verbatim and returned verbatim. The gateway performs **format + scheme + host/port + IP-range validation** at write time (§6.1) but **no network dereference** (this is validation, not probing — no SSRF).
- `verified` reflects whether a *client* has confirmed reachability. The gateway itself never flips this to `true` (it cannot, because it never probes). It defaults to `false` on registration.
- `priority` is advisory ordering for the client. The client decides the actual try order.

### 2.2 `Session`

```ts
export const SessionStatus = z.enum([
  "waiting",  // registered, no successful client connection observed yet
  "online",   // host heartbeating, recently alive
  "offline",  // heartbeat lapsed past grace window, not yet expired
  "expired",  // past expiresAt; tombstoned, candidates withheld
]);

export const Session = z.object({
  sessionId:       z.string().uuid(),
  joinCode:        z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{6}$/), // see §10
  hostId:          z.string().min(8).max(128),  // stable opaque host install id
  protocolVersion: z.literal(1),
  appVersion:      z.string().max(32),          // e.g. "0.4.2"
  createdAt:       z.string().datetime(),
  expiresAt:       z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
  status:          SessionStatus,
  candidates:      z.array(HostCandidate).min(1).max(8),
}).strict();

export type Session = z.infer<typeof Session>;
```

The `hostToken` (§11) is **never** part of a `Session` returned by a read endpoint. It is issued exactly once at registration and held only by the host.

### 2.3 Strict allowlist (the only accepted fields)

The gateway accepts **only** the union of these fields, and rejects everything else (S1, §9):

- **Client-supplied (request):** `hostId`, `protocolVersion`, `appVersion`, `candidates[]` where each candidate is `{ kind, url, priority, verified, id?, observedFrom?, lastVerifiedAt? }`, plus the request-only control field `candidateOp` on PATCH (§6).
- **Server-issued (response):** `sessionId`, `joinCode`, `hostToken`, `createdAt`, `expiresAt`, `lastHeartbeatAt`, `status`, `joinUrl`.

This is an **allowlist** (`additionalProperties:false` / zod `.strict()`), not a denylist of known gameplay field names. Any unexpected key — gameplay or otherwise — is a `400`.

---

## 3. Endpoint Summary

| Method | Path                                          | Auth        | Purpose                                            |
|--------|-----------------------------------------------|-------------|----------------------------------------------------|
| POST   | `/api/v1/sessions`                            | none        | Register a session, get code + hostToken           |
| PATCH  | `/api/v1/sessions/:sessionId`                 | host-token  | Heartbeat + candidate update/replace               |
| DELETE | `/api/v1/sessions/:sessionId`                 | host-token  | Explicit unregister                                |
| GET    | `/api/v1/join/:joinCode`                      | none        | Resolve code → candidates (no probing)             |
| GET    | `/j/:joinCode`                                | none        | Human join page → top-level navigation to host     |
| GET    | `/api/v1/update/:channel?appVersion=X`        | none        | Update-gate **decision** (`go`/`hold`) — no binary |
| GET    | `/desktop-host/ping`                          | none        | **On the HOST**, liveness self-check               |

`/desktop-host/ping` lives on the **host's local server**, not on the gateway. It is documented here because it is part of the protocol the player browser uses for client-side candidate verification.

**Removed (no longer exist):** `GET /api/v1/update/:channel/latest.yml` and `GET /api/v1/update/:channel/:asset`. The gateway hosts/proxies/redirects no binaries and no `latest.yml`; the `:asset` path-traversal surface is eliminated entirely. (§14)

---

## 4. Versioning

- **Transport version** is pinned in the path: `/api/v1`. Breaking changes ship under `/api/v2`; the gateway may serve both during a migration window.
- **Protocol version** is carried in payloads as `protocolVersion` (currently `1`). The gateway rejects a registration whose `protocolVersion` it does not support with `400 unsupported_protocol_version`.
- A host advertises its `appVersion` (the Electron client build) as metadata for sessions, and supplies it as the `appVersion` query param to the update-gate (§14) so the gateway can make a staged-rollout decision.

---

## 5. POST `/api/v1/sessions` — Register

The host calls this once when the user clicks "Host a game". The host has already started its local game server and gathered its own candidate endpoints (from its own NIC enumeration, optional STUN, optional UPnP mapping). The gateway does **not** discover candidates for the host.

### Request

```http
POST /api/v1/sessions HTTP/1.1
Host: gw.razzoozle.xyz
Content-Type: application/json
```

```json
{
  "hostId": "h_9f3c2a1b7e4d8051",
  "protocolVersion": 1,
  "appVersion": "0.4.2",
  "candidates": [
    {
      "id": "c1d2e3f4-0000-4000-8000-000000000001",
      "kind": "lan",
      "url": "http://192.168.1.42:7777",
      "priority": 0,
      "observedFrom": "host",
      "verified": false
    },
    {
      "id": "c1d2e3f4-0000-4000-8000-000000000002",
      "kind": "public-ipv4",
      "url": "http://203.0.113.7:7777",
      "priority": 10,
      "observedFrom": "stun",
      "verified": false
    },
    {
      "id": "c1d2e3f4-0000-4000-8000-000000000003",
      "kind": "upnp",
      "url": "http://203.0.113.7:51820",
      "priority": 20,
      "observedFrom": "upnp",
      "verified": false
    }
  ]
}
```

Validation: the body is parsed against the **strict allowlist** registration schema = `{ hostId, protocolVersion, appVersion, candidates }` with `.strict()` / `additionalProperties:false` (§9). Any field not in the allowlist — at any nesting depth — causes a hard `400 forbidden_field` reject; the request is **not** sanitized-and-accepted. Each `candidate.url` is additionally validated at write time (§6.1).

### Response — `201 Created`

```json
{
  "sessionId": "8c0b5e2a-3d44-4a9f-9b21-0f7e6c1a55de",
  "joinCode": "K7QPMX",
  "joinUrl": "https://gw.razzoozle.xyz/j/K7QPMX",
  "expiresAt": "2026-06-20T18:42:00.000Z",
  "hostToken": "ht_3a91f0c8d2b74e6f8a05c1d93b2e7f44",
  "protocolVersion": 1
}
```

- `hostToken` is shown **once** and never again. The host stores it in memory for the lifetime of the session and uses it to authenticate PATCH/DELETE. (§11)
- `expiresAt` reflects the initial TTL (§12).

### Errors

| Status | `error`                         | When                                              |
|--------|----------------------------------|---------------------------------------------------|
| 400    | `invalid_body`                   | Schema mismatch (missing/typed fields)            |
| 400    | `unsupported_protocol_version`   | `protocolVersion` not in supported set            |
| 400    | `forbidden_field`                | A field outside the strict allowlist is present (§9) |
| 400    | `too_many_candidates`            | `candidates.length > 8`                           |
| 400    | `invalid_candidate_url`          | A `url` fails write-time validation (§6.1)        |
| 429    | `rate_limited`                   | Registration rate exceeded (§13)                  |

---

## 6. PATCH `/api/v1/sessions/:sessionId` — Heartbeat + Candidate Update

One endpoint serves both liveness (heartbeat) and candidate mutation. The host calls it on a fixed cadence (§12) and additionally whenever its candidate set changes (e.g. UPnP mapping succeeded after registration).

### Auth

`Authorization: Bearer <hostToken>` is required. A missing/invalid token → `401`. A token that does not match this `sessionId` → `403`. (§11)

### Request

`candidateOp` selects the mutation semantics:

- `"replace"` — the supplied `candidates` array becomes the full set.
- `"add"` — supplied candidates are merged by `id` (upsert).
- omitted — pure heartbeat, `candidates` ignored if absent.

```http
PATCH /api/v1/sessions/8c0b5e2a-3d44-4a9f-9b21-0f7e6c1a55de HTTP/1.1
Host: gw.razzoozle.xyz
Authorization: Bearer ht_3a91f0c8d2b74e6f8a05c1d93b2e7f44
Content-Type: application/json
```

```json
{
  "candidateOp": "add",
  "candidates": [
    {
      "id": "c1d2e3f4-0000-4000-8000-000000000004",
      "kind": "public-ipv6",
      "url": "http://[2001:db8::7]:7777",
      "priority": 5,
      "observedFrom": "host",
      "verified": true,
      "lastVerifiedAt": "2026-06-20T18:05:11.000Z"
    }
  ]
}
```

The same strict allowlist (§9) applies to PATCH bodies, and each `candidate.url` is re-validated at write time (§6.1).

### Response — `200 OK`

Returns the full updated `Session` (without `hostToken`):

```json
{
  "sessionId": "8c0b5e2a-3d44-4a9f-9b21-0f7e6c1a55de",
  "joinCode": "K7QPMX",
  "hostId": "h_9f3c2a1b7e4d8051",
  "protocolVersion": 1,
  "appVersion": "0.4.2",
  "createdAt": "2026-06-20T18:12:00.000Z",
  "expiresAt": "2026-06-20T18:47:00.000Z",
  "lastHeartbeatAt": "2026-06-20T18:17:00.000Z",
  "status": "online",
  "candidates": [
    { "id": "c1d2e3f4-0000-4000-8000-000000000001", "kind": "lan", "url": "http://192.168.1.42:7777", "priority": 0, "observedFrom": "host", "verified": false },
    { "id": "c1d2e3f4-0000-4000-8000-000000000002", "kind": "public-ipv4", "url": "http://203.0.113.7:7777", "priority": 10, "observedFrom": "stun", "verified": false },
    { "id": "c1d2e3f4-0000-4000-8000-000000000003", "kind": "upnp", "url": "http://203.0.113.7:51820", "priority": 20, "observedFrom": "upnp", "verified": false },
    { "id": "c1d2e3f4-0000-4000-8000-000000000004", "kind": "public-ipv6", "url": "http://[2001:db8::7]:7777", "priority": 5, "observedFrom": "host", "verified": true, "lastVerifiedAt": "2026-06-20T18:05:11.000Z" }
  ]
}
```

Each successful PATCH bumps `lastHeartbeatAt`, slides `expiresAt` forward by the TTL window, and sets `status` to `online`.

### Errors

| Status | `error`                  | When                                       |
|--------|--------------------------|--------------------------------------------|
| 401    | `missing_token`          | No `Authorization` header                  |
| 403    | `token_mismatch`         | Token does not own this session            |
| 404    | `session_not_found`      | Unknown or already-expired `sessionId`     |
| 400    | `forbidden_field`        | Field outside the strict allowlist (§9)    |
| 400    | `invalid_candidate_url`  | A candidate `url` fails write-time validation (§6.1) |
| 429    | `rate_limited`           | Heartbeat/mutation rate exceeded (§13)     |

### 6.1 Candidate-URL write-time validation (S5 — validation, NOT probing)

On every POST and PATCH, each `candidate.url` is validated **structurally** before persistence. This is parsing/range-checking only — the gateway never opens a socket, so there is no SSRF surface.

Rules:

- **Scheme** must be `http` or `https`. Reject `javascript:`, `file:`, `data:`, `ws:`, `wss:`, `ftp:`, and any other scheme → `400 invalid_candidate_url`.
- **Authority** must be `host:port` only — no userinfo (`user:pass@`), no path beyond `/`, no query, no fragment used to smuggle a second host.
- **`kind: "lan"`** candidates: the host literal must be a private/LAN range — RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, IPv6 `fe80::/10`), or unique-local (`fc00::/7`). A non-private host on a `lan` candidate → reject.
- **`kind: "public-ipv4" | "public-ipv6" | "upnp"`** candidates: the host literal must **not** be private, loopback (`127/8`, `::1`), link-local, or otherwise reserved/special-use. A loopback/private host on a public-* candidate → reject.
- **`kind: "manual"`** candidates: a hostname (DDNS/tunnel) is allowed; if it is an IP literal, the public/private rule for its declared reachability applies. The gateway still never resolves DNS (no probing) — it only checks the literal form.

Validation runs in the zod `superRefine` step keyed off `kind`, before any persistence.

### DELETE `/api/v1/sessions/:sessionId` — Unregister

Same auth (`Authorization: Bearer <hostToken>`). Returns `204 No Content`. Idempotent: deleting an already-gone session returns `204`.

---

## 7. GET `/api/v1/join/:joinCode` — Resolve (No Probing)

Called by the player browser (or the `/j/:joinCode` page's script). Returns the candidate list so the **client** can navigate to / try them. **The gateway performs no reachability check** — it returns exactly what the host advertised, untouched. The `verified`/`lastVerifiedAt` fields reflect prior **client** claims, not gateway probing (S2). The `hostToken` is **never** present in this response (§11, S7).

### Request

```http
GET /api/v1/join/K7QPMX HTTP/1.1
Host: gw.razzoozle.xyz
Accept: application/json
```

### Response — `200 OK` (`JoinResolveResponse`)

```json
{
  "joinCode": "K7QPMX",
  "status": "online",
  "candidates": [
    { "id": "c1d2e3f4-0000-4000-8000-000000000001", "kind": "lan", "url": "http://192.168.1.42:7777", "priority": 0, "verified": false },
    { "id": "c1d2e3f4-0000-4000-8000-000000000004", "kind": "public-ipv6", "url": "http://[2001:db8::7]:7777", "priority": 5, "verified": true, "lastVerifiedAt": "2026-06-20T18:05:11.000Z" },
    { "id": "c1d2e3f4-0000-4000-8000-000000000002", "kind": "public-ipv4", "url": "http://203.0.113.7:7777", "priority": 10, "verified": false },
    { "id": "c1d2e3f4-0000-4000-8000-000000000003", "kind": "upnp", "url": "http://203.0.113.7:51820", "priority": 20, "verified": false }
  ],
  "expiresAt": "2026-06-20T18:47:00.000Z",
  "message": null
}
```

`JoinResolveResponse` schema:

```ts
export const JoinResolveResponse = z.object({
  joinCode:   z.string(),
  status:     SessionStatus,
  candidates: z.array(HostCandidate.pick({
    id: true, kind: true, url: true, priority: true, verified: true, lastVerifiedAt: true,
  })),                          // hostId / observedFrom / hostToken are NOT exposed to joiners
  expiresAt:  z.string().datetime().optional(),
  message:    z.string().nullable().optional(),
});
```

Candidates are returned sorted by `priority` ascending as a hint; the client still owns the actual try order. These URLs are for **top-level navigation** by the joining browser (§8.1), not for an HTTPS page to `fetch()`-probe.

### Non-200 / degraded states

| Status | `status` field | `message`                                                   |
|--------|----------------|-------------------------------------------------------------|
| 200    | `online`       | `null` — candidates present, host alive                     |
| 200    | `waiting`      | "Host registered but no player has connected yet."          |
| 200    | `offline`      | "Host stopped responding. Candidates may be stale." (still returned so the client can try) |
| 404    | —              | `{ "error": "unknown_join_code" }` — wrong or never-registered code |
| 404    | —              | `{ "error": "unknown_join_code" }` — expired code (indistinguishable from wrong code; **no candidates**) |

**Wrong and expired codes are indistinguishable** (S7): both return `404 unknown_join_code` with no candidates. There is no "exists-but-expired" oracle — a dead session must not leak its existence or host addresses.

---

## 8. GET `/j/:joinCode` — Human Join Page (Top-Level Navigation)

A minimal HTML page served by the gateway. It is the link a host shares ("open `https://gw.razzoozle.xyz/j/K7QPMX`"). Its job is to **route the phone to the host's own http origin by top-level navigation** — never to act as an HTTPS page that `fetch()`-probes http candidates (which browsers block; see §8.1).

1. `fetch('/api/v1/join/K7QPMX')` to get the candidate list (same-origin HTTPS call to the gateway — allowed).
2. Present the candidate URL(s) for **top-level navigation**: a clickable link, an automatic redirect (`window.location = <candidate.url>`), and/or a QR code that encodes the candidate URL.
3. The phone **navigates** to `http://<lan-ip>:<port>/...` (or the public/manual candidate). This is a top-level `https://` → `http://` navigation, which browsers **allow**. The host's own page (served over its own http origin) then does same-origin work and opens the game WebSocket directly to the host.
4. On total failure, show fallback instructions ("Make sure you're on the same Wi‑Fi as the host, or ask the host to enable port forwarding.").

The page **embeds no game data** — no quiz, players, or scores. It only orchestrates candidate selection + navigation. It must **not** serve an HTTPS client that `fetch`-probes http candidates.

### 8.1 Mixed-Content + Private-Network-Access (F4)

The gateway is served over HTTPS (`https://gw.razzoozle.xyz`). Browser security forbids an HTTPS page from making **active sub-resource requests** to plaintext http LAN hosts:

- **Mixed Content:** an `https://` page cannot `fetch()` or open `ws://` to an `http://<lan-ip>` host — browsers block active mixed content outright.
- **Private Network Access (Chrome PNA):** a request originating from a public/secure context to a *private* (RFC1918/loopback) address is blocked (public → private).

Therefore the player reaches the host by **top-level navigation to the host's own http origin**, not by probing from the gateway page. The join code resolves to `http://<lan-ip>:<port>/...` and **the phone navigates there**. Top-level `https→http` navigation is permitted; sub-resource `fetch`/`ws` probing of an http candidate from an https page is not. The `/desktop-host/ping` candidate verification (§15) therefore happens **after** the phone has navigated to the host's http origin (same-origin / same-context), not from the gateway's HTTPS page.

For a **LAN** join, the QR code may encode the **host's http URL directly** (`http://192.168.1.42:7777/...`) — the gateway is optional on the LAN path; the phone scans and navigates straight to the host.

### 8.2 Honest residual limits

These configurations will **not** connect in the MVP, and the protocol does not pretend otherwise (there is **no relay** in MVP):

- **Guest / AP-isolated Wi-Fi:** if the access point isolates clients, same-subnet LAN candidates are unreachable even after navigation — nothing the gateway can do.
- **Internet → an http-only host:** a remote player on a different network reaching a host that only advertises plaintext http public candidates will hit mixed-content / browser-trust friction and may not connect; without a public TLS endpoint or a relay there is no clean path.
- **No relay fallback:** the MVP provides discovery only. If no candidate is directly reachable from the joiner's network, the join fails with fallback guidance — the gateway never proxies the connection.

The page shows live status: which candidate is offered, `online`/`offline` from the resolve response, and a manual "try again" / "rescan QR" control.

---

## 9. Strict Allowlist — No Game Data (S1, F5)

The session-register and PATCH schemas are a **strict allowlist** (`additionalProperties:false` / zod `.strict()`), **not a denylist of gameplay field names**. The gateway accepts **only** the fields enumerated in §2.3:

```
hostId, protocolVersion, appVersion,
candidates[].{ kind, url, priority, verified, id?, observedFrom?, lastVerifiedAt? },
candidateOp (PATCH only)
```

plus server-issued response fields (`sessionId`, `joinCode`, `hostToken`, timestamps, `status`, `joinUrl`). **Any other field — at any nesting depth — is rejected with `400 forbidden_field`.** Fields are **rejected, not silently dropped**: there is no path for gameplay (or anything else unexpected) to reach gateway storage. Because it is an allowlist, the gateway is robust against gameplay fields it has never heard of — it does not need to enumerate `quiz`/`players`/`score`/etc.; anything not on the allowlist fails closed.

### Reject response — `400`

```json
{
  "error": "forbidden_field",
  "message": "The gateway is rendezvous-only and accepts only its declared fields.",
  "offendingFields": ["players", "leaderboard"]
}
```

Implementation note: enforce via zod `.strict()` on every object in the schema tree (so nested unknown keys also fail), evaluated **before** any persistence. The strict allowlist is the authoritative mechanism that keeps the gateway gameplay-blind. The `message` field of `JoinResolveResponse` is the **only** free-text field the gateway ever emits, and it is gateway-authored status copy, never host-supplied content.

---

## 10. Join-Code Format + Entropy (S7)

- **Alphabet:** unambiguous consonant/digit set excluding vowels and confusable glyphs (no `A E I O U`, no `0 1 O I L`): `B C D F G H J K L M N P Q R S T V W X Z 2 3 4 5 6 7 8 9` → **32 symbols**.
- **Length:** 6 characters (≥ 6 required).
- **Entropy:** 32⁶ = ~1.07 × 10⁹ combinations (30 bits). With short TTLs (§12), per-IP rate limiting + lockout (§13), and the indistinguishable wrong/expired response (§7), brute-force enumeration of live codes is impractical.
- Vowels are excluded to avoid accidental words; ambiguous characters are excluded for verbal/visual sharing.
- Codes are generated with a CSPRNG, checked against currently-live codes for collision, and regenerated on the rare collision.
- Codes are **case-insensitive** on lookup (normalized to uppercase) and presented uppercase.
- A wrong code and an expired code return the **same** `404 unknown_join_code` (no exists-but-expired oracle, §7).

---

## 11. Host-Token Auth Model (S7)

- At registration the gateway mints a `hostToken`: a high-entropy CSPRNG value, ≥128 bits, prefixed `ht_`. Returned **once** in the POST response; **never** returned by any read endpoint and **never** reflected in any joiner-facing payload (`/api/v1/join`, `/j/`).
- The gateway stores only a **hash** of the token (e.g. SHA-256) keyed to the `sessionId`; the raw token is **not persisted**.
- Host mutations — **PATCH (heartbeat / candidate update) and DELETE (unregister)** — require `Authorization: Bearer <hostToken>` on **every** request. The gateway hashes the presented token and compares to the stored hash for that `sessionId`.
- A token is **bound to exactly one** `sessionId`. Presenting a valid token for the wrong `sessionId` → `403 token_mismatch`.
- Tokens are not refreshable; they live and die with their session. When the session expires or is deleted, the token is worthless.
- Joiners (`/api/v1/join`, `/j/`) need **no** auth — they are read-only discovery, and the token is never visible to them.

---

## 12. TTL / Expiry / Heartbeat / Offline Transition

| Parameter            | Value (MVP)      | Meaning                                                |
|----------------------|------------------|--------------------------------------------------------|
| Initial TTL          | 30 min           | `expiresAt = createdAt + 30m` at registration          |
| Heartbeat cadence    | every 30 s       | Host PATCHes at this interval                           |
| TTL slide on PATCH   | +30 min          | Each heartbeat sets `expiresAt = now + 30m`            |
| Offline grace        | 90 s             | No heartbeat for >90 s → `status: offline`             |
| Hard expiry          | at `expiresAt`   | → `status: expired`, candidates withheld (`404`)       |

State transitions:

```
register ──► waiting ──(first successful client ping reported / heartbeat)──► online
                          │
   online ──(no heartbeat > 90s)──► offline ──(heartbeat resumes)──► online
   offline ──(now > expiresAt)────► expired   (tombstone; candidates withheld)
   online  ──(now > expiresAt)────► expired
   any     ──(DELETE)─────────────► removed
```

- `offline` sessions still return their candidates on `/api/v1/join` (with a stale-warning `message`) so a client can attempt a connection — the host may be reachable even if its heartbeat briefly lapsed.
- `expired` sessions return `404 unknown_join_code` (indistinguishable from a never-registered code, §7) and **no** candidates.
- Expired/tombstoned rows are swept on a periodic timer (house stack: a systemd timer or in-process interval); the gateway holds no long-term session data.

---

## 13. Rate-Limit Summary

Scoped to the house stack (Caddy + the gateway app); no external WAF, no CAPTCHA, no SMS.

| Endpoint                         | Limit (MVP)                  | Keyed by            |
|----------------------------------|------------------------------|---------------------|
| POST `/api/v1/sessions`          | 10 / 10 min                  | source IP           |
| PATCH `/api/v1/sessions/:id`     | 4 / min (≈ 1 per 15 s)       | sessionId + token   |
| DELETE `/api/v1/sessions/:id`    | 10 / min                     | sessionId + token   |
| GET `/api/v1/join/:code`         | 60 / min + lockout           | source IP           |
| GET `/j/:code`                   | 60 / min                     | source IP           |
| GET `/api/v1/update/:channel`    | 120 / min                    | source IP           |

- Exceeded limits return `429 rate_limited` with a `Retry-After` header.
- **Join-code brute force (S7):** `/api/v1/join` enforces a **per-IP rate-limit + lockout** — after a burst of repeated misses (failed codes) from an IP, that IP is locked out for a cooldown window. Combined with the short TTL × 30-bit code space × the indistinguishable wrong/expired response (§7), live-code enumeration is impractical.
- Caddy provides the front-line connection limits; per-route counters + the join lockout live in the gateway app.

---

## 14. Update-Gate — Gateway-as-Gate (F3, D4)

The gateway is the update **decision authority + kill-switch + staged-rollout point**. It is **never** a binary redirect: it hosts no binary, proxies no binary, and 302-redirects no `latest.yml` or asset. The endpoints `…/latest.yml` and `…/:asset` **no longer exist** — the `:asset` path-traversal surface is removed entirely.

Flow:

1. The app calls the **update-gate** for a *decision*.
2. If the decision is `go`, the app uses **electron-updater's native `github` provider** to fetch `latest.yml` + the `.exe` **directly from the GitHub Release**.
3. The app **verifies the minisign/Ed25519 signature over `latest.yml`** client-side **before** applying any update (§14.2). The `.exe` itself is unsigned (§14.3).

### 14.1 GET `/api/v1/update/:channel?appVersion=X` — Decision

`:channel` ∈ { `stable`, `beta` } (allowlisted; any other value → `404 unknown_channel`). `appVersion` is the client's current version, used for staged rollout.

```http
GET /api/v1/update/stable?appVersion=0.4.2 HTTP/1.1
Host: gw.razzoozle.xyz
```

→ `200 OK`:

```json
{
  "decision": "go",
  "latestVersion": "0.4.3",
  "notes": "Fixes UPnP candidate ordering.",
  "repo": "joehomeskillet/razzoozle-desktop"
}
```

Response schema:

```ts
export const UpdateGateResponse = z.object({
  decision:      z.enum(["go", "hold"]),
  latestVersion: z.string().max(32),
  notes:         z.string().max(2000).optional(),
  repo:          z.literal("joehomeskillet/razzoozle-desktop"),
});
```

- `decision: "go"` — the gateway permits the update; the client proceeds via the native github provider (§14.2).
- `decision: "hold"` — the **kill-switch / staged-rollout gate**. The client does **not** update, regardless of what GitHub offers. Used to pause a bad release or roll out gradually by `appVersion`.
- `repo` is a server-side constant; the client uses it only to confirm the expected GitHub repo. It is never derived from request input.

### 14.2 Client side — native github provider + minisign verify

electron-updater config on the desktop client uses the **native github provider** (not `generic`, not the gateway):

```yaml
provider: github
owner: joehomeskillet
repo: razzoozle-desktop
```

Sequence on the client:

1. Call `GET /api/v1/update/stable?appVersion=<current>`.
2. If `decision !== "go"`, stop (no update this cycle).
3. Otherwise let electron-updater fetch `latest.yml` + the `.exe` **directly from the GitHub Release** (the gateway is not on this path).
4. **Verify the minisign/Ed25519 signature over `latest.yml`** against the bundled public key. Only if the signature is valid does the app apply the update. A bad/absent signature aborts the update.

This split means a compromised gateway can at most withhold or delay updates (it controls only the `go`/`hold` decision); it cannot forge one, because the binary set is described by a `latest.yml` the client independently signature-verifies.

### 14.3 Signing reality (F1) — `latest.yml` signed, `.exe` UNSIGNED

- The **`.exe` is UNSIGNED** (no Authenticode code-signing certificate in the MVP).
- The **`latest.yml` update manifest is signed** with **minisign/Ed25519**, and the desktop app verifies that signature **before applying any update** (§14.2). This protects the *update channel* (manifest + hashes), not the OS-level trust of the first installed binary.
- **Windows SmartScreen:** because the `.exe` is unsigned, the **first** run of a freshly downloaded installer triggers a **one-time Windows SmartScreen "unrecognized app" warning** ("More info → Run anyway"). This is expected and documented — the protocol does **not** claim the `.exe` is signed. SmartScreen reputation may reduce the prompt over time, but the MVP ships unsigned and surfaces the warning honestly to users.

### 14.4 Kill-switch / staged rollout

Channel resolution is flipped server-side by returning `decision: "hold"` (pause everyone) or by making `go`/`hold` a function of the incoming `appVersion` (staged rollout / pin). No client change is needed, and **no binary path is involved** — the gateway only emits a JSON decision, so this carries no SSRF surface and no download surface at all.

---

## 15. GET `/desktop-host/ping` (on the HOST, not the gateway)

Served by the desktop host's **own local server**, at each candidate URL's base. It is how the player browser confirms — **after it has navigated to the host's http origin** (§8.1) — that it reached the right live host. It returns **no game data**.

### Request (from the player browser, now on the host's origin)

```http
GET /desktop-host/ping HTTP/1.1
Host: 192.168.1.42:7777
```

### Response — `200 OK`

```json
{
  "ok": true,
  "service": "razzoozle-desktop-host",
  "protocolVersion": 1,
  "sessionId": "8c0b5e2a-3d44-4a9f-9b21-0f7e6c1a55de"
}
```

The browser matches the returned `sessionId` against the one tied to the join code (from `/api/v1/join`). A match means "this is the correct, live host" and the browser proceeds to connect directly. The ping carries the `sessionId` and protocol metadata only — never quiz, players, or scores.

Because this check runs **on the host's own origin** (after top-level navigation), it is a same-origin request and is **not** blocked by mixed-content / PNA — unlike a cross-origin `fetch` from the gateway's HTTPS page, which §8.1 forbids.

---

## 16. End-to-End LAN Example Flow

Two players on the same home Wi‑Fi. Host is on `192.168.1.42`; a friend joins from a laptop on the same LAN.

1. **Host starts game.** The Electron client boots its local `@razzoozle/web` + `@razzoozle/socket` server on port `7777`, enumerates its addresses, and gets one useful candidate: `lan → http://192.168.1.42:7777` (priority 0). (No public/UPnP candidate needed for same-LAN play.)

2. **Host registers.**
   `POST https://gw.razzoozle.xyz/api/v1/sessions` with `hostId`, `protocolVersion: 1`, `appVersion: "0.4.2"`, and the single LAN candidate (the `url` passes write-time validation, §6.1: http scheme, RFC1918 host).
   → `201` with `joinCode: "K7QPMX"`, `joinUrl: https://gw.razzoozle.xyz/j/K7QPMX`, `hostToken: ht_…`, `expiresAt` 30 min out.

3. **Host keeps alive.** Every 30 s: `PATCH /api/v1/sessions/8c0b…` with `Authorization: Bearer ht_…` (pure heartbeat). Each PATCH slides `expiresAt`, keeps `status: online`.

4. **Host shares the code.** "Join my game: **K7QPMX**" (or the join URL, or a QR that encodes `http://192.168.1.42:7777/...` directly for the LAN path).

5. **Friend opens** `https://gw.razzoozle.xyz/j/K7QPMX` in their browser (or scans the LAN QR straight to the host).

6. **Page resolves.** The page's script calls `GET /api/v1/join/K7QPMX` (same-origin HTTPS).
   → `200`, `status: online`, candidates `[{ kind: "lan", url: "http://192.168.1.42:7777", priority: 0 }]`.
   **The gateway did not touch `192.168.1.42` — it only returned the string.**

7. **Top-level navigation to the host.** The page presents the LAN URL for navigation (link / auto-redirect / QR). The phone **navigates** to `http://192.168.1.42:7777` — a permitted top-level `https→http` navigation. It does **not** `fetch`-probe the http candidate from the HTTPS gateway page (that would be blocked by mixed-content / PNA, §8.1).

8. **On-host verification + direct connect.** Now on the host's own http origin, the browser hits `/desktop-host/ping` (same-origin). The ping returns `{ ok: true, sessionId: "8c0b…" }`; the `sessionId` matches → this is the right host. The browser opens the game WebSocket **directly** to the host. From here on, **every quiz, answer, player, and score flows host ↔ browser only.** The gateway is entirely off the path and never sees a byte of gameplay.

9. **Game ends.** The host `DELETE`s the session (or it simply expires after the heartbeat stops; after 90 s `status: offline`, then `expired` at `expiresAt`, after which `/api/v1/join/K7QPMX` returns `404 unknown_join_code` and no candidates).

---

## 17. Security Invariants (restated)

- **Rendezvous-only:** gameplay never enters the gateway. Enforced by the §9 **strict allowlist** (`.strict()` / `additionalProperties:false`, reject not drop) — not a denylist of field names. (S1)
- **No gateway-side probing:** the gateway never fetches, HEADs, pings, or health-checks any candidate URL or host IP. Candidate-URL checks are **structural validation, not network probing** (§6.1). All reachability testing is client-side, after top-level navigation. (S2)
- **Candidate model:** every session carries multiple typed `HostCandidate`s; never a single `internal_ip`/`external_ip`. URLs are validated at write time by `kind` (private vs public ranges, allowed schemes). (S3, §6.1)
- **Mixed-Content / PNA honored:** the joiner reaches the host by **top-level navigation** to the host's http origin; the gateway never serves an HTTPS page that `fetch`-probes http candidates. Residual limits (guest/AP-isolation Wi-Fi, internet→http-host, no relay) are documented honestly. (F4, §8)
- **Host-token mutations + short TTL:** every host mutation requires the high-entropy, per-session, hashed-at-rest bearer token; the token is never reflected to joiners; sessions auto-expire. Join codes use an unambiguous ≥6-char alphabet with per-IP rate-limit + lockout, and wrong/expired codes are indistinguishable. (S4, S7, §10–§11)
- **No binaries on the gateway:** the update path is a **decision** (`go`/`hold`), never a redirect or download. The `.exe` is **unsigned** (one-time SmartScreen warning, documented), and `latest.yml` is **minisign/Ed25519-signed and verified client-side before install**. The native github provider — not the gateway — fetches the artifacts. (F1, F3, D4, §14)
- **House stack only:** Caddy + Gitea + systemd self-host. No AWS Shield, no Vault, no Cloudflare, no CAPTCHA, no SMS.

---

## 18. Code Reuse — web + socket as Pinned Prebuilt Artifact (F2)

`razzoozle-desktop` reuses `@razzoozle/web` + `@razzoozle/socket` as a **pinned, prebuilt, versioned artifact** — **not** a git submodule, **not** a bare-subtree `pnpm workspace:` resolution. The two repos (`razzoozle` and `razzoozle-desktop`) stay separate.

- **Publish:** Razzoozle CI publishes versioned build artifacts of `web` + `socket` — `pnpm pack` tarballs (or a GitHub Packages / GitHub Release artifact).
- **Consume:** `razzoozle-desktop` depends on a **pinned version** of those artifacts.
- **Update:** Renovate/Dependabot opens a PR when a new version publishes; the bump is **tested before merge**.
- **Not used:** no git submodule, no subtree, no `workspace:` link across repos.

This keeps the desktop client building against a known-good, reproducible snapshot of the web+socket code, decoupled from the upstream repo's working tree, while still getting automated update PRs.
