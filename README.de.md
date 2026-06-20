<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%9B%B0%EF%B8%8F%20Razzoozle%20Gateway-rendezvous%20%C2%B7%20discovery-8B5CF6?style=for-the-badge&labelColor=1f2430" height="56" alt="Razzoozle Gateway" />

# Razzoozle Gateway

### Der Rendezvous- / Discovery-Dienst für Razzoozle Desktop (`gw.razzoozle.xyz`) — er hilft dem Handy einer spielenden Person, einen Desktop-Host **zu finden**, auch über das eigene LAN hinaus.

🌐 [English](README.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [中文](README.zh.md)

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B.svg)](#-status)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6.svg)](#-credits--lizenz)

**[🖥️ Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** · **[🎮 Razzoozle](https://github.com/joehomeskillet/Razzoozle)** · **[Problem melden](https://github.com/joehomeskillet/razzloo-gateway/issues)** · *für [Razzoozle](https://github.com/joehomeskillet/Razzoozle), geforkt von [Ralex91/Razzia](https://github.com/Ralex91/Razzia)*

</div>

---

## 🧩 Was ist das?

**Razzoozle Gateway** ist der kleine, stets erreichbare **Rendezvous- / Discovery-Dienst** hinter [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop). Wenn eine gastgebende Person das Live-Quiz auf dem eigenen PC ausführt, erreichen Handys im selben WLAN den Host **direkt** — aber ein Handy in einem anderen Netzwerk muss zuerst **finden**, wo der Host ist. Genau das ist die einzige Aufgabe des Gateways.

Es bildet einen kurzen **Beitritts-Code** auf die **Verbindungs-Kandidaten** des Hosts ab (die Adressen, unter denen der Host nach eigener Angabe erreichbar ist) und übergibt sie dem Handy, damit dieses **direkt zum Host** navigieren und sich unmittelbar verbinden kann.

> Dies ist der **Discovery-Dienst**, nicht das Spiel. Es ist ein winziges öffentliches Verzeichnis — **nicht** der Ort, an dem gespielt wird.

---

## ✅ Was es tut — und was **nicht**

Das gesamte Design folgt einer harten Regel: **nur Discovery**.

- ✅ **Bildet einen Beitritts-Code → Host-Kandidaten ab.** Ein Host registriert eine Session; das Gateway vergibt einen Beitritts-Code + Host-Token und speichert die vom Host angegebenen Kandidaten-Endpunkte.
- ✅ **Lässt das Handy direkt gehen.** Es liefert diese Kandidaten an ein beitretendes Handy, das **direkt zur eigenen Origin des Hosts** navigiert und sich peer-to-peer verbindet.
- ✅ **Verfolgt die Lebendigkeit.** Host-Heartbeats halten eine Session `online`; veraltete Sessions laufen ab (kurze TTL).
- ✅ **Beantwortet ein Update-Gate.** Es gibt eine `go` / `hold`-Entscheidung zurück (ein Kill-Switch + Punkt für gestaffeltes Rollout) für den Desktop-Client — eine **Entscheidung**, kein Download.
- ❌ **Kein Spiel-Relay.** Es leitet Spielgeschehen niemals weiter und proxyt es nicht — **kein TURN, kein WebSocket-Proxy**. Die Verbindung Handy ↔ Host ist direkt; das Gateway ist **nicht** auf diesem Pfad.
- ❌ **Keine Spieldaten.** Es speichert **kein** Quiz, keine Fragen, Antworten, Punkte, Spielenden, Ranglisten oder Spielzustände — nur kurzlebige Session- und Kandidaten-Metadaten, und **Sessions laufen ab** (kurze TTL).
- ❌ **Keine Binärdateien.** Der Update-Pfad hostet und leitet **keine** Dateien um; der Client holt das Release selbst, direkt von GitHub.

Ein kompromittiertes Gateway kann die **Discovery** stören (verweigern oder in die Irre führen), aber es kann keine einzige Spielantwort lesen oder verändern, weil Spielgeschehen niemals durch es fließt.

```
SO FUNKTIONIERT ES

(A) Gleiches WLAN — der einfache Fall, keine Einrichtung

    player phone  ──── join code / QR ───►  Razzoozle Desktop
                  ◄──────── game ─────────►  (host · your PC :7777)
                                             das Quiz verlässt niemals dein LAN

(B) Handy in einem anderen Netzwerk — opt-in Erkennung über das Gateway

    1) Razzoozle Desktop ──register CODE + addresses──►  Gateway (gw.razzoozle.xyz)
    2) phone   ──open  gw.razzoozle.xyz/j/CODE────────►  Gateway
    3) phone   ◄──────── host addresses ──────────────   Gateway
    4) phone   ═════════ connects DIRECT to host ═══════►  Razzoozle Desktop

    Das Gateway ordnet nur CODE -> Host-Adresse zu. Es speichert keine Spieldaten und
    leitet niemals Spielgeschehen weiter — sobald das Handy die Adresse hat, tritt es beiseite.
```

---

## 🔒 Sicherheits-Haltung

- **Strenge Allowlist für Kandidaten-URLs.** Kandidaten-URLs werden beim Schreiben validiert: nur `http`/`https`, **nur host:port** (kein Userinfo, kein Pfad, keine Query, kein Fragment), wobei `lan`-Kandidaten echte RFC1918- / Link-local- / Unique-local-Adressen sein müssen und öffentliche Kandidaten nicht-privat sein müssen.
- **Kein serverseitiges Probing (kein SSRF).** Das Gateway holt, pingt oder löst eine Kandidaten-URL **niemals** auf. Es behandelt sie als opake Strings — alle Erreichbarkeitstests erfolgen **clientseitig, im Browser der spielenden Person**. Es gibt nirgends im Dienst einen ausgehenden HTTP-Client.
- **Rate-Limit pro IP + Lockout.** Jeder Endpunkt ist pro Quell-IP rate-limitiert, und wiederholt fehlgeschlagene Join-Abfragen lösen eine temporäre Sperre aus.
- **Host-Token mit hoher Entropie.** Der Host-Token ist ein Geheimnis mit hoher Entropie, nur als **sha256-Hash** gespeichert, in konstanter Zeit verglichen, **einmalig** bei der Registrierung gezeigt und von keinem Read-Endpunkt jemals zurückgegeben.
- **Kein Join-Code-Oracle.** Ein falscher Code und ein abgelaufener Code geben ein **identisches** `404` zurück — es gibt keinen Seitenkanal „existiert vs. abgelaufen".
- **Strenge CSP auf der Join-Seite.** Die `/j`-Seite liefert eine strenge Content-Security-Policy (keine `unsafe-inline`-Skripte), `nosniff` und eine fail-closed CORS-Haltung.

Alle Details stehen in [`docs/protocol.md`](docs/protocol.md) und [`docs/threat-model.md`](docs/threat-model.md).

---

## 📡 Endpunkte

Alle unter dem Präfix `/api/v1` (Protokoll-Version `1`).

| Methode | Pfad | Auth | Zweck |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sessions` | — | Host-Session registrieren; gibt Beitritts-Code + Host-Token zurück. |
| `PATCH` | `/api/v1/sessions/:id` | Host-Token | Heartbeat und/oder Kandidaten aktualisieren. |
| `DELETE` | `/api/v1/sessions/:id` | Host-Token | Eine Session abbauen. |
| `GET` | `/api/v1/join/:code` | — | Einen Beitritts-Code zu seinen Host-Kandidaten auflösen. |
| `GET` | `/j/:code` | — | Die menschenlesbare **Beitritts-Seite**. |
| `GET` | `/api/v1/update/:channel` | — | Die Desktop-**Update-Gate**-Entscheidung (`go` / `hold`). |

---

## 📖 Ausführen & Deployen

**Node.js 22+** und **TypeScript** (Fastify). Keine Datenbank — Sessions liegen im Speicher und laufen ab.

```bash
npm install
npm run build          # tsc -> dist/
node dist/server.js    # lauscht standardmäßig auf 127.0.0.1:8787
```

### 🐳 Docker

```bash
docker compose up -d   # nutzt das mitgelieferte Dockerfile + compose.yml
```

### 🌐 Hinter Caddy

In Produktion läuft der Dienst hinter **Caddy** unter `gw.razzoozle.xyz` für TLS und einen öffentlichen Hostnamen — siehe [`Caddyfile.example`](Caddyfile.example). Betriebshinweise (TTLs, Env, Kill-Switch) stehen in [`docs/operations.md`](docs/operations.md).

---

## 🚦 Status

**Beta — in Arbeit.** Der Rendezvous- + Update-Gate-Contract ist implementiert und getestet; er wird gemeinsam mit [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop) verdrahtet, dessen Gateway-Session-Registrierung/Heartbeat schrittweise landet.

---

## 🔗 Verwandte Projekte

- **[Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** — die Windows-Desktop-App, die dieses Gateway Handys finden hilft.
- **[Razzoozle](https://github.com/joehomeskillet/Razzoozle)** — die selbstgehostete Live-Quiz-Plattform, die die Desktop-App ausführt.

---

## 📝 Credits & Lizenz

Razzoozle Gateway ist Teil des [**Razzoozle**](https://github.com/joehomeskillet/Razzoozle)-Projekts, das ein Fork von [**Ralex91/Razzia**](https://github.com/Ralex91/Razzia) ist — herzlichen Dank an die Upstream-Autoren. Veröffentlicht unter der **MIT License**; die MIT-Linie von Razzoozle/Razzia bleibt erhalten.
