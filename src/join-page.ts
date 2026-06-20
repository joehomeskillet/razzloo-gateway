// GET /j/:code human page (§8, F4). Routes the phone to the host's OWN http
// origin by TOP-LEVEL NAVIGATION. It does NOT fetch/ws-probe http candidates
// from this https page (mixed-content / PNA, §8.1). No game data anywhere.
//
// The QR is generated as an <img src="…/qr.svg"> served same-origin by the
// gateway (no external CDN, no client-side encoder). The candidate URL itself
// is only ever opened by a user-gesture top-level navigation.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderJoinPage(code: string): string {
  const safeCode = escapeHtml(code.toUpperCase());
  const jsonCode = JSON.stringify(code.toUpperCase());
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Join ${safeCode} - Razzoozle</title>
<style>
  :root { color-scheme: light dark; }
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
</style>
</head>
<body>
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
<script>
const CODE = ${jsonCode};
const statusEl = document.getElementById('status');
const actionEl = document.getElementById('action');
const failEl = document.getElementById('fail');
const goLink = document.getElementById('goLink');
const othersEl = document.getElementById('others');
const qrEl = document.getElementById('qr');

function showFail(msg) {
  actionEl.hidden = true; failEl.hidden = false; failEl.textContent = msg;
  statusEl.hidden = true;
}

async function resolve() {
  statusEl.hidden = false; statusEl.textContent = 'Looking up host\\u2026';
  failEl.hidden = true; actionEl.hidden = true;
  let res;
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
  const data = await res.json();
  const cands = data.candidates || [];
  if (!cands.length) {
    showFail(data.message || 'Host has no reachable addresses right now.');
    return;
  }
  // Candidates are priority-sorted by the gateway. Offer the first for a
  // user-gesture TOP-LEVEL navigation; list the rest. No auto-redirect.
  const primary = cands[0];
  goLink.href = primary.url;
  othersEl.innerHTML = '';
  cands.slice(1).forEach(function (c) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = c.url; a.textContent = c.kind + ': ' + c.url;
    a.rel = 'noopener noreferrer';
    li.appendChild(a); othersEl.appendChild(li);
  });
  // QR rendered server-side, same-origin, from the gateway.
  qrEl.innerHTML = '';
  const img = document.createElement('img');
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
</script>
</body>
</html>`;
}
