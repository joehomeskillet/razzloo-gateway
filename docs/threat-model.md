# Razzloo Gateway — Threat Model

Scope: `razzloo-gateway`, the public rendezvous + update-decision service at
`gw.razzoozle.xyz`. House stack only: **self-hosted Caddy + Gitea + systemd**. No AWS,
no Cloudflare, no Vault, no CAPTCHA, no SMS, no managed WAF. Mitigations that name a
cloud vendor are out of scope by design; if a control is not buildable on Caddy +
systemd + the app itself, it is not in this model.

This document reflects the **final locked Phase-0 decisions** (F1–F7 below) and
supersedes all earlier drafts. Earlier drafts violated security rules that are now
explicitly forbidden — gateway-side health-probing of host IPs, a single
`internal_ip`/`external_ip` model, cloud-vendor mitigations, and a gateway that
**proxied/redirected update binaries**. Those are removed and called out as
anti-patterns where relevant.

## Final Locked Decisions (authoritative)

- **F1 — Signing:** the `.exe` is **UNSIGNED**, but `latest.yml` (the
  electron-updater manifest) is **signed with minisign / Ed25519**; the desktop app
  verifies that signature **client-side BEFORE applying any update**. The unsigned
  `.exe` still triggers a one-time Windows **SmartScreen** warning — documented, not
  hidden. No Authenticode is claimed.
- **F2 — Reuse:** `razzoozle-desktop` reuses `@razzoozle/web` + `@razzoozle/socket`
  as a **pinned prebuilt artifact** (versioned tarball / Release artifact), **not** a
  git submodule and **not** a bare-subtree pnpm `workspace:` resolution. Two separate
  repos retained; Renovate/Dependabot raises a PR on a new published version.
- **F3 — Update = gateway-as-gate (never a binary redirect):** the app calls
  `GET /api/v1/update/:channel?appVersion=X` which returns a **decision**
  (`go`/`hold` + `latestVersion`, `notes?`, `repo`). On `go`, the app uses
  electron-updater's **native GitHub provider** to fetch `latest.yml` + the `.exe`
  **directly from the GitHub Release**, then verifies the minisign signature over
  `latest.yml` before install. The gateway is the **decision authority + kill-switch +
  staged-rollout** point; it **NEVER hosts, proxies, or 302-redirects binaries**.
  There are **no** `/api/v1/update/:channel/:asset` or `latest.yml` redirect
  endpoints (the `:asset` traversal surface is removed entirely).
- **F4 — Join flow honors Mixed-Content + Private-Network-Access:** an HTTPS page
  cannot `fetch()`/`ws://` an `http://lan-ip` host (browsers block active mixed
  content; Chrome PNA blocks public→private). The player reaches the host by
  **top-level navigation to the host's own `http` origin**. `GET /j/:code` returns
  candidate URL(s) for **navigation** (link / redirect / QR) and **must not** serve an
  HTTPS client that `fetch`-probes `http` candidates.
- **F5 — No-game-data = strict ALLOWLIST** (`additionalProperties:false` / zod
  `.strict()`): accept only the documented fields; reject any other field with `400`.
  Not a denylist of gameplay field names.
- **F6 — `candidate.url` validation at write time** (validation, **not** probing — no
  SSRF): scheme `http`/`https`, host:port only, reject `javascript:`/`file:`/`data:`;
  `lan` candidates must be RFC1918/link-local; `public-*` candidates must not be
  private/loopback/reserved. Rejected on `POST`/`PATCH`.
- **F7 — Host-token + join codes:** host-token is high-entropy, bound to one
  `sessionId`, hashed at rest, required on every `PATCH`/`DELETE`, never reflected in
  `GET /join` or `/j` responses. Join codes: unambiguous alphabet ≥ 6 chars, per-IP
  rate-limit + lockout on repeated misses, wrong/expired indistinguishable (no
  exists-but-expired oracle).

---

## 1. Architecture and Trust Boundaries

```
┌────────────────────────────────────────────────────────────────────┐
│  Internet                                                           │
│   ├─ Player browser  (resolves join code, NAVIGATES to host itself) │
│   └─ Desktop client  (Windows Electron host: registers session,     │
│                        heartbeats, asks gateway for an update DECISION)│
└────────────────────────────────────────────────────────────────────┘
                 │ HTTPS only (Caddy terminates TLS, ACME auto-cert)
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  gw.razzoozle.xyz — Rendezvous + Update-Decision Gateway           │
│   (systemd unit, behind Caddy)                                     │
│   • Session store: metadata + HostCandidate[] + host-token hash     │
│   • Join-code resolver (GET /api/v1/join/:code, GET /j/:code)       │
│   • Session register / patch / unregister (host-token gated)        │
│   • Update DECISION gate (GET /api/v1/update/:channel) → go|hold    │
│   • Kill-switch / staged rollout (decide go|hold per version/channel)│
│   ✗ NEVER hosts/proxies/302-redirects any binary or latest.yml      │
│   ✗ NEVER fetches/HEADs/pings candidate URLs or host IPs (no SSRF)  │
│   ✗ NEVER stores/sees/proxies game data (allowlist-rejected on input)│
└────────────────────────────────────────────────────────────────────┘
         decision only (JSON): {"decision":"go|hold","latestVersion":...,
                                "repo":"joehomeskillet/razzoozle-desktop"}

  Update BINARIES travel a path the gateway is NOT on:
    electron-updater (native GitHub provider)
        → github.com/joehomeskillet/razzoozle-desktop/releases
          (latest.yml + minisign sig, *.exe, *.exe.blockmap)
        → client verifies minisign(latest.yml) BEFORE install
```

