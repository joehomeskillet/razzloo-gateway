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
    <p>Tap to open the host on your network:</p>
    <a id="goLink" class="btn" href="#" rel="noopener noreferrer">Open game</a>
    <div id="qr"></div>
    <p class="muted">Or scan the QR with another phone on the same Wi-Fi.</p>
    <details>
      <summary>Other addresses</summary>
      <ul id="others"></ul>
    </details>
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
ul { padding-left: 1.2rem; }
#qr img { width: 180px; height: 180px; image-rendering: pixelated; }
.warn { background: #fff7ed; border: 1px solid #fdba74; padding: .75rem 1rem;
        border-radius: .5rem; font-size: .9rem; margin: .75rem 0; }
`;

// Static bootstrap script (served same-origin, CSP script-src 'self'). Reads
// the sanitized join code from body[data-code]; never receives it via inline
// interpolation. Candidate URLs are injected via .textContent / element.href
// (DOM API, no HTML parsing) so a hostile candidate URL cannot inject markup.
export const JOIN_PAGE_JS = `(function () {
  var CODE = document.body.getAttribute('data-code') || '';
  var statusEl = document.getElementById('status');
  var actionEl = document.getElementById('action');
  var failEl = document.getElementById('fail');
  var goLink = document.getElementById('goLink');
  var othersEl = document.getElementById('others');
  var qrEl = document.getElementById('qr');

  function showFail(msg) {
    actionEl.hidden = true; failEl.hidden = false; failEl.textContent = msg;
    statusEl.hidden = true;
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
      showFail(data.message || 'Host has no reachable addresses right now.');
      return;
    }
    // Candidates are priority-sorted by the gateway. Offer the first for a
    // user-gesture TOP-LEVEL navigation; list the rest. No auto-redirect.
    var primary = cands[0];
    goLink.href = primary.url;
    othersEl.innerHTML = '';
    cands.slice(1).forEach(function (c) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = c.url; a.textContent = c.kind + ': ' + c.url;
      a.rel = 'noopener noreferrer';
      li.appendChild(a); othersEl.appendChild(li);
    });
    // QR rendered server-side, same-origin, from the gateway.
    qrEl.innerHTML = '';
    var img = document.createElement('img');
    img.alt = 'QR code to the host';
    img.src = '/j/' + encodeURIComponent(CODE) + '/qr.svg';
    qrEl.appendChild(img);
    statusEl.hidden = true; actionEl.hidden = false;
    if (data.status === 'offline') {
      statusEl.hidden = false;
      statusEl.textContent = 'Host may be offline - the address might be stale.';
    }
  }
  document.getElementById('retry').addEventListener('click', resolve);
  resolve();
})();
`;
