# Operations — razzloo-gateway

The Razzoozle rendezvous + update-decision gateway (`gw.razzoozle.xyz`).
Discovery only: it stores session metadata + host candidate endpoints, answers
join-code lookups, and returns an update `go`/`hold` decision. It never carries
gameplay, never probes a candidate URL, and never hosts a binary.

## Stack

Node 22 + TypeScript + Fastify + zod. In-memory ephemeral session store (no DB).
Self-hosted house stack: behind Caddy (TLS via ACME), under systemd or Docker.

## Run / build / test

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node:test contract suite (rate-limit + protocol + threat-model)
npm run dev           # tsx watch on src/server.ts
npm run build         # tsc -> dist/
npm start             # node dist/server.js
```

## Environment

All optional; defaults are the protocol MVP values.

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8787` | Listen port (bind behind Caddy) |
| `HOST` | `127.0.0.1` | Listen address |
| `PUBLIC_BASE_URL` | `https://gw.razzoozle.xyz` | Base for the `joinUrl` in the register response |
| `SESSION_TTL_MS` | `1800000` (30 min) | Initial TTL + heartbeat slide window (§12) |
| `OFFLINE_GRACE_MS` | `90000` (90 s) | No-heartbeat window before `offline` (§12) |
| `SWEEP_INTERVAL_MS` | `15000` | Background expiry/offline sweep cadence |
| `BODY_LIMIT_BYTES` | `4096` | Request body size cap (§11) |
| `JOIN_MISS_THRESHOLD` | `10` | Failed join codes per IP before lockout (§13) |
| `JOIN_LOCKOUT_WINDOW_MS` | `300000` | Miss-counting window |
| `JOIN_LOCKOUT_MS` | `600000` | Lockout duration once tripped |
| `STABLE_LATEST_VERSION` | `0.4.3` | `latestVersion` in the stable update decision (§14) |
| `STABLE_MIN_VERSION` | `0.0.0` | Version floor: clients below get `hold` (staged rollout) |
| `STABLE_KILL_SWITCH` | `0` | Set `1` to force `hold` for everyone on stable (kill-switch) |
| `STABLE_NOTES` | (set) | Release notes returned in the decision |
| `BETA_*` | analogous | Beta channel equivalents |

## Update gate / kill-switch (§14)

The gateway is the update **decision authority**, not a download host. To pause a
bad release: `STABLE_KILL_SWITCH=1` and restart (or `docker compose up -d`). To
stage by version: bump `STABLE_MIN_VERSION` so older clients get `hold`. There are
no `latest.yml`/`:asset` endpoints — the desktop client fetches binaries directly
from the GitHub Release via electron-updater's native github provider and verifies
the minisign signature over `latest.yml` before install. A `hold` or an unreachable
gateway is fail-safe: the client keeps running its current version, never installs.

## Deploy

### Docker (recommended)

```bash
docker compose up -d --build
docker compose logs -f gateway
```

The container binds to `127.0.0.1:8787`; Caddy is the only public entrypoint.

### systemd (no Docker)

```ini
# /etc/systemd/system/razzloo-gateway.service
[Unit]
Description=Razzloo rendezvous gateway
After=network.target

[Service]
Type=simple
User=razzloo
WorkingDirectory=/opt/razzloo-gateway
Environment=PORT=8787 HOST=127.0.0.1 NODE_ENV=production
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
# Hardening (threat-model §11)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=
# Journal readable only by the service user / admin.

[Install]
WantedBy=multi-user.target
```

```bash
npm ci && npm run build
sudo systemctl enable --now razzloo-gateway
```

### Caddy

Copy `Caddyfile.example` into your Caddy config (`gw.razzoozle.xyz` site block),
then `systemctl reload caddy`. Caddy provisions the TLS cert, sets HSTS + the
security headers + CSP, and reverse-proxies to `127.0.0.1:8787`. `trustProxy` is
on in the app so per-IP rate-limit / lockout key off the real client IP via
`X-Forwarded-For`.

## Security notes (enforced in code)

- Strict allowlist on register/PATCH (zod `.strict()`): any unknown field -> `400`.
- `candidate.url` validated at write time (scheme http/https, host:port only,
  `lan` must be RFC1918/link-local, `public-*` must not be private/reserved). No
  socket is ever opened to a candidate — validation, not probing.
- Host-token: 256-bit CSPRNG, `ht_` prefix, SHA-256 hashed at rest, constant-time
  compare, required on PATCH/DELETE, never returned by any read endpoint.
- Join codes: 32-symbol unambiguous alphabet, 6 chars; wrong and expired codes
  return an identical `404 unknown_join_code` (no exists-but-expired oracle).
- Logs never contain raw codes (hashed), host IPs/candidate URLs, or tokens.
```
