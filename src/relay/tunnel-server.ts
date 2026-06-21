// R0/R1 relay tunnel server: CONTROL + DATA WebSocket endpoints and the raw TCP
// player listener. Implements the relay wire contract (raw byte-pipe over WS)
// plus the R1 §A multi-session hardening:
//   P0-1  ONE shared tunnels Map, injected by the caller (no split map).
//   P0-2  one-active-tunnel-per-session (re-dial clobber + identity guards).
//   P0-3  two-way store<->tunnel TTL binding (heartbeat on traffic, onExpire teardown).
//   P1    per-session pending cap, parked-socket leak fix, backpressure symmetry,
//         data-ws live-status check.
// SECURITY: host token travels in the `Authorization: Bearer <rawHostToken>`
//   upgrade header, never the query string; nothing logs the token.

import { randomUUID } from "node:crypto";
import net from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import type { SessionStore, SessionRecord } from "../store.js";
import type { Config } from "../config.js";

export interface Tunnel {
  control: WebSocket;
  pending: Map<
    string,
    {
      sock: net.Socket;
      head: Buffer;
      timeoutHandle?: NodeJS.Timeout;
      onSockClose?: () => void;
    }
  >;
}

type RelayMessage = {
  t: "open";
  stream: string;
};

// Read the RAW host token from the WS upgrade Authorization header. Returns null
// when absent/malformed. The token NEVER comes from the query string (§A SECURITY).
function bearerToken(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t === "" ? null : t;
}

// A session is "live" for relay purposes once its derived status is anything but
// expired (waiting/online/offline). refreshStatus() must run first.
function isLive(store: SessionStore, rec: SessionRecord): boolean {
  store.refreshStatus(rec, Date.now());
  return rec.status !== "expired";
}

// Drain a tunnel: clear every parked timeout, detach close listeners, destroy
// every pending player socket, then empty the pending map. Does NOT touch the
// control WS (callers decide whether to close it).
function drainPending(tunnel: Tunnel): void {
  for (const p of tunnel.pending.values()) {
    if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
    if (p.onSockClose) p.sock.removeListener("close", p.onSockClose);
    p.sock.destroy();
  }
  tunnel.pending.clear();
}

