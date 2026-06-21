// GET /j/:code human page (§8, F4). Routes the phone to the host's OWN http
// origin by TOP-LEVEL NAVIGATION. It does NOT fetch/ws-probe http candidates
// from this https page (mixed-content / PNA, §8.1). No game data anywhere.
//
// The QR is generated as an <img src="…/qr.svg"> served same-origin by the
// gateway (no external CDN, no client-side encoder). The candidate URL itself
// is only ever opened by a user-gesture top-level navigation.
//
// C1 (XSS) hardening: the join code is NEVER interpolated into a <script>
// context. It is (a) sanitized to the join-code charset BEFORE rendering — an
// invalid code renders the same page as an empty code (no oracle), and (b)
// HTML-escaped into a `data-code` attribute that the EXTERNAL bootstrap script
// reads via `.dataset`. The bootstrap is a static same-origin file (/j/app.js)
// so the response CSP can forbid inline script entirely (no 'unsafe-inline').

import { JOIN_CODE_RE } from "./schemas.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Sanitize the path param to the join-code charset. Anything outside the
// charset (or wrong length) collapses to "" — which renders the same
// empty/"unknown code" page the client resolves to a 404 (preserves no-oracle).
export function sanitizeJoinCode(raw: string): string {
  const code = raw.toUpperCase();
  return JOIN_CODE_RE.test(code) ? code : "";
}

export function renderJoinPage(rawCode: string): string {
  const code = sanitizeJoinCode(rawCode);
  // Charset-sanitized AND HTML-escaped — defence in depth; after sanitize the
  // code is already [A-Z2-9]{6} or "", so escapeHtml is a no-op but kept.
  const safeCode = escapeHtml(code);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Join ${safeCode} - Razzoozle</title>
<link rel="stylesheet" href="/j/app.css">
</head>
<body data-code="${safeCode}">
  <h1>Join game <span class="code">${safeCode}</span></h1>
  <div id="status" class="muted">Looking up host&hellip;</div>
  <div id="action" hidden>
    <div id="lan-section">
      <p class="section-label">Join game on this Wi-Fi</p>
      <ul id="lan-cands" class="cands"></ul>
    </div>
    <div id="remote-section" hidden>
      <p class="section-label">Join from outside / Remote</p>
      <p>If the first link does not open the game, try the next one - this page cannot test the links for you.</p>
      <ul id="remote-cands" class="cands"></ul>
    </div>
    <div id="empty-state" hidden>
      <p>Tap an address to open the host. If the first link does not open the game,
         try the next one - this page cannot test the links for you.</p>
      <ul id="cands" class="cands"></ul>
    </div>
  </div>
  <div id="fail" class="warn" hidden></div>
  <p class="warn">You must be on the <strong>same Wi-Fi</strong> as the host for a
     LAN game. This link sends your browser straight to the host - the gateway
     never sees the game.</p>
  <p><button id="retry" class="btn" type="button">Try again</button></p>
<script src="/j/app.js"></script>
</body>
</html>`;
}

// Static stylesheet (served same-origin, CSP style-src 'self').
export const JOIN_PAGE_CSS = `:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem;
       max-width: 32rem; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.25rem; }
.code { font-size: 2rem; letter-spacing: .2em; font-weight: 700; }
.btn { display: inline-block; padding: .9rem 1.4rem; margin: .5rem 0;
       background: #2563eb; color: #fff; text-decoration: none;
       border: 0; border-radius: .5rem; font-weight: 600; cursor: pointer; }
