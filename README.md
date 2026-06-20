<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%9B%B0%EF%B8%8F%20Razzoozle%20Gateway-rendezvous%20%C2%B7%20discovery-8B5CF6?style=for-the-badge&labelColor=1f2430" height="56" alt="Razzoozle Gateway" />

# Razzoozle Gateway

### The rendezvous / discovery service for Razzoozle Desktop (`gw.razzoozle.xyz`) — it helps a player's phone **find** a desktop host beyond the same LAN.

🌐 **English** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [中文](README.zh.md)

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B.svg)](#-status)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6.svg)](#-credits--license)

**[🖥️ Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** · **[🎮 Razzoozle](https://github.com/joehomeskillet/Razzoozle)** · **[Report an issue](https://github.com/joehomeskillet/razzloo-gateway/issues)** · *for [Razzoozle](https://github.com/joehomeskillet/Razzoozle), forked from [Ralex91/Razzia](https://github.com/Ralex91/Razzia)*

</div>

---

## 🧩 What is this?

**Razzoozle Gateway** is the small, always-on **rendezvous / discovery service** behind [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop). When a host runs the live quiz on their own PC, players on the same Wi-Fi reach it **directly** — but a phone on a different network first has to **find** where the host is. That is the gateway's only job.

It maps a short **join code** to the host's **connection candidates** (the addresses the host claims to be reachable on) and hands them to the phone so the phone can navigate **straight to the host** and connect directly.

> This is the **discovery service**, not the game. It is a tiny public directory — it is **not** where you play.

---

## ✅ What it does — and does **not** do

The whole design is built around one hard rule: **discovery only**.

- ✅ **Maps a join code → host candidates.** A host registers a session; the gateway mints a join code + host token and stores the candidate endpoints the host advertised.
- ✅ **Lets the phone go direct.** It serves those candidates to a joining player so the phone navigates **straight to the host's own origin** and connects peer-to-peer.
- ✅ **Tracks liveness.** Host heartbeats keep a session `online`; stale sessions expire (short TTL).
- ✅ **Answers an update gate.** It returns a `go` / `hold` decision (a kill-switch + staged-rollout point) for the desktop client — a **decision**, not a download.
- ❌ **No gameplay relay.** It never relays or proxies gameplay — **no TURN, no WebSocket proxy**. The phone ↔ host connection is direct; the gateway is **not** on that path.
- ❌ **No game data.** It stores **no** quiz, questions, answers, scores, players, leaderboard, or game state — only ephemeral session + candidate metadata, and **sessions expire** (a short TTL).
- ❌ **No binaries.** The update path hosts and redirects **no** files; the client fetches the release itself, directly from GitHub.

A compromised gateway can disrupt **discovery** (deny or mislead), but it cannot read or alter a single game answer, because gameplay never flows through it.

```
HOW IT WORKS

(A) Same Wi-Fi — the simple case, zero setup

    player phone  ──── join code / QR ───►  Razzoozle Desktop
                  ◄──────── game ─────────►  (host · your PC :7777)
                                             the quiz never leaves your LAN

(B) Phone on another network — opt-in discovery via the gateway

    1) Razzoozle Desktop ──register CODE + addresses──►  Gateway (gw.razzoozle.xyz)
    2) phone   ──open  gw.razzoozle.xyz/j/CODE────────►  Gateway
    3) phone   ◄──────── host addresses ──────────────   Gateway
    4) phone   ═════════ connects DIRECT to host ═══════►  Razzoozle Desktop

    The gateway only maps CODE -> host address. It keeps no game data and
    never relays gameplay — once the phone has the address, it steps aside.
```

---

## 🔒 Security posture

- **Strict candidate-URL allowlist.** Candidate URLs are validated at write time: `http`/`https` only, **host:port only** (no userinfo, path, query or fragment), with `lan` candidates required to be genuine RFC1918 / link-local / unique-local addresses and public candidates required to be non-private.
- **No server-side probing (no SSRF).** The gateway **never** fetches, pings, or resolves a candidate URL. It treats them as opaque strings — all reachability testing is **client-side, in the player's browser**. There is no outbound HTTP client anywhere in the service.
- **Per-IP rate limit + lockout.** Every endpoint is rate-limited per source IP, and repeated failed join lookups trigger a temporary lockout.
- **High-entropy host token.** The host token is a high-entropy secret, stored only as a **sha256 hash**, compared in constant time, shown **once** at registration and **never** reflected by any read endpoint.
- **No join-code oracle.** A wrong code and an expired code return an **identical** `404` — there is no exists-vs-expired side channel.
- **Strict CSP on the join page.** The `/j` page ships a strict Content-Security-Policy (no `unsafe-inline` scripts), `nosniff`, and a fail-closed CORS stance.

Full detail lives in [`docs/protocol.md`](docs/protocol.md) and [`docs/threat-model.md`](docs/threat-model.md).

---

## 📡 Endpoints

All under the `/api/v1` prefix (protocol version `1`).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sessions` | — | Register a host session; returns a join code + host token. |
| `PATCH` | `/api/v1/sessions/:id` | host token | Heartbeat and/or update candidates. |
| `DELETE` | `/api/v1/sessions/:id` | host token | Tear down a session. |
| `GET` | `/api/v1/join/:code` | — | Resolve a join code to its host candidates. |
| `GET` | `/j/:code` | — | The human-facing player **join page**. |
| `GET` | `/api/v1/update/:channel` | — | The desktop **update-gate** decision (`go` / `hold`). |

---

## 📖 Run & deploy

**Node.js 22+** and **TypeScript** (Fastify). No database — sessions live in memory and expire.

```bash
npm install
npm run build          # tsc -> dist/
node dist/server.js    # listens on 127.0.0.1:8787 by default
```

### 🐳 Docker

```bash
docker compose up -d   # uses the bundled Dockerfile + compose.yml
```

### 🌐 Behind Caddy

In production the service runs behind **Caddy** at `gw.razzoozle.xyz` for TLS and a public hostname — see [`Caddyfile.example`](Caddyfile.example). Operational notes (TTLs, env, kill-switch) are in [`docs/operations.md`](docs/operations.md).

---

## 🚦 Status

**Beta — work in progress.** The rendezvous + update-gate contract is implemented and tested; it is wired up alongside [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop), whose gateway session register/heartbeat is landing incrementally.

---

## 🔗 Related projects

- **[Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** — the Windows desktop app this gateway helps phones discover.
- **[Razzoozle](https://github.com/joehomeskillet/Razzoozle)** — the self-hosted live quiz platform the desktop app runs.

---

## 📝 Credits & license

Razzoozle Gateway is part of the [**Razzoozle**](https://github.com/joehomeskillet/Razzoozle) project, which is a fork of [**Ralex91/Razzia**](https://github.com/Ralex91/Razzia) — huge thanks to the upstream authors. Released under the **MIT License**; the Razzoozle/Razzia MIT lineage is retained.