Trust boundaries:

- **B1 — Internet ↔ Gateway:** all crossings are HTTPS, terminated by Caddy. Every
  request is untrusted input.
- **B2 — Desktop client ↔ GitHub Releases:** the **client** (electron-updater's native
  GitHub provider) fetches `latest.yml` + the `.exe` **directly** from GitHub. The
  gateway is **not** in this path — it neither proxies nor redirects bytes. The client
  verifies the **minisign/Ed25519 signature over `latest.yml`** before installing.
- **B3 — Player browser ↔ Host (LAN/public candidate):** the player reaches the host by
  **top-level navigation** to the host's own `http` origin (F4); the gameplay WebSocket
  is then same-origin on the host. This happens **directly between browser and host**,
  never via the gateway.

Core invariant: the gateway is a **rendezvous + update-decision point**. It holds
session metadata and host candidate endpoints, and it decides `go`/`hold` for updates.
It carries no gameplay, fetches no candidate, and **touches no update binary**.

---

## 2. Assets

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | Session store (session id, code, `HostCandidate[]`, host-token hash, TTL) | Compromise lets an attacker redirect players or DoS sessions |
| A2 | Join-code resolution (`GET /api/v1/join/:code`, `/j/:code`) | Public lookup surface; brute-force / enumeration target |
| A3 | Candidate URLs (`{lan, public-ipv4, public-ipv6, upnp, manual}`) | Reveal host network position; tampering navigates players to attacker hosts |
| A4 | Host-token (issued at register, gates all host mutations) | Secret proving session ownership |
| A5 | Update **decision** gate (`GET /api/v1/update/:channel`) | Availability/integrity of the go/hold/kill-switch decision; forced-hold or forced-go is a supply-chain lever |
| A6 | Desktop update channel (electron-updater **native GitHub provider** + minisign-signed `latest.yml`) | End-to-end **authenticity** of what the Windows client installs |

---

## 3. No-Game-Data Boundary (S1) — F5 strict allowlist

The gateway is a rendezvous service. It MUST store **only** session metadata and host
candidate endpoints. It MUST NOT carry, store, or proxy any gameplay artifact.

**Enforcement is a strict ALLOWLIST, not a denylist (F5).** The register/patch schema
uses `additionalProperties:false` (JSON Schema) / zod `.strict()`. Any field that is
not in the allowlist is rejected with `400`:
`{ "error": "unknown_field", "field": "<name>" }`. A denylist of gameplay field names
is **explicitly rejected** as the wrong tool — denylists are bypassable: a field
renamed to dodge a blocked-name list would slip through, whereas the allowlist rejects
everything it does not recognize by construction. Silent stripping is also forbidden:
it hides client bugs and lets a future refactor leak the field.

Allowed session-register shape (allowlist — anything else → `400`):

```jsonc
{
  // client-supplied, strictly allowlisted:
  "hostId":          "string",
  "protocolVersion": "string",
  "appVersion":      "string",
  "candidates": [
    { "kind": "lan|public-ipv4|public-ipv6|upnp|manual",
      "url": "string (validated at write time, F6)",
      "priority": 0,
      "verified": false,
      "lastVerifiedAt": "ISO-8601 | null" }
  ]
  // server-issued (NOT accepted in the register body, returned by the server):
  //   sessionId, joinCode, hostToken, createdAt/expiresAt timestamps
}
```

| Threat | Detail |
|--------|--------|
| **Attack** | Client (buggy or malicious) posts gameplay fields (`quiz`, `answers`, `players`, `gameState`, a reused game DTO, …) to register/patch, trying to make the gateway a game relay or to leak quiz content through gateway logs/store. |
| **Impact** | Gateway becomes an unintended data processor (privacy + scope creep); gameplay could leak through gateway storage/logs. |
| **Likelihood** | Medium — accidental far more than malicious (a refactor that reuses a game DTO). |
| **Mitigation** | **Strict allowlist (F5):** `additionalProperties:false` / zod `.strict()` accepts only `{hostId, protocolVersion, appVersion, candidates[...]}`; every other field → `400 unknown_field`. No game schema is ever imported into the gateway codebase. Contract test asserts representative gameplay keys → `400`, and that a renamed/unknown key also → `400` (the property a denylist would miss). |
| **Residual risk** | Low. The allowlist rejects unknown fields by construction; there is no blocked-name list to bypass. Accepted residual: the allowlist must be widened deliberately and reviewed on each schema change. |

