// F6 / §6.1 — candidate.url write-time validation. Validation, NOT probing.
// The gateway never opens a socket and never resolves DNS here; it only parses
// and range-checks the literal string. This is the SSRF-avoidance boundary.

import type { HostCandidateKind } from "./schemas.js";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Returns an error message string if the url is invalid for the given kind,
 * or null if it passes. The caller maps any non-null to `invalid_candidate_url`.
 */
export function validateCandidateUrl(
  raw: string,
  kind: HostCandidateKind,
): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url is not a parseable URL";
  }

  // Scheme: http|https only. Rejects javascript:, file:, data:, ws:, wss:, ftp:, …
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    return `scheme ${u.protocol} not allowed (http/https only)`;
  }

  // Authority must be host:port only — no userinfo, no path beyond "/",
  // no query, no fragment (host-smuggling vectors).
  if (u.username !== "" || u.password !== "") {
    return "userinfo not allowed in candidate url";
  }
  if (u.pathname !== "" && u.pathname !== "/") {
    return "path not allowed in candidate url";
  }
  if (u.search !== "" || u.hash !== "") {
    return "query/fragment not allowed in candidate url";
  }
  if (u.hostname === "") {
    return "missing host";
  }

  const host = stripBrackets(u.hostname);
  // "lan"       = genuine RFC1918 / link-local / unique-local (valid as kind:lan)
  // "forbidden" = loopback / reserved / special-use (never a public candidate,
  //               and not a usable LAN address either)
  // "public"    = globally-routable
  // null        = not an IP literal (a hostname)
  const ipClass = classifyIpLiteral(host);

  if (kind === "lan") {
    // lan candidates must be a genuine private/LAN range literal (not reserved).
    if (ipClass !== "lan") {
      return "lan candidate must be an RFC1918 / link-local / unique-local address";
    }
    return null;
  }

  if (kind === "public-ipv4" || kind === "public-ipv6" || kind === "upnp") {
    // public-* / upnp candidates must NOT be private/loopback/reserved.
    if (ipClass === "lan" || ipClass === "forbidden") {
      return `${kind} candidate must not be a private/loopback/reserved address`;
    }
    // A hostname (ipClass === null) or a public IP literal is allowed.
    return null;
  }

  // kind === "manual": hostname (DDNS/tunnel) allowed; if it's an IP literal it
  // must be public. The gateway never resolves DNS (§6.1).
  if (kind === "manual") {
    if (ipClass === "lan" || ipClass === "forbidden") {
      return "manual candidate IP literal must not be private/loopback/reserved";
    }
    return null;
  }

  return "unknown candidate kind";
}

function stripBrackets(host: string): string {
  // WHATWG URL keeps IPv6 hosts bracketed in .hostname only sometimes; normalize.
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

type IpClass = "lan" | "forbidden" | "public";

/**
 * Classify an IP literal as:
 *   "lan"       — RFC1918 / link-local / unique-local (a genuine LAN address)
 *   "forbidden" — loopback / reserved / special-use / multicast / unspecified
 *   "public"    — globally-routable
 * Returns null when the host is not an IP literal (a hostname).
 */
function classifyIpLiteral(host: string): IpClass | null {
  const v4 = parseIPv4(host);
  if (v4 !== null) return classifyIPv4(v4);

  const v6 = parseIPv6(host);
  if (v6 !== null) return classifyIPv6(v6, host);

  return null; // hostname, not an IP literal
}

// ── IPv4 ────────────────────────────────────────────────────────────────────

function parseIPv4(host: string): number[] | null {
  // Strict dotted-quad only (reject octal/hex/integer forms — they are
  // ambiguity/bypass vectors).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map((s) => Number(s));
  for (const o of octets) {
    if (o > 255) return null;
    // reject leading-zero forms like "010" (octal ambiguity)
  }
  if (m.slice(1, 5).some((s) => s.length > 1 && s.startsWith("0"))) return null;
  return octets;
}

function classifyIPv4(o: number[]): IpClass {
  const [a, b] = o as [number, number, number, number];
  // genuine LAN ranges (valid as kind:lan)
  if (a === 10) return "lan"; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return "lan"; // RFC1918
  if (a === 192 && b === 168) return "lan"; // RFC1918
  if (a === 169 && b === 254) return "lan"; // link-local 169.254/16
  // forbidden / special-use (not a public candidate, not a usable LAN address)
  if (a === 127) return "forbidden"; // loopback 127/8
  if (a === 0) return "forbidden"; // unspecified / "this host" 0/8
  if (a === 100 && b >= 64 && b <= 127) return "forbidden"; // CGNAT 100.64/10
  if (a >= 224) return "forbidden"; // 224/4 multicast + 240/4 reserved
  if (a === 192 && b === 0) return "forbidden"; // 192.0.0/24, 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return "forbidden"; // 198.18/15 benchmark
  if (a === 198 && b === 51) return "forbidden"; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0) return "forbidden"; // 203.0.113/24 TEST-NET-3
  return "public";
}

// ── IPv6 ────────────────────────────────────────────────────────────────────

function parseIPv6(host: string): number[] | null {
  // Returns 8 16-bit groups, or null if not a valid IPv6 literal.
  // Handles "::" compression and embedded IPv4 tail.
  if (!host.includes(":")) return null;

  let h = host;
  // zone id (fe80::1%eth0) — strip for classification.
  // L1 (usability-only, intentionally NOT fixed): we discard the zone id rather
  // than reject it. A link-local literal with a zone id is classified by its
  // address bits alone; the zone is a host-side scope hint, not a security
  // boundary here (it never widens an address's class), so dropping it is safe.
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);

  const halves = h.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === "") return [];
    const segs = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      // embedded IPv4 tail
      if (s.includes(".")) {
        if (i !== segs.length - 1) return null;
        const v4 = parseIPv4(s);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return null;
      out.push(parseInt(s, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const left = expand(halves[0]!);
    const right = expand(halves[1]!);
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...new Array(fill).fill(0), ...right];
  }

  const all = expand(h);
  if (all === null || all.length !== 8) return null;
  return all;
}

function classifyIPv6(groups: number[], _original: string): IpClass {
  const g0 = groups[0]!;
  // unspecified ::
  if (groups.every((g) => g === 0)) return "forbidden";
  // loopback ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "forbidden";
  // link-local fe80::/10 (genuine LAN)
  if ((g0 & 0xffc0) === 0xfe80) return "lan";
  // unique-local fc00::/7 (genuine LAN)
  if ((g0 & 0xfe00) === 0xfc00) return "lan";
  // multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return "forbidden";
  // IPv4-mapped ::ffff:0:0/96 — ALWAYS reconstruct the embedded v4 from the
  // low groups and classify it. WHATWG URL canonicalizes `::ffff:127.0.0.1`
  // to `::ffff:7f00:1` (no dot), so we must NOT gate on a literal "." in the
  // input — that gate let mapped loopback/private/metadata through as public
  // (H1). The same /96 prefix is also IPv4-translated (RFC 6052); both are
  // never a legitimate public host candidate, so reconstruct-and-classify.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const g6 = groups[6]!;
    const g7 = groups[7]!;
    const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
    // ::ffff:0:0 (the /96 base, all-zero v4) is itself unspecified-equivalent.
    return classifyIPv4(v4);
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — not a real host.
  if (g0 === 0x0064 && groups[1] === 0xff9b) return "forbidden";
  // documentation 2001:db8::/32
  if (g0 === 0x2001 && groups[1] === 0x0db8) return "forbidden";
  return "public";
}
