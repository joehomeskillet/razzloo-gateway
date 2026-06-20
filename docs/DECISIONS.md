# Phase-0 locked decisions (user-authoritative)

Date: 2026-06-20

1. **Desktop client repo** — NEW GitHub repo under owner `joehomeskillet` (same owner as
   github.com/joehomeskillet/Razzoozle). Proposed name: `razzoozle-desktop` (confirm).
2. **Update model** — in-app AUTO-UPDATE via `electron-updater`; feed = GitHub Releases of the
   desktop repo (`electron-builder` publish provider: github). OVERRIDES the mission spec's
   "desktop auto-update out of MVP".
3. **CI** — GitHub Actions. Windows NSIS installer built natively on GitHub-hosted
   `windows-latest`. Unsigned for MVP (one-time SmartScreen warning; signing deferred).
   [deviation: user picked "Linux+wine" under a Gitea-only premise; GitHub gives free native
   windows-latest — using it pending veto.]
4. **Backup mirror** — a Gitea repo on git.joelduss.xyz must also exist and stay in sync
   (recommend Gitea pull-mirror of the GitHub repo).
5. **Reuse constraint (spec, hard)** — desktop REUSES `@razzoozle/web` + `@razzoozle/socket`;
   NO fork, NO copy. Recommended reuse = git submodule of Razzoozle pinned to a SHA. Alternative
   = monorepo `packages/desktop`. OPEN — user to confirm in repo-strategy review.
6. **Gateway** — SEPARATE repo `razzloo-gateway`. Rendezvous ONLY; never carries gameplay
   traffic, answers, scores, names, results, or WS game data. No relay, no WS proxy.

## Razzoozle facts (recon 2026-06-20)
- pnpm@11.5.1 workspace; packages `@razzoozle/{common,web,socket}` (mcp excluded).
- Canonical Gitea: git.joelduss.xyz/agent-claude/Razzoozle (working clone `cd-src/`, CI here).
- GitHub mirror: github.com/joehomeskillet/Razzoozle (working tree `source/`).
- web & socket each expose a `build` script. Existing Gitea CI = typecheck/lint/test/build on
  ubuntu act_runner (in-container; no host docker/systemctl). web+socket deploy = host
  `razzoozle-cd.timer` Docker poller. Desktop `.exe` is a NEW artifact class — own pipeline.

## Revision 2 (user, 2026-06-20, later)
7. **Two separate projects/repos confirmed** — `razzoozle-desktop` (Windows client) and
   `razzloo-gateway` (rendezvous service) are independent repos, NOT monorepo packages.
8. **Dev-time reuse currency** — desktop's web/socket reference must auto-update during dev:
   git submodule of Razzoozle + a scheduled CI job that bumps the submodule to Razzoozle main
   HEAD and opens a PR.
9. **Runtime update channel = THE GATEWAY** (user: "ich würde sagen über den gateway").
   Interpretation (recommended, flag for confirmation): gateway exposes an update endpoint;
   electron-updater (generic provider) points at it; gateway **302-redirects** latest.yml + asset
   requests to the GitHub Release assets. Gateway = discovery/redirect/kill-switch, hosts NO
   binary (stays tiny + spec-clean). Binaries remain GitHub Release assets (artifact store).

## Finding: auto-generated drafts non-compliant
The protocol.md + threat-model.md found pre-existing in this dir (created by a background worker,
no git, unverified) are NON-COMPLIANT and are being rewritten:
- 🔴 gateway HTTP-probes internal_ip:port / external_ip:port  => the SSRF the spec forbids.
- 🔴 single internal_ip/external_ip model => loses the spec HostCandidate[] (lan/ipv4/ipv6/upnp/manual).
- 🟠 no game-data reject-denylist on the session schema.
- 🟠 off-stack security theater (AWS Shield / Vault / Cloudflare / CAPTCHA) — house stack is Caddy+Gitea self-host.

## Revision 3 (final, post-Fusion 2026-06-20)
Fusion panel opus4.8-gpt5.5-gemini3.1pro (GPT-5.5 dropped: codex aborted on the sandbox CLAUDE.md
echo_speak hook -> effective opus4.8+gemini3.1pro). Verdict GO-WITH-CHANGES. Provenance:
~/.claude/fusion-runs/2026-06-20_211735_opus4.8-gpt5.5-gemini3.1pro.md

Decisive Fusion finding (Gemini, Opus missed it): Mixed Content + Private Network Access — an HTTPS
gateway page cannot fetch()/ws:// an http://lan-ip host. Solved WITHOUT a relay (spec forbids it) via
top-level navigation to the host's own http origin.

FINAL DECISIONS (authoritative; supersede all earlier drafts):
F1. SIGNING — .exe UNSIGNED; latest.yml signed with minisign/Ed25519; desktop verifies the signature
    client-side BEFORE applying any update. SmartScreen warning on the unsigned .exe documented.
F2. REUSE — pinned PREBUILT ARTIFACT, NOT git submodule. Razzoozle CI publishes versioned web+socket
    build artifacts; razzoozle-desktop pins a version; Renovate/Dependabot PRs on new versions (tested
    before merge). Two separate repos retained. (Submodule rejected: pnpm workspace:* fails in a bare
    subtree + auto-bump-to-HEAD footgun.)
F3. UPDATE = GATEWAY-AS-GATE — app calls GET /api/v1/update/:channel?appVersion=... -> {decision go|hold,
    latestVersion, repo}; if go, electron-updater NATIVE github provider fetches from the GitHub Release,
    then verifies minisign over latest.yml before install. Gateway = decision authority + kill-switch +
    staged rollout; NEVER hosts/proxies/redirects binaries. (Old 302-redirect-of-assets endpoints +
    :asset traversal surface REMOVED.)
F4. JOIN FLOW honors Mixed-Content/PNA — player reaches host by TOP-LEVEL NAVIGATION to http://lan-ip:port
    (QR may encode it directly; gateway optional for LAN). /j/:code returns candidate URL(s) for
    navigation, NOT an https client that fetch-probes http candidates. Residual limits (guest/AP-isolation
    Wi-Fi, internet-direct-to-http) documented honestly; no relay in MVP.
F5. NO-GAME-DATA = ALLOWLIST (additionalProperties:false / zod .strict()), not a denylist.
F6. candidate.url validated at WRITE time (scheme http(s), host:port, reject javascript:/file:/data:,
    lan->RFC1918, public-*->non-private). Validation, not probing — no SSRF.
F7. Host-token high-entropy/bound/hashed/required-on-mutation/never-reflected; join codes rate-limited +
    lockout + no exists-but-expired oracle.
Stack: self-hosted Caddy + Gitea + systemd. No AWS/Cloudflare/Vault/CAPTCHA.

## Revision 4 (user, 2026-06-20)
- Repo remote: gateway -> GitHub NOW (github.com/joehomeskillet/razzloo-gateway), Gitea deferred
  ("gitea machen wir später"). Supersedes the "grant gitea token write:user" wait. Both repos now
  GitHub-primary under joehomeskillet.