.muted { color: #666; font-size: .9rem; }
.section-label { font-weight: 600; margin: 1.5rem 0 .75rem 0; font-size: .95rem; }
.cands { list-style: none; padding: 0; margin: 1rem 0; }
.cand { border: 1px solid #d4d4d8; border-radius: .6rem; padding: .9rem 1rem;
        margin: .75rem 0; }
.cand-head { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.cand-kind { font-weight: 700; text-transform: uppercase; font-size: .75rem;
             letter-spacing: .05em; color: #3f3f46;
             /* ponytail: kind text rendered as-is via textContent; CSS only */ }
.cand-head .btn { margin: 0; }
.cand-url { word-break: break-all; margin-top: .4rem; }
.cand-note { margin-top: .4rem; }
.cand-qr { width: 140px; height: 140px; image-rendering: pixelated;
           margin-top: .6rem; display: block; }
.warn { background: #fff7ed; border: 1px solid #fdba74; padding: .75rem 1rem;
        border-radius: .5rem; font-size: .9rem; margin: .75rem 0; }
`;

// Static bootstrap script (served same-origin, CSP script-src 'self'). Reads
// the sanitized join code from body[data-code]; never receives it via inline
// interpolation. Candidate kind/url are injected via .textContent / setAttribute
// (DOM API, no innerHTML for candidate data) so a hostile candidate value cannot
// inject markup. Phase 4: render LAN candidates with target="_blank" for same-tab
// gateway survival; public/manual/ipv6 candidates as same-tab top-level-nav.
export const JOIN_PAGE_JS = `(function () {
  var CODE = document.body.getAttribute('data-code') || '';
  var statusEl = document.getElementById('status');
  var actionEl = document.getElementById('action');
  var failEl = document.getElementById('fail');
  var lanSection = document.getElementById('lan-section');
  var remoteSection = document.getElementById('remote-section');
  var emptyState = document.getElementById('empty-state');
  var lanCandsEl = document.getElementById('lan-cands');
  var remoteCandsEl = document.getElementById('remote-cands');
  var candsEl = document.getElementById('cands');

  // Defense-in-depth (F4): only http/https candidate urls become a clickable
  // href. A non-http(s) scheme (javascript:, data:, …) is NEVER set as href.
  // Parse with the URL API; reject anything unparseable or non-http(s).
  function safeHttpUrl(raw) {
    try {
      var u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
    } catch (e) {}
    return null;
  }

  function showFail(msg) {
    actionEl.hidden = true; failEl.hidden = false; failEl.textContent = msg;
    statusEl.hidden = true;
  }

  function renderCandidate(c, index, isLan) {
    var url = safeHttpUrl(c.url);
    var li = document.createElement('li');
    li.className = 'cand';

    var head = document.createElement('div');
    head.className = 'cand-head';
    var kindEl = document.createElement('span');
    kindEl.className = 'cand-kind';
    kindEl.textContent = c.kind; // textContent => kind is inert text, not markup
    head.appendChild(kindEl);

    if (url) {
      var a = document.createElement('a');
      a.className = 'btn';
      // setAttribute keeps a hostile url out of any HTML-parsing sink; the URL
      // API already vetted the scheme. Top-level nav to the host's own origin.
      a.setAttribute('href', url);
      a.setAttribute('rel', 'noopener noreferrer');
      // LAN candidates open in a new tab so the HTTPS gateway tab survives as
      // the relay/fallback. Public/manual/ipv6 candidates open same-tab.
      if (isLan) {
        a.setAttribute('target', '_blank');
        a.textContent = 'Join on this Wi-Fi'; // LAN-specific copy
      } else {
        a.textContent = 'Open game'; // url shown separately below, also as text
      }
      head.appendChild(a);
    } else {
      var bad = document.createElement('span');
      bad.className = 'muted';
      bad.textContent = 'unsupported address'; // non-http(s): not clickable
      head.appendChild(bad);
    }
    li.appendChild(head);

    var urlEl = document.createElement('div');
    urlEl.className = 'cand-url muted';
    urlEl.textContent = c.url; // raw url as inert text (escaped by the DOM)
    li.appendChild(urlEl);

    if (isLan) {
      var note = document.createElement('div');
      note.className = 'cand-note muted';
      note.textContent = 'Opens in a new tab. If it does not work, close this tab and try from outside.';
      li.appendChild(note);
    }

    if (url) {
      // Per-candidate QR, rendered same-origin by the gateway from THIS url.
      var img = document.createElement('img');
      img.className = 'cand-qr';
      img.alt = 'QR code for ' + c.kind + ' address';
      img.src = '/j/' + encodeURIComponent(CODE) + '/qr.svg?i=' + index;
      li.appendChild(img);
    }
    return li;
  }

  async function resolve() {
    statusEl.hidden = false; statusEl.textContent = 'Looking up host\\u2026';
    failEl.hidden = true; actionEl.hidden = true;
    var res;
    try {
      // SAME-ORIGIN https fetch to the gateway - allowed. We never fetch the
      // candidate urls themselves (http LAN hosts; mixed-content / PNA, F4).
      res = await fetch('/api/v1/join/' + encodeURIComponent(CODE),
                        { headers: { 'accept': 'application/json' } });
    } catch (e) {
      showFail('Could not reach the gateway. Check your connection and try again.');
      return;
    }
    if (res.status === 404) {
      showFail('This code is not valid (it may have expired). Ask the host for a new one.');
      return;
    }
    if (!res.ok) { showFail('Lookup failed. Try again in a moment.'); return; }
    var data = await res.json();
    var cands = data.candidates || [];
    if (!cands.length) {
      // Zero candidates: keep the existing graceful state (no buttons, a note).
      showFail(data.message || 'Host has no reachable addresses right now.');
      return;
    }
    // The gateway returns candidates already in player-facing order (lan first,
    // then public-ipv6/ipv4, then manual, upnp last; numeric priority within a
    // kind). The per-candidate QR at /j/<code>/qr.svg?i=<index> indexes into
    // this SAME order, so each QR encodes its own candidate's url.
    lanCandsEl.textContent = ''; // clear; never innerHTML with candidate data
    remoteCandsEl.textContent = ''; // clear
    candsEl.textContent = ''; // clear

    var hasLan = false;
    var hasRemote = false;

    cands.forEach(function (c, i) {
      if (c.kind === 'lan') {
        hasLan = true;
        lanCandsEl.appendChild(renderCandidate(c, i, true));
      } else {
        hasRemote = true;
        remoteCandsEl.appendChild(renderCandidate(c, i, false));
      }
    });

    // Layout: if we have LAN candidates, show them prominently. If we also have
    // remote, show remote below. If NO LAN (edge case: shouldn't happen in normal
    // flow), fall back to the legacy flat list.
    if (hasLan) {
      lanSection.hidden = false;
      emptyState.hidden = true;
      if (hasRemote) {
        remoteSection.hidden = false;
      }
    } else {
      // Fallback: no LAN found, show all candidates in legacy flat layout
      lanSection.hidden = true;
      remoteSection.hidden = true;
      emptyState.hidden = false;
      cands.forEach(function (c, i) { candsEl.appendChild(renderCandidate(c, i, false)); });
    }

    statusEl.hidden = true; actionEl.hidden = false;
    if (data.status === 'offline') {
      statusEl.hidden = false;
      statusEl.textContent = 'Host may be offline - the addresses might be stale.';
    }
  }
  document.getElementById('retry').addEventListener('click', resolve);
  resolve();
})();
`;