---

## 4. SSRF — Avoided by Not Probing (S2) + F6 write-time URL validation

**Design stance: the gateway fetches nothing.** It does not `GET`, `HEAD`, `ping`,
connect to, DNS-resolve-for-connection, or health-check any candidate URL or host IP.
Reachability is established **client-side** — the player's browser reaches the host by
**top-level navigation** (F4, §6a), not by the gateway probing.

The prior draft had the gateway HTTP-probe `internal_ip:port` / `external_ip:port`
("Health checking (internal IPs only)"). That is precisely the SSRF this design
forbids: a registrant-controlled URL would coerce the gateway into making requests to
arbitrary internal hosts (`169.254.169.254`, `10.0.0.x`, `localhost:<admin-port>`).
**It is removed and must never be reintroduced.**

`candidate.url` is nonetheless **validated at write time (F6)** — this is *validation*,
not *probing*: the gateway parses and range-checks the string but never dereferences
it. See §4a for the client-side-probe-abuse threat this validation defends against.

| Threat | Detail |
|--------|--------|
| **Attack** | Registrant supplies a candidate URL pointing at an internal/metadata/loopback target hoping the gateway will fetch it (SSRF), revealing internal services or pivoting. |
| **Impact** | Internal port scan, metadata theft, blind SSRF pivot, internal DoS — **if** the gateway ever fetched candidates. |
| **Likelihood** | High *if* probing existed; **N/A** in this design because the gateway performs zero outbound fetches to candidates. |
| **Mitigation** | Gateway is fetch-free toward candidates. Candidate URLs are validated (F6) and stored, returned to the browser for navigation, never dereferenced server-side. The gateway makes **no** outbound request on behalf of a registrant — the update path is a JSON *decision* (F3), not a fetch/redirect, so there is no registrant-controlled outbound surface at all. |
| **Residual risk** | Effectively none for SSRF, because the SSRF precondition (server-side fetch of attacker input) does not exist. |

**Constraint for any hypothetical future optional gateway-side verification** (NOT in
MVP — MVP preference is the gateway fetches nothing). If verification is ever added it
MUST, before any connection and on **every** DNS record and **every** redirect hop:

- Reject targets resolving to **loopback** (`127.0.0.0/8`, `::1`), **private**
  (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), **link-local** (`169.254/16`,
  `fe80::/10`), **reserved/benchmark/doc** ranges, **multicast**, **unspecified**
  (`0.0.0.0`, `::`), and **internal/split-horizon DNS** names.
- Re-resolve and re-validate after **every** redirect (defeat DNS-rebinding /
  TOCTOU); pin the resolved IP for the actual connection; cap redirect hops.
- Use an explicit scheme allowlist (`https` only), a short timeout, and a small
  response cap.

These rules are documented as a **gate on a future feature**, not as something the
MVP ships. The MVP ships no candidate fetching.

---

## 4a. Client-Side Probe Abuse via Candidate URLs (S2b) — F6

Because the **browser** (not the gateway) is what touches candidate URLs, a malicious
host can try to weaponize the *joiner's* browser instead of the gateway. This is the
flip side of SSRF: the attacker abuses the client's network position, not the server's.

