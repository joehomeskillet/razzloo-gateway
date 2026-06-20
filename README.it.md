<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%9B%B0%EF%B8%8F%20Razzoozle%20Gateway-rendezvous%20%C2%B7%20discovery-8B5CF6?style=for-the-badge&labelColor=1f2430" height="56" alt="Razzoozle Gateway" />

# Razzoozle Gateway

### Il servizio di rendezvous / discovery per Razzoozle Desktop (`gw.razzoozle.xyz`) — aiuta il telefono di un giocatore a **trovare** un host desktop anche oltre la stessa LAN.

🌐 [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · **Italiano** · [中文](README.zh.md)

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B.svg)](#-stato)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6.svg)](#-crediti--licenza)

**[🖥️ Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** · **[🎮 Razzoozle](https://github.com/joehomeskillet/Razzoozle)** · **[Segnala un problema](https://github.com/joehomeskillet/razzloo-gateway/issues)** · *per [Razzoozle](https://github.com/joehomeskillet/Razzoozle), forkato da [Ralex91/Razzia](https://github.com/Ralex91/Razzia)*

</div>

---

## 🧩 Cos'è?

**Razzoozle Gateway** è il piccolo **servizio di rendezvous / discovery**, sempre attivo, dietro a [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop). Quando un host esegue il quiz live sul proprio PC, i telefoni sullo stesso Wi-Fi lo raggiungono **direttamente** — ma un telefono su un'altra rete deve prima **trovare** dove si trova l'host. Questo è l'unico compito del gateway.

Mappa un breve **codice di accesso** ai **candidati di connessione** dell'host (gli indirizzi su cui l'host dichiara di essere raggiungibile) e li consegna al telefono, così che questo possa navigare **direttamente verso l'host** e connettersi in modo diretto.

> Questo è il **servizio di discovery**, non il gioco. È una minuscola directory pubblica — **non** è il posto in cui si gioca.

---

## ✅ Cosa fa — e cosa **non** fa

L'intero design ruota attorno a una regola rigida: **solo discovery**.

- ✅ **Mappa un codice di accesso → candidati dell'host.** Un host registra una sessione; il gateway conia un codice di accesso + un token host e memorizza gli endpoint candidati annunciati dall'host.
- ✅ **Lascia che il telefono vada diretto.** Serve quei candidati a un giocatore che si unisce, così che il telefono navighi **direttamente verso l'origin dell'host** e si connetta peer-to-peer.
- ✅ **Traccia la vitalità.** Gli heartbeat dell'host mantengono una sessione `online`; le sessioni obsolete scadono (TTL breve).
- ✅ **Risponde a un update-gate.** Restituisce una decisione `go` / `hold` (un kill-switch + punto di rollout graduale) per il client desktop — una **decisione**, non un download.
- ❌ **Nessun relay di gioco.** Non inoltra né fa da proxy al gioco — **niente TURN, niente proxy WebSocket**. La connessione telefono ↔ host è diretta; il gateway **non** è su quel percorso.
- ❌ **Nessun dato di gioco.** Non memorizza **alcun** quiz, domanda, risposta, punteggio, giocatore, classifica o stato di gioco — solo metadati effimeri di sessione e candidati, e **le sessioni scadono** (TTL breve).
- ❌ **Nessun binario.** Il percorso di aggiornamento non ospita né reindirizza **alcun** file; il client recupera la release da solo, direttamente da GitHub.

Un gateway compromesso può disturbare la **discovery** (negare o fuorviare), ma non può leggere né alterare una singola risposta di gioco, perché il gioco non passa mai attraverso di esso.

---

## 🔒 Postura di sicurezza

- **Allowlist rigida per le URL candidate.** Le URL candidate sono validate in scrittura: solo `http`/`https`, **solo host:port** (niente userinfo, percorso, query o frammento), dove i candidati `lan` devono essere indirizzi genuini RFC1918 / link-local / unique-local e i candidati pubblici devono essere non privati.
- **Nessun probing lato server (niente SSRF).** Il gateway **non** recupera, ping o risolve mai una URL candidata. Le tratta come stringhe opache — tutti i test di raggiungibilità avvengono **lato client, nel browser del giocatore**. Non c'è alcun client HTTP in uscita in tutto il servizio.
- **Rate-limit per IP + lockout.** Ogni endpoint ha un rate-limit per IP di origine, e ricerche di accesso fallite ripetute attivano un blocco temporaneo.
- **Token host ad alta entropia.** Il token host è un segreto ad alta entropia, memorizzato solo come **hash sha256**, confrontato in tempo costante, mostrato **una sola volta** alla registrazione e **mai** restituito da alcun endpoint di lettura.
- **Nessun oracolo sul codice di accesso.** Un codice errato e un codice scaduto restituiscono un `404` **identico** — non esiste un canale laterale «esiste vs scaduto».
- **CSP rigida sulla pagina di accesso.** La pagina `/j` invia una Content-Security-Policy rigida (niente script `unsafe-inline`), `nosniff` e una postura CORS fail-closed.

Tutti i dettagli sono in [`docs/protocol.md`](docs/protocol.md) e [`docs/threat-model.md`](docs/threat-model.md).

---

## 📡 Endpoint

Tutti sotto il prefisso `/api/v1` (versione di protocollo `1`).

| Metodo | Percorso | Auth | Scopo |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sessions` | — | Registrare una sessione host; restituisce un codice di accesso + un token host. |
| `PATCH` | `/api/v1/sessions/:id` | token host | Heartbeat e/o aggiornare i candidati. |
| `DELETE` | `/api/v1/sessions/:id` | token host | Smontare una sessione. |
| `GET` | `/api/v1/join/:code` | — | Risolvere un codice di accesso nei suoi candidati host. |
| `GET` | `/j/:code` | — | La **pagina di accesso** leggibile da una persona. |
| `GET` | `/api/v1/update/:channel` | — | La decisione dell'**update-gate** desktop (`go` / `hold`). |

---

## 📖 Esecuzione e deploy

**Node.js 22+** e **TypeScript** (Fastify). Nessun database — le sessioni vivono in memoria e scadono.

```bash
npm install
npm run build          # tsc -> dist/
node dist/server.js    # in ascolto su 127.0.0.1:8787 di default
```

### 🐳 Docker

```bash
docker compose up -d   # usa il Dockerfile + compose.yml inclusi
```

### 🌐 Dietro Caddy

In produzione il servizio gira dietro **Caddy** su `gw.razzoozle.xyz` per TLS e un hostname pubblico — vedi [`Caddyfile.example`](Caddyfile.example). Le note operative (TTL, env, kill-switch) sono in [`docs/operations.md`](docs/operations.md).

---

## 🚦 Stato

**Beta — lavori in corso.** Il contratto rendezvous + update-gate è implementato e testato; viene collegato insieme a [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop), la cui registrazione/heartbeat di sessione del gateway arriva in modo incrementale.

---

## 🔗 Progetti correlati

- **[Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** — l'app desktop per Windows che questo gateway aiuta i telefoni a scoprire.
- **[Razzoozle](https://github.com/joehomeskillet/Razzoozle)** — la piattaforma di quiz live auto-ospitata che l'app desktop esegue.

---

## 📝 Crediti & licenza

Razzoozle Gateway fa parte del progetto [**Razzoozle**](https://github.com/joehomeskillet/Razzoozle), che è un fork di [**Ralex91/Razzia**](https://github.com/Ralex91/Razzia) — un enorme grazie agli autori upstream. Rilasciato sotto **Licenza MIT**; la discendenza MIT di Razzoozle/Razzia è mantenuta.