export async function attachRelay(
  app: FastifyInstance,
  store: SessionStore,
  config: Config,
  tunnels: Map<string, Tunnel>,
): Promise<void> {
  // P0-3: store expiry/unregister tears the matching tunnel down. The store
  // fires this AFTER the row is gone, so we never close a tunnel whose row is
  // still live. Identity is implicit here (one tunnel per code in the map).
  store.setOnExpire((joinCode) => {
    const tunnel = tunnels.get(joinCode);
    if (!tunnel) return;
    tunnels.delete(joinCode);
    drainPending(tunnel);
    if (
      tunnel.control.readyState === WebSocket.OPEN ||
      tunnel.control.readyState === WebSocket.CONNECTING
    ) {
      tunnel.control.close(4410, "session_expired");
    }
  });

  // CONTROL: GET /relay?sessionId=<id>   (token in Authorization: Bearer header)
  const handleControlWs = (ws: WebSocket, sessionId: string, token: string) => {
    const rec = store.getById(sessionId);
    if (!rec) {
      ws.close(4404, "session_not_found");
      return;
    }
    if (!store.tokenMatches(rec, token)) {
      ws.close(4401, "token_mismatch");
      return;
    }
    if (!isLive(store, rec)) {
      ws.close(4410, "session_expired");
      return;
    }

    const joinCode = rec.joinCode;

    // P0-2: one active tunnel per session. If a tunnel already exists for this
    // code (host reconnect / re-dial), close the OLD control WS and drain its
    // pending BEFORE installing the new tunnel, so the stale close handler's
    // identity guard sees it is no longer the owner and leaves the new slot.
    const existing = tunnels.get(joinCode);
    if (existing && existing.control !== ws) {
      tunnels.delete(joinCode);
      drainPending(existing);
      if (
        existing.control.readyState === WebSocket.OPEN ||
        existing.control.readyState === WebSocket.CONNECTING
      ) {
        existing.control.close(4409, "replaced_by_new_dial");
      }
    }

    const tunnel: Tunnel = { control: ws, pending: new Map() };
    tunnels.set(joinCode, tunnel);

    // P0-2 identity guard: only the owning tunnel may remove the slot.
    const teardown = () => {
      if (tunnels.get(joinCode) === tunnel) tunnels.delete(joinCode);
      drainPending(tunnel);
    };

    ws.on("close", teardown);
    ws.on("error", teardown);

    // P0-3: any control-WS message is tunnel activity -> slide the store TTL so
    // an actively-piping session never expires mid-game.
    ws.on("message", () => {
      const cur = store.getById(sessionId);
      if (cur) store.heartbeat(cur);
    });
  };

  // DATA: GET /relay-data?stream=<streamToken>&sessionId=<id>  (token in header)
  const handleDataWs = (
    ws: WebSocket,
    streamToken: string,
    sessionId: string,
    token: string,
  ) => {
    const rec = store.getById(sessionId);
    if (!rec) {
      ws.close(4404, "session_not_found");
      return;
    }
    if (!store.tokenMatches(rec, token)) {
      ws.close(4401, "token_mismatch");
      return;
    }
    // P1: a data-ws on an expired session must not splice.
    if (!isLive(store, rec)) {
      ws.close(4410, "session_expired");
      return;
    }

    const tunnel = tunnels.get(rec.joinCode);
    const pending = tunnel?.pending.get(streamToken);
    if (!tunnel || !pending) {
      ws.close(4404, "stream_not_found");
      return;
    }

    // Claim the stream: clear the park timeout + the parked-close listener.
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    if (pending.onSockClose) pending.sock.removeListener("close", pending.onSockClose);
    tunnel.pending.delete(streamToken);
    const { sock, head } = pending;

    // P0-3: data-WS traffic also slides the TTL.
    const touch = () => {
      const cur = store.getById(sessionId);
      if (cur) store.heartbeat(cur);
    };
    touch();

    // Send the buffered request head first, then bidirectional raw splice.
    ws.send(head, { binary: true }, (err) => {
      if (err) {
        sock.destroy();
        ws.close();
        return;
      }

      // player sock -> DATA ws (sock->ws backpressure: already handled below)
      sock.on("data", (chunk: Buffer) => {
        touch();
        ws.send(chunk, { binary: true }, (sendErr) => {
          if (sendErr) {
            sock.destroy();
            ws.close();
          }
        });
      });

      // DATA ws -> player sock. Backpressure symmetry: when sock.write() returns
      // false, pause the ws; resume on the sock 'drain'.
      let wsPausedForSock = false;
      ws.on("message", (msg: WebSocket.Data) => {
        touch();
        const buffer = Buffer.isBuffer(msg)
          ? msg
          : Array.isArray(msg)
            ? Buffer.concat(msg)
            : Buffer.from(msg as ArrayBuffer);
        if (!sock.write(buffer)) {
          wsPausedForSock = true;
          ws.pause();
        }
      });

      sock.on("drain", () => {
        if (wsPausedForSock) {
          wsPausedForSock = false;
          ws.resume();
        }
      });

      // Close either side -> close the other.
      sock.on("close", () => ws.close());
      sock.on("error", () => ws.close());
      ws.on("close", () => sock.destroy());
      ws.on("error", () => sock.destroy());

      // Resume the player socket (it was paused while parked).
      sock.resume();
    });
  };

  // Two noServer WS servers, routed by upgrade pathname on the fastify HTTP server.
  const controlWs = new WebSocketServer({ noServer: true });
  const dataWs = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== "/relay" && pathname !== "/relay-data") return;

    // SECURITY: token from the Authorization header only — never the query.
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      sock.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      sock.destroy();
      return;
    }

    if (pathname === "/relay") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        sock.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        sock.destroy();
        return;
      }
      controlWs.handleUpgrade(req, sock, head, (client: WebSocket) => {
        handleControlWs(client, sessionId, token);
      });
      return;
    }

    // /relay-data
    const stream = url.searchParams.get("stream");
    const sessionId = url.searchParams.get("sessionId");
    if (!stream || !sessionId) {
      sock.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      sock.destroy();
      return;
    }
    dataWs.handleUpgrade(req, sock, head, (client: WebSocket) => {
      handleDataWs(client, stream, sessionId, token);
    });
  });
}