| Threat | Detail |
|--------|--------|
| **Attack** | A malicious host registers a candidate such as `url=http://192.168.1.1/...`, `http://localhost:<port>`, `http://169.254.169.254/...`, or a `javascript:`/`file:`/`data:` URL. When a joiner's browser is handed that candidate (for navigation or as a QR/link), the attacker tries to make the **joiner's** browser reach into the joiner's own LAN/router, hit a loopback admin service, or execute a non-http scheme. |
| **Impact** | The joiner's browser navigates to / probes its own LAN gateway (e.g. a router admin page), a loopback service, or runs a dangerous scheme — CSRF-style action against the joiner's router, internal recon from the victim's vantage point, or scheme-based code/file access. The gateway becomes a delivery vehicle for attacks aimed at *other users'* networks. |
| **Likelihood** | Medium — trivial to attempt (just a register body); browser PNA (F4) already blocks the cross-context *fetch* sub-resource case, but a `public→private` **top-level navigation** to a victim's own router could still be steered if unchecked. |
| **Mitigation** | **F6 write-time `candidate.url` validation, on `POST`/`PATCH`, before storing — validation not probing:** scheme MUST be `http` or `https`; `host:port` form only; reject `javascript:`/`file:`/`data:` and any other scheme. **`kind=lan` candidates MUST be RFC1918 / link-local** (a host's own LAN address is legitimate for that host's own joiners). **`public-*` candidates MUST NOT be private/loopback/reserved** — a public candidate pointing at `192.168.x.x`/`127.0.0.1`/`169.254.x.x` is rejected, since that is the signature of an attacker trying to point joiners at *their* internal hosts. Reject with `400 invalid_candidate_url`. Combined with F4 (joiner reaches a host only by top-level navigation to that host's own origin, no fetch-probing), there is no path for a stored candidate to make a joiner silently scan its LAN. |
| **Residual risk** | Low. A `lan` candidate is, by design, an RFC1918 address — a joiner on the *same* LAN as a hostile host could still be navigated to that host's chosen RFC1918 address, but only by explicit top-level navigation (visible URL), never a silent probe, and only within a LAN the joiner already shares with the host. Accepted for MVP. |

---

## 5. Join-Code Brute Force & Enumeration (S3) — F7

Codes are the only public handle to a session. Defense = entropy + per-IP rate limit +
lockout + short TTL + a no-oracle response, all buildable on Caddy + the app.

| Threat | Detail |
|--------|--------|
| **Attack** | Attacker iterates `GET /api/v1/join/:code` / `/j/:code` across the code space to find live sessions, then maps active games or races a player slot. A subtler attack probes whether a given code *used to* exist (timing / response shape) to confirm a target was hosting. |
| **Impact** | Discovery of a live session's candidate endpoints; enumeration of how many games are live (metadata leak); an exists-but-expired oracle confirming a target hosted. No gameplay is exposed at the gateway. |
| **Likelihood** | Medium — trivial to script, but entropy + rate limit + lockout + short TTL make a hit improbable within a session's TTL. |
| **Mitigation** | **Entropy (F7):** codes from a CSPRNG over an **unambiguous alphabet** (no `0/O/1/I`), **≥ 6 chars**. **Per-IP rate limit + lockout (F7):** Caddy `rate_limit` / app token-bucket on join routes; repeated misses from an IP trip a temporary **lockout**, not just a per-request `429`. **Short TTL:** sessions auto-expire (default 30 min, configurable), so the live keyspace is tiny and the window short. **No oracle (F7):** wrong code and expired code return the **identical** `{ "error": "not_found" }` — same status, same body, constant-time-comparable handling — so the attacker cannot distinguish "never existed" from "existed but expired". |
| **Residual risk** | Distributed brute force across many IPs. Accepted for MVP at house-stack scale (no managed WAF/Cloudflare by policy). Compensating controls: short TTL shrinks the window; lockout forces attacker fan-out; global join-failure rate is monitored (§7). |

---

## 6. Host / Session Spoofing (S4) — F7

| Threat | Detail |
|--------|--------|
| **Attack** | Attacker tries to (a) register a session impersonating a host, (b) mutate someone else's session — patch candidates to attacker URLs, heartbeat to keep it alive, or unregister to DoS it, or (c) harvest a host-token from a `GET /join` / `/j` response. |
| **Impact** | Players navigated to an attacker-controlled candidate; legitimate sessions kept alive or killed by a third party; token theft → full session takeover. |
| **Likelihood** | Medium for blind attempts; low for a *targeted* takeover (requires the host-token). |
| **Mitigation** | **Host-token (F7):** `POST /api/v1/sessions` returns a high-entropy host-token (≥ 32 bytes CSPRNG, base64url), **bound to exactly one `sessionId`**. Every mutation — `PATCH /api/v1/sessions/:id` (heartbeat / candidate update) and `DELETE`/unregister — requires it via `Authorization: Bearer`. The gateway stores only a **hash** (e.g. SHA-256) and compares in **constant time**. **Never reflected (F7):** the token is **never** included in `GET /api/v1/join/:code` or `GET /j/:code` responses (or any read path) — those return navigation candidates only. **Candidate-poisoning is blunted** because patched URLs are re-validated at write time (F6). **No re-register:** a `code`/`id` already live returns `409 conflict`. **Short TTL** auto-reaps abandoned sessions without a privileged delete path. |
| **Residual risk** | Low. The host-token lives on the host (Windows desktop); a local-machine compromise of the host can exfiltrate it. Out of gateway scope; recommend the desktop store it in Windows Credential Manager rather than plaintext. |

---

## 6a. Mixed-Content / Private-Network-Access on Join (S6) — F4

The join flow crosses a hard browser boundary: the gateway and any web client are
served over **HTTPS**, but a typical host is reachable only at `http://<lan-ip>:<port>`.
Browsers refuse to let an HTTPS page open an `http://` LAN sub-resource, and Chrome's
**Private Network Access** blocks a public-origin page from reaching a private-IP host.
A naive design that tries to "test" candidates from an HTTPS join page silently fails
everywhere and, worse, invites the probe-abuse of §4a.

| Threat | Detail |
|--------|--------|
| **Attack / failure mode** | (1) An HTTPS join page calls `fetch()` / opens `ws://` against `http://192.168.x.x:port` — **blocked** as active mixed content; the join silently fails. (2) A public-origin (HTTPS) page tries to reach a private-IP host — **blocked** by Chrome PNA (public→private). (3) A design that *did* fetch-probe http candidates from an HTTPS context would be the exact lever §4a abuses to scan the joiner's LAN. |
| **Impact** | Joins that "should" work over LAN fail confusingly; or, if fetch-probing were used to work around the block, the joiner's browser is turned into a LAN scanner. |
| **Mitigation (F4)** | The player reaches the host by **top-level navigation to the host's own `http` origin**, never by sub-resource fetch from an HTTPS page. Top-level `https → http` navigation is permitted by browsers; sub-resource fetch-probing is not. **`GET /j/:code` returns the candidate URL(s) for navigation** (a link, an HTTP 3xx to the host origin, or a QR encoding the host `http` URL) and **MUST NOT** serve an HTTPS client that `fetch`-probes `http` candidates. For LAN, the QR may encode the host `http` URL **directly** (the gateway is optional in that path). Once on the host's own origin, the gameplay WebSocket is same-origin (`ws://` on the host's `http` page) and no mixed-content rule applies. |
| **Residual limits (documented honestly, no relay in MVP)** | **Guest / AP-isolation Wi-Fi:** a phone on an isolated guest SSID cannot reach the host's LAN IP at all — top-level navigation included — so it will not connect. **Internet → an `http`-only host:** a phone on cellular/another network navigating to a host that has only an `http` LAN address cannot reach it; a `public-*` candidate is required, and even then plain `http` across the internet is undesirable. **There is no relay in MVP** — these cases simply do not connect, by design, and are communicated to the user rather than papered over. |

---

## 7. Logging Hygiene (S5)

Logs and any metrics/backups are an asset. The gateway runs under systemd → logs land
in the journal; treat the journal as sensitive and apply these rules **in code**, at
the log call site, not by post-hoc scrubbing.

| Rule | Enforcement |
|------|-------------|
| **Hash join-codes** | Never log a raw code. Log `sha256(code)[:12]` only, for correlation. |
| **No game-like fields ever appear** | The strict allowlist (§3, F5) means such fields are rejected at the edge and never enter the gateway; additionally, the logger has no path that serializes a request body. |
| **Redact host IPs / candidate URLs** | Log a truncated form only (e.g. `203.0.113.x`, host part of a candidate URL redacted). Never log full candidate URLs. |
| **Host-token never logged** | The token (and its hash) are excluded from every log/error/trace path. Auth failures log `{ codeHash, outcome: "denied" }` — never the presented token. |
| **No request-body dumps** | No `console.log(req.body)` / no error handler that echoes the body. Errors log a code + a hashed correlation id only. |

| Threat | Detail |
|--------|--------|
| **Attack** | Attacker who reads the journal / a backup harvests codes, host IPs, or tokens. |
| **Impact** | Session hijack (token), host-location privacy leak (IP), session enumeration (codes). |
| **Likelihood** | Low — requires host-level access to the gateway box. |
| **Mitigation** | Rules above; restrict journal read access via systemd unit user + filesystem perms; short log retention. |
| **Residual risk** | Low. Root on the gateway box can read live memory regardless; that is a host-compromise scenario, mitigated by standard systemd hardening (§9), not by the app. |

---

## 8. Update Channel & Supply Chain (D3 / D4) — A5, A6 — F1 + F3

Runtime auto-update is a **decision call to the gateway plus a direct client↔GitHub
fetch verified by a minisign signature**. The gateway is the **decision authority**
(go/hold, kill-switch, staged rollout); it **never hosts, proxies, or redirects a
binary or `latest.yml`**.

Flow (F3 + F1):

```
1. app → GET gw.razzoozle.xyz/api/v1/update/:channel?appVersion=X
2. gateway → JSON DECISION: { decision:"go"|"hold", latestVersion,
                              notes?, repo:"joehomeskillet/razzoozle-desktop" }
3. if decision == "go":
     electron-updater (NATIVE GitHub provider)
        → fetches latest.yml (+ minisign sig) and the .exe DIRECTLY from
          github.com/joehomeskillet/razzoozle-desktop/releases
4. client VERIFIES minisign/Ed25519 signature over latest.yml  ── BEFORE install ──
5. only then apply the update
```

> **Removed surface:** the old open-redirect-of-update-assets threat no longer applies.
> There are **no** `/api/v1/update/:channel/:asset` or `latest.yml` redirect endpoints,
> and **no** `:asset` path-traversal surface. The gateway emits no `Location` to any
> binary. Open-redirect, asset-path traversal, and "gateway 302 to attacker host" are
> **structurally impossible** because the gateway never issues a binary redirect.

| # | Threat | Attack | Impact | Likelihood | Mitigation | Residual risk |
|---|--------|--------|--------|-----------|------------|---------------|
| U1 | **Tampered / poisoned GitHub Release (substituted binary or manifest)** | Attacker with push/release rights on the repo, or a compromised CI token, publishes a malicious `.exe` and tries to ship a matching `latest.yml`. | Malware to every desktop on next update — **only if the client accepts it**. | Low (requires repo/CI compromise) **and** the signing key. | **F1 minisign/Ed25519 signature over `latest.yml`, verified client-side BEFORE install.** The signing **private key lives off GitHub** (release-signing step injects it; it is not a repo secret usable to re-sign arbitrary content from a code push). A poisoned release that regenerates `latest.yml` **fails signature verification** unless the attacker also holds the minisign private key. Releases are produced only by the CI Windows job, not hand-uploaded. | **Accepted:** an attacker who steals the **minisign private key** *and* controls the release can ship a signed-yet-malicious update. The key is the trust root; protect and (ideally) hardware/offline-hold it. Repo compromise alone is no longer sufficient. |
| U2 | **Gateway decision tampering / forced-go to a bad version** | Attacker influences the gateway's `decision` to return `go` for an attacker-preferred version, or alters `latestVersion`/`repo`. | Client is *told* to update to version X from repo Y. | Low. | The decision **only selects a version + repo**; it never names a binary URL. `repo` is a **pinned constant** (`joehomeskillet/razzoozle-desktop`) the client also hardcodes — a gateway-returned `repo` mismatch is rejected client-side. The client **still fetches from GitHub and still verifies the minisign signature (F1)** before installing, so a forced-`go` to a version whose `latest.yml` the attacker cannot sign **cannot install**. | Low. A forced-`go` can at worst push the client toward a **legitimately-signed** version (e.g. a real-but-buggy release); it cannot install unsigned/forged content. |
| U3 | **Kill-switch / forced-hold abuse (availability)** | Attacker (or a gateway compromise) returns `hold` to **block** updates — pinning clients on an old, vulnerable version — or flips the staged-rollout to deny everyone. | Clients stuck on an outdated version; security fixes withheld. | Low–Medium (this is the gateway's *intended* power, so abuse = misuse of a real lever). | The decision gate is **availability-sensitive by design**: a `hold` (or an unreachable gateway) is **fail-safe to "keep running the current, already-verified version"**, never "install something". The kill-switch is operator-controlled config under systemd; access to flip it is restricted (unit user + filesystem perms, §9). Decisions are logged so a malicious/erroneous global `hold` is detectable. | **Accepted residual:** a compromised gateway can **delay** updates (DoS of the update *decision*), but cannot cause a **wrong binary** to install (U1/U2). Forced-hold degrades to "update later", never "install wrong binary". A stale operator-set version floor is the operational residual. |
| U4 | **Version downgrade / rollback / replay** | Attacker replays an old signed `latest.yml`, or pins an older vulnerable version via the decision. | Client downgrades to a version with known bugs. | Low. | electron-updater does not downgrade below the installed version by default. The gateway can enforce a **minimum-version floor** in the decision and refuse `go` for a yanked version (kill-switch, U3). `latest.yml` is fetched fresh from GitHub each check; the **minisign signature** still gates install. | Low. Replay is bounded by the no-downgrade rule + version floor; the floor must be maintained by the operator (stale floor = residual). |
| U5 | **MITM on update fetch** | Network attacker intercepts the client↔GitHub exchange or the client↔gateway decision call. | Swap `latest.yml`/asset, or tamper the decision, in flight. | Low. | **HTTPS-only end to end:** the gateway decision endpoint is HTTPS (Caddy + HSTS); electron-updater fetches `latest.yml` + asset over **HTTPS from `github.com`** (native provider, scheme not attacker-influenced). On top of TLS, the **minisign signature over `latest.yml` (F1)** is the authenticity backstop even if TLS were broken. | Very low. Reduces to (TLS-trust **AND** minisign-key secrecy); breaking TLS alone does not yield an installable update. |
| U6 | **Unsigned `.exe` / first-install trust (SmartScreen, no Authenticode)** | The NSIS `.exe` carries **no Authenticode signature** (F1: only `latest.yml` is signed, not the binary). | Windows **SmartScreen** shows a one-time "unknown publisher" warning on first install; nothing in the OS trust chain ties the `.exe` to the publisher at first install. | Certain (by decision, MVP). | **Knowingly accepted (F1):** the `.exe` is unsigned → a **one-time SmartScreen warning** the user clicks through; this is documented to users, **not** claimed as signed. Integrity/authenticity of *subsequent* updates rests on the **minisign-signed `latest.yml` + sha512 in it** (electron-updater checks the asset hash against the signed manifest). Blast radius of the unsigned binary is bounded by U1–U5. **Planned (post-MVP):** add Authenticode so first-install also clears SmartScreen. | **Accepted:** users click through SmartScreen **once** on first install; that first install's authenticity rests on HTTPS + GitHub + the user's choice, not on an Authenticode signature. Update-time authenticity is covered by minisign. |

**Residual risks the MVP knowingly accepts (explicit):**
1. The **`.exe` is unsigned** (no Authenticode) → one-time **SmartScreen** warning +
   trust-on-first-install (U6). It is **not** claimed to be signed.
2. **Authenticity now lives in the minisign-signed `latest.yml`** (F1): the trust root
   is the **minisign/Ed25519 private key**, not GitHub release-publish access. A
   release compromise without the key cannot ship an installable update (U1) — but
   theft of the **minisign key** can.
3. The **gateway decision can be DoS'd / forced to `hold`** (U3), delaying updates;
   this never produces a wrong binary, it only postpones a right one.
4. No managed CDN/WAF in front of GitHub or the gateway (house-stack policy) — DoS of
   the decision endpoint or of GitHub degrades to "update later", never to "install
   wrong binary".

---

## 9. Attack Surface by Endpoint

| Endpoint | Auth | Primary threats | Mitigations |
|----------|------|-----------------|-------------|
| `POST /api/v1/sessions` (register) | none → issues host-token | Game-data injection (§3), candidate-URL abuse (§4a), spoof-register (§6), DoS | Strict allowlist parse `400 unknown_field` (F5), `candidate.url` write-time validation `400 invalid_candidate_url` (F6), `409` on existing live code, per-IP rate limit, body size cap, returns host-token (never accepts one), token never reflected in reads (F7) |
| `PATCH /api/v1/sessions/:id` (heartbeat / candidate update) | host-token (Bearer) | Spoof mutation (§6), game-data injection (§3), candidate-URL poisoning (§4a) | Constant-time host-token hash check bound to this `sessionId` (F7), strict allowlist on body (F5), `candidate.url` re-validation at write time (F6), rate limit |
| `DELETE /api/v1/sessions/:id` (unregister) | host-token (Bearer) | Unauthorized teardown (§6) | Host-token required (F7); TTL reaps anyway |
| `GET /api/v1/join/:code` | none | Brute force / enumeration (§5), token leakage (§6) | High-entropy code + lockout (F7), per-IP rate limit, uniform `404` no-oracle (F7), short TTL, **never returns host-token** (F7) — returns navigation candidates only |
| `GET /j/:code` | none | Same as join + mixed-content/PNA misuse (§6a) | Same as `/api/v1/join/:code`; returns candidate URL(s) **for top-level navigation** (link/redirect/QR) and **does not** serve a fetch-probing HTTPS client (F4) |
| `GET /api/v1/update/:channel?appVersion=X` (update **decision**) | none | Forced-go (U2), forced-hold/kill-switch abuse (U3), downgrade (U4), MITM (U5) | Returns **JSON decision only** (`go`/`hold`, `latestVersion`, `repo`); **no binary URL, no redirect**; `repo` pinned constant; HTTPS + HSTS; fail-safe to current version on `hold`/unreachable; client verifies minisign over `latest.yml` regardless (F1/F3) |
| `GET /desktop-host/ping` (host-local) | n/a (host-local only) | n/a — served by the desktop client on the LAN, not the public gateway | Not exposed by `gw.razzoozle.xyz`; documented here only to clarify it is **not** a gateway endpoint and is **never** probed by the gateway (§4) |

> **Removed endpoints (no longer exist):** `/api/v1/update/:channel/:asset` and any
> `latest.yml`/binary redirect route. The `:asset` traversal surface is gone (§8, F3).

---

## 10. Data Sensitivity

| Data | Sensitivity | Storage | In logs | Retention |
|------|-------------|---------|---------|-----------|
| Join-code | High (session handle) | Session store (ephemeral) | `sha256(code)[:12]` only | Session TTL (default 30 min) |
| HostCandidate URLs | Medium–High (host network position) | Session store (validated at write, F6) | Redacted (host part stripped) | Session TTL |
| Host-token | Critical (mutation auth) | **Hash only** in store | **Never** | Session TTL |
| Session metadata (`hostId`, `protocolVersion`, `appVersion`, id, kind, priority, verified, ttl) | Low–Medium | Session store | id + codeHash only | Session TTL |
| Update decision (channel, version, repo) | Low (public) | none (computed per request) | OK to log version + decision (go/hold) | n/a |
| Minisign **public** key (client-embedded) | Low (public by design) | shipped in client | n/a | with client |
| Minisign **private** key (signing) | **Critical** (update trust root, F1) | **off GitHub**, in the release-signing step's protected store | **Never** | until rotated |
| Gateway operator config (version floor, kill-switch, rollout) | Medium | systemd unit env / config file | Not logged | until changed |

No gameplay data appears in this table because none is ever accepted (§3, F5).

---

## 11. House-Stack Deployment Security Checklist

Caddy + Gitea + systemd only. Each item is buildable without a cloud vendor.

- [ ] **TLS via Caddy:** automatic ACME cert for `gw.razzoozle.xyz`; HTTP→HTTPS
      redirect; HSTS header set by Caddy.
- [ ] **Update gate returns a DECISION, never a binary:** `/api/v1/update/:channel`
      emits JSON `{decision, latestVersion, notes?, repo}` only — **no `Location` to a
      binary, no `latest.yml` redirect, no `:asset` route** (F3). Asserted by test.
- [ ] **`repo` is a pinned constant** (`joehomeskillet/razzoozle-desktop`) on both the
      gateway and the client; a mismatched `repo` in a decision is rejected client-side.
- [ ] **Client verifies minisign/Ed25519 over `latest.yml` BEFORE install** (F1);
      minisign **public** key embedded in the client; **private** key kept off GitHub.
- [ ] **`.exe` is unsigned by decision (MVP):** SmartScreen warning is expected and
      documented to users; do **not** claim Authenticode.
- [ ] **Strict allowlist input validation (F5):** `additionalProperties:false` / zod
      `.strict()` on register/patch; unknown field → `400 unknown_field`; body size
      cap (≤ 4 KB); `Content-Type: application/json` required. **No denylist.**
- [ ] **`candidate.url` write-time validation (F6):** scheme `http`/`https` only;
      reject `javascript:`/`file:`/`data:`; `lan` must be RFC1918/link-local;
      `public-*` must not be private/loopback/reserved; `400 invalid_candidate_url`.
- [ ] **Join flow is navigation, not fetch-probing (F4):** `/j/:code` returns
      navigation candidates (link/redirect/QR); no HTTPS client that `fetch`-probes
      `http` candidates is served; residual guest-AP / internet-to-http limits
      documented to users (no relay in MVP).
- [ ] **Join-code hardening (F7):** unambiguous alphabet ≥ 6 chars; per-IP rate limit
      **+ lockout** on repeated misses; wrong/expired return identical `404` (no
      exists-but-expired oracle).
- [ ] **Host-token hardening (F7):** high-entropy, bound to one `sessionId`, stored as
      a hash, constant-time compare, required on every `PATCH`/`DELETE`, **never** in
      any `GET /join` / `/j` response.
- [ ] **No game data in logs:** logger has no request-body path; allowlist keeps such
      fields out of the gateway entirely.
- [ ] **No raw codes in logs:** only `sha256(code)[:12]`.
- [ ] **No full host IPs / candidate URLs in logs:** redacted at the call site.
- [ ] **No gateway-side candidate fetching:** verified by code review — the gateway
      makes **zero** outbound requests to candidate URLs / host IPs (S2). The update
      path is a decision, not a fetch/redirect, so there is no registrant-controlled
      outbound surface.
- [ ] **Short session TTL + auto-expiry:** default 30 min; reaper sweeps expired
      sessions.
- [ ] **Kill-switch / staged rollout / min-version floor** wired into
      `/api/v1/update/:channel` and tested; **fail-safe to current version** on `hold`
      or unreachable gateway.
- [ ] **systemd hardening on the gateway unit:** dedicated non-root user,
      `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`,
      `PrivateTmp=true`, restricted `ReadWritePaths`, journal readable only by the
      service user / admin.
- [ ] **Security headers via Caddy:** HSTS, `X-Content-Type-Options: nosniff`,
      `X-Frame-Options: DENY`, a tight CSP for any served HTML.
- [ ] **CORS:** restrict the JSON API to the known web origin(s); no `*`.
- [ ] **Gitea mirror (D5) integrity:** desktop repo is GitHub-primary with a Gitea
      **pull-mirror** backup; the mirror is read-only and never a release source for
      the updater (the updater's native provider + the pinned `repo` point at GitHub
      only).
- [ ] **Prebuilt-artifact reuse (F2):** `razzoozle-desktop` depends on a **pinned
      version** of `@razzoozle/web` + `@razzoozle/socket` (prebuilt artifact, not a git
      submodule, not a `workspace:` subtree); Renovate/Dependabot PR on new versions,
      tested before merge.

---

## 12. Out of Scope / Explicitly Not Doing

By house-stack policy (no cloud-vendor theater), the following are **not** mitigations
in this model and must not be added back:

- Managed WAF / DDoS scrubbing (Cloudflare, AWS Shield) — replaced by per-IP rate
  limits + lockout + short TTL + monitoring of global failure rates.
- Secrets manager / Vault — gateway secrets and the **minisign private signing key**
  live off-GitHub in the systemd unit environment / the protected release-signing step,
  with filesystem perms.
- CAPTCHA, SMS/2FA "verification theater" on join or register.
- **Gateway-side health-probing of candidates** — forbidden (§4, S2); the gateway
  never fetches a candidate. Candidate URLs are *validated* at write time (§4a, F6),
  not *probed*.
- The gateway **hosting, proxying, or redirecting** any binary or `latest.yml`
  (§8, F3) — the gateway returns an update **decision** only; there is no binary
  redirect, no `:asset` route, and therefore no open-redirect / asset-traversal
  surface.
- The gateway storing or proxying any gameplay payload (§3, F5).
- A **relay** for unreachable join cases (guest-AP isolation / internet→http host) —
  not in MVP; these cases are documented as "will not connect" (§6a, F4).
- A **git submodule / `workspace:` subtree** for `@razzoozle/web`+`@razzoozle/socket`
  — reuse is a pinned prebuilt artifact across two repos (F2).
