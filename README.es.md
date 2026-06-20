<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%9B%B0%EF%B8%8F%20Razzoozle%20Gateway-rendezvous%20%C2%B7%20discovery-8B5CF6?style=for-the-badge&labelColor=1f2430" height="56" alt="Razzoozle Gateway" />

# Razzoozle Gateway

### El servicio de rendezvous / descubrimiento para Razzoozle Desktop (`gw.razzoozle.xyz`) — ayuda al teléfono de un jugador a **encontrar** un host de escritorio más allá de la misma LAN.

🌐 [English](README.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Italiano](README.it.md) · [中文](README.zh.md)

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B.svg)](#-estado)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6.svg)](#-créditos--licencia)

**[🖥️ Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** · **[🎮 Razzoozle](https://github.com/joehomeskillet/Razzoozle)** · **[Reportar un problema](https://github.com/joehomeskillet/razzloo-gateway/issues)** · *para [Razzoozle](https://github.com/joehomeskillet/Razzoozle), bifurcado de [Ralex91/Razzia](https://github.com/Ralex91/Razzia)*

</div>

---

## 🧩 ¿Qué es esto?

**Razzoozle Gateway** es el pequeño **servicio de rendezvous / descubrimiento**, siempre disponible, detrás de [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop). Cuando un anfitrión ejecuta el cuestionario en vivo en su propio PC, los teléfonos en el mismo Wi-Fi lo alcanzan **directamente**, pero un teléfono en otra red primero tiene que **encontrar** dónde está el host. Esa es la única tarea del gateway.

Mapea un breve **código de unión** a los **candidatos de conexión** del host (las direcciones en las que el host afirma ser accesible) y se los entrega al teléfono para que este navegue **directamente al host** y conecte de forma directa.

> Este es el **servicio de descubrimiento**, no el juego. Es un diminuto directorio público — **no** es donde se juega.

---

## ✅ Lo que hace — y lo que **no** hace

Todo el diseño se basa en una regla estricta: **solo descubrimiento**.

- ✅ **Mapea un código de unión → candidatos del host.** Un host registra una sesión; el gateway acuña un código de unión + token de host y almacena los endpoints candidatos que el host anunció.
- ✅ **Deja que el teléfono vaya directo.** Sirve esos candidatos a un jugador que se une para que el teléfono navegue **directamente al propio origin del host** y conecte peer-to-peer.
- ✅ **Sigue la vitalidad.** Los heartbeats del host mantienen una sesión `online`; las sesiones obsoletas expiran (TTL corto).
- ✅ **Responde a un update-gate.** Devuelve una decisión `go` / `hold` (un interruptor de apagado + punto de despliegue escalonado) para el cliente de escritorio — una **decisión**, no una descarga.
- ❌ **Sin relay de juego.** Nunca retransmite ni hace de proxy del juego — **sin TURN, sin proxy de WebSocket**. La conexión teléfono ↔ host es directa; el gateway **no** está en esa ruta.
- ❌ **Sin datos de juego.** No almacena **ningún** cuestionario, pregunta, respuesta, puntuación, jugador, clasificación ni estado de juego — solo metadatos efímeros de sesión y candidatos, y **las sesiones expiran** (TTL corto).
- ❌ **Sin binarios.** La ruta de actualización no aloja ni redirige **ningún** archivo; el cliente obtiene la release por sí mismo, directamente desde GitHub.

Un gateway comprometido puede perturbar el **descubrimiento** (denegar o engañar), pero no puede leer ni alterar una sola respuesta de juego, porque el juego nunca fluye a través de él.

---

## 🔒 Postura de seguridad

- **Allowlist estricta de URLs candidatas.** Las URLs candidatas se validan al escribirse: solo `http`/`https`, **solo host:port** (sin userinfo, ruta, query ni fragmento), donde los candidatos `lan` deben ser direcciones genuinas RFC1918 / link-local / unique-local y los candidatos públicos deben ser no privados.
- **Sin sondeo del lado servidor (sin SSRF).** El gateway **nunca** obtiene, hace ping ni resuelve una URL candidata. Las trata como cadenas opacas — todas las pruebas de accesibilidad se hacen **del lado del cliente, en el navegador del jugador**. No hay ningún cliente HTTP saliente en todo el servicio.
- **Rate-limit por IP + bloqueo.** Cada endpoint tiene rate-limit por IP de origen, y las búsquedas de unión fallidas repetidas activan un bloqueo temporal.
- **Token de host de alta entropía.** El token de host es un secreto de alta entropía, almacenado solo como un **hash sha256**, comparado en tiempo constante, mostrado **una vez** en el registro y **nunca** devuelto por ningún endpoint de lectura.
- **Sin oráculo de código de unión.** Un código incorrecto y un código expirado devuelven un `404` **idéntico** — no hay canal lateral de «existe vs. expirado».
- **CSP estricta en la página de unión.** La página `/j` envía una Content-Security-Policy estricta (sin scripts `unsafe-inline`), `nosniff` y una postura CORS de fallo cerrado.

Todo el detalle está en [`docs/protocol.md`](docs/protocol.md) y [`docs/threat-model.md`](docs/threat-model.md).

---

## 📡 Endpoints

Todos bajo el prefijo `/api/v1` (versión de protocolo `1`).

| Método | Ruta | Auth | Propósito |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sessions` | — | Registrar una sesión de host; devuelve un código de unión + token de host. |
| `PATCH` | `/api/v1/sessions/:id` | token de host | Heartbeat y/o actualizar candidatos. |
| `DELETE` | `/api/v1/sessions/:id` | token de host | Desmontar una sesión. |
| `GET` | `/api/v1/join/:code` | — | Resolver un código de unión a sus candidatos de host. |
| `GET` | `/j/:code` | — | La **página de unión** para personas. |
| `GET` | `/api/v1/update/:channel` | — | La decisión del **update-gate** de escritorio (`go` / `hold`). |

---

## 📖 Ejecutar y desplegar

**Node.js 22+** y **TypeScript** (Fastify). Sin base de datos — las sesiones viven en memoria y expiran.

```bash
npm install
npm run build          # tsc -> dist/
node dist/server.js    # escucha en 127.0.0.1:8787 por defecto
```

### 🐳 Docker

```bash
docker compose up -d   # usa el Dockerfile + compose.yml incluidos
```

### 🌐 Detrás de Caddy

En producción el servicio corre detrás de **Caddy** en `gw.razzoozle.xyz` para TLS y un nombre de host público — ver [`Caddyfile.example`](Caddyfile.example). Las notas operativas (TTLs, env, interruptor de apagado) están en [`docs/operations.md`](docs/operations.md).

---

## 🚦 Estado

**Beta — trabajo en curso.** El contrato de rendezvous + update-gate está implementado y probado; se conecta junto a [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop), cuyo registro/heartbeat de sesión de gateway va llegando de forma incremental.

---

## 🔗 Proyectos relacionados

- **[Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** — la app de escritorio para Windows que este gateway ayuda a los teléfonos a descubrir.
- **[Razzoozle](https://github.com/joehomeskillet/Razzoozle)** — la plataforma de cuestionarios en vivo auto-alojada que ejecuta la app de escritorio.

---

## 📝 Créditos y licencia

Razzoozle Gateway es parte del proyecto [**Razzoozle**](https://github.com/joehomeskillet/Razzoozle), que es un fork de [**Ralex91/Razzia**](https://github.com/Ralex91/Razzia) — muchísimas gracias a los autores originales. Publicado bajo la **Licencia MIT**; se conserva el linaje MIT de Razzoozle/Razzia.