export function startRelayListener(
  store: SessionStore,
  config: Config,
  tunnels: Map<string, Tunnel>,
): net.Server {
  const server = net.createServer((sock) => {
    // The socket stays in flowing mode to ACCUMULATE the request head. Once the
    // head is complete we pause it (parking) so the buffered live bytes are
    // replayed only after the DATA splice resumes it. (Pausing BEFORE attaching
    // the 'data' handler would stall the header read entirely — the R0 bug.)
    let head = Buffer.alloc(0);
    let headComplete = false;

    const onData = (chunk: Buffer) => {
      if (headComplete) return;
      head = Buffer.concat([head, chunk]);

      if (head.includes("\r\n\r\n")) {
        headComplete = true;
        sock.removeListener("data", onData);
        sock.pause(); // park: buffer any post-head bytes until the splice resumes
        processRequest();
      } else if (head.length > 8192) {
        headComplete = true;
        sock.removeListener("data", onData);
        sock.write(
          "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        sock.end();
      }
    };

    const processRequest = () => {
      const headStr = head.toString("utf-8", 0, Math.min(head.length, 2048));
      const hostMatch = headStr.match(/Host:\s*([^\r\n]+)/i);
      if (!hostMatch) {
        sock.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        sock.end();
        return;
      }

      const host = hostMatch[1]!.trim();
      const code = host.split(":")[0]!.split(".")[0]!;
      const tunnel = tunnels.get(code);
      if (!tunnel) {
        sock.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        sock.end();
        return;
      }

      // P1: per-session pending cap -> reject with 503 once exceeded.
      if (tunnel.pending.size >= config.relayMaxPendingStreams) {
        sock.write(
          "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        sock.end();
        return;
      }

      const streamToken = randomUUID();

      // P1: park timeout — 504 if no DATA ws claims the stream in time. Cleared
      // in EVERY exit path (claim in handleDataWs, early client close below).
      const timeout = setTimeout(() => {
        const entry = tunnel.pending.get(streamToken);
        if (entry) {
          if (entry.onSockClose) sock.removeListener("close", entry.onSockClose);
          tunnel.pending.delete(streamToken);
          sock.write(
            "HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          );
          sock.end();
        }
      }, config.relayParkMs);

      // P1 parked-socket leak: if the client hangs up while parked, drop the
      // pending entry + clear the park timeout immediately.
      const onSockClose = () => {
        const entry = tunnel.pending.get(streamToken);
        if (entry) {
          if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
          tunnel.pending.delete(streamToken);
        }
      };
      sock.on("close", onSockClose);

      tunnel.pending.set(streamToken, {
        sock,
        head,
        timeoutHandle: timeout,
        onSockClose,
      });

      const msg: RelayMessage = { t: "open", stream: streamToken };
      tunnel.control.send(JSON.stringify(msg), (err) => {
        if (err) {
          const entry = tunnel.pending.get(streamToken);
          if (entry) {
            if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
            sock.removeListener("close", onSockClose);
            tunnel.pending.delete(streamToken);
          }
          sock.destroy();
        }
      });
    };

    sock.on("data", onData);
    sock.on("error", () => sock.destroy());
  });

  server.listen({ port: config.relayPort, host: config.host }, () => {
    // eslint-disable-next-line no-console
    console.log(`razzloo-relay listening on ${config.host}:${config.relayPort}`);
  });

  // Cleanup on close: destroy all pending socks + close all control WS, then
  // empty the SHARED map. (The map is owned by the caller; we clear its rows.)
  const originalClose = server.close.bind(server);
  server.close = function (cb?: (err?: Error) => void) {
    for (const tunnel of tunnels.values()) {
      drainPending(tunnel);
      if (tunnel.control.readyState === WebSocket.OPEN) {
        tunnel.control.close();
      }
    }
    tunnels.clear();
    return originalClose(cb);
  } as typeof server.close;

  return server;
}
