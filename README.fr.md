<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%9B%B0%EF%B8%8F%20Razzoozle%20Gateway-rendezvous%20%C2%B7%20discovery-8B5CF6?style=for-the-badge&labelColor=1f2430" height="56" alt="Razzoozle Gateway" />

# Razzoozle Gateway

### Le service de rendez-vous / découverte pour Razzoozle Desktop (`gw.razzoozle.xyz`) — il aide le téléphone d'un joueur à **trouver** un hôte de bureau au-delà du même réseau local.

🌐 [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Italiano](README.it.md) · [中文](README.zh.md)

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B.svg)](#-statut)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6.svg)](#-crédits--licence)

**[🖥️ Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** · **[🎮 Razzoozle](https://github.com/joehomeskillet/Razzoozle)** · **[Signaler un problème](https://github.com/joehomeskillet/razzloo-gateway/issues)** · *pour [Razzoozle](https://github.com/joehomeskillet/Razzoozle), forké depuis [Ralex91/Razzia](https://github.com/Ralex91/Razzia)*

</div>

---

## 🧩 Qu'est-ce que c'est ?

**Razzoozle Gateway** est le petit **service de rendez-vous / découverte**, toujours disponible, derrière [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop). Lorsqu'un hôte fait tourner le quiz en direct sur son propre PC, les téléphones sur le même Wi-Fi l'atteignent **directement** — mais un téléphone sur un autre réseau doit d'abord **trouver** où se situe l'hôte. C'est l'unique rôle de la passerelle.

Elle associe un court **code de connexion** aux **candidats de connexion** de l'hôte (les adresses auxquelles l'hôte prétend être joignable) et les transmet au téléphone afin qu'il navigue **directement vers l'hôte** et se connecte en direct.

> Ceci est le **service de découverte**, pas le jeu. C'est un minuscule annuaire public — **ce n'est pas** là qu'on joue.

---

## ✅ Ce qu'il fait — et ce qu'il ne fait **pas**

Toute la conception repose sur une règle stricte : **découverte uniquement**.

- ✅ **Associe un code de connexion → candidats de l'hôte.** Un hôte enregistre une session ; la passerelle frappe un code de connexion + un jeton d'hôte et stocke les points de terminaison candidats annoncés par l'hôte.
- ✅ **Laisse le téléphone aller en direct.** Elle sert ces candidats à un joueur qui rejoint afin que le téléphone navigue **directement vers l'origine de l'hôte** et se connecte en pair-à-pair.
- ✅ **Suit la vivacité.** Les heartbeats de l'hôte gardent une session `online` ; les sessions périmées expirent (TTL court).
- ✅ **Répond à un update-gate.** Elle renvoie une décision `go` / `hold` (un coupe-circuit + point de déploiement progressif) pour le client de bureau — une **décision**, pas un téléchargement.
- ❌ **Pas de relais de jeu.** Elle ne relaie ni ne fait office de proxy pour le jeu — **pas de TURN, pas de proxy WebSocket**. La connexion téléphone ↔ hôte est directe ; la passerelle **n'est pas** sur ce chemin.
- ❌ **Aucune donnée de jeu.** Elle ne stocke **aucun** quiz, question, réponse, score, joueur, classement ni état de jeu — uniquement des métadonnées éphémères de session et de candidats, et **les sessions expirent** (TTL court).
- ❌ **Aucun binaire.** Le chemin de mise à jour n'héberge ni ne redirige **aucun** fichier ; le client récupère la release lui-même, directement depuis GitHub.

Une passerelle compromise peut perturber la **découverte** (refuser ou induire en erreur), mais elle ne peut lire ni altérer une seule réponse de jeu, car le jeu ne transite jamais par elle.

---

## 🔒 Posture de sécurité

- **Liste d'autorisation stricte des URL candidates.** Les URL candidates sont validées à l'écriture : `http`/`https` uniquement, **host:port uniquement** (pas d'userinfo, de chemin, de requête ni de fragment), les candidats `lan` devant être de véritables adresses RFC1918 / link-local / unique-local et les candidats publics devant être non privés.
- **Pas de sondage côté serveur (pas de SSRF).** La passerelle ne récupère, ne ping ni ne résout **jamais** une URL candidate. Elle les traite comme des chaînes opaques — tous les tests d'accessibilité se font **côté client, dans le navigateur du joueur**. Il n'y a aucun client HTTP sortant nulle part dans le service.
- **Rate-limit par IP + verrouillage.** Chaque point de terminaison est rate-limité par IP source, et des recherches de connexion échouées répétées déclenchent un verrouillage temporaire.
- **Jeton d'hôte à haute entropie.** Le jeton d'hôte est un secret à haute entropie, stocké uniquement sous forme de **hash sha256**, comparé en temps constant, montré **une seule fois** à l'enregistrement et **jamais** renvoyé par un point de terminaison de lecture.
- **Pas d'oracle de code de connexion.** Un code erroné et un code expiré renvoient un `404` **identique** — il n'y a pas de canal auxiliaire « existe vs expiré ».
- **CSP stricte sur la page de connexion.** La page `/j` livre une Content-Security-Policy stricte (pas de scripts `unsafe-inline`), `nosniff` et une posture CORS à échec fermé.

Tout le détail se trouve dans [`docs/protocol.md`](docs/protocol.md) et [`docs/threat-model.md`](docs/threat-model.md).

---

## 📡 Points de terminaison

Tous sous le préfixe `/api/v1` (version de protocole `1`).

| Méthode | Chemin | Auth | Rôle |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sessions` | — | Enregistrer une session d'hôte ; renvoie un code de connexion + un jeton d'hôte. |
| `PATCH` | `/api/v1/sessions/:id` | jeton d'hôte | Heartbeat et/ou mettre à jour les candidats. |
| `DELETE` | `/api/v1/sessions/:id` | jeton d'hôte | Démonter une session. |
| `GET` | `/api/v1/join/:code` | — | Résoudre un code de connexion vers ses candidats d'hôte. |
| `GET` | `/j/:code` | — | La **page de connexion** lisible par un humain. |
| `GET` | `/api/v1/update/:channel` | — | La décision de l'**update-gate** de bureau (`go` / `hold`). |

---

## 📖 Exécuter et déployer

**Node.js 22+** et **TypeScript** (Fastify). Pas de base de données — les sessions vivent en mémoire et expirent.

```bash
npm install
npm run build          # tsc -> dist/
node dist/server.js    # écoute sur 127.0.0.1:8787 par défaut
```

### 🐳 Docker

```bash
docker compose up -d   # utilise le Dockerfile + compose.yml fournis
```

### 🌐 Derrière Caddy

En production, le service tourne derrière **Caddy** sur `gw.razzoozle.xyz` pour le TLS et un nom d'hôte public — voir [`Caddyfile.example`](Caddyfile.example). Les notes d'exploitation (TTL, env, coupe-circuit) sont dans [`docs/operations.md`](docs/operations.md).

---

## 🚦 Statut

**Bêta — travail en cours.** Le contrat rendez-vous + update-gate est implémenté et testé ; il est câblé aux côtés de [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop), dont l'enregistrement/heartbeat de session de passerelle arrive de manière incrémentale.

---

## 🔗 Projets liés

- **[Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** — l'application de bureau Windows que cette passerelle aide les téléphones à découvrir.
- **[Razzoozle](https://github.com/joehomeskillet/Razzoozle)** — la plateforme de quiz en direct auto-hébergée qu'exécute l'application de bureau.

---

## 📝 Crédits & licence

Razzoozle Gateway fait partie du projet [**Razzoozle**](https://github.com/joehomeskillet/Razzoozle), qui est un fork de [**Ralex91/Razzia**](https://github.com/Ralex91/Razzia) — un grand merci aux auteurs en amont. Publié sous la **licence MIT** ; la lignée MIT de Razzoozle/Razzia est conservée.
