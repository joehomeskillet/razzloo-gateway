// GET / — public FLAT-CREAM animated stats dashboard. Mirrors src/join-page.ts:
// HTML/CSS/JS exported as string consts, served same-origin under JOIN_PAGE_CSP.
//
// PRIVACY: this page (and the /api/v1/stats it polls) expose ONLY aggregate
// integer counts. NEVER a join code / sessionId / hostId / IP / candidate URL /
// token hash. There is no per-request interpolation here — the HTML is fully
// static (no XSS sink).
//
// DESIGN (Razzoozle design.md §3): FLAT cream front-of-house. Cream field bg,
// white surface cards (hairline + ONE flat shadow + 16px radius), INK text
// (--game-fg:#0E1120 — the default white would render invisible on cream),
// violet/amber accents via tokens only, self-hosted Rubik. Identity = motion
// (count-up + staggered entrance + pulse), transform/opacity ONLY. NO
// backdrop-filter / blur / glass anywhere. prefers-reduced-motion honoured.
//
// CSP: the only script is the same-origin external <script src="/stats.js">.
// No inline script logic. Inline <style> is permitted by style-src
// 'unsafe-inline' and holds the token block + layout. font-src falls back to
// 'self' so /fonts/rubik.woff2 passes unchanged.

// Static stylesheet (served at /stats.css, CSP style-src 'self'). All colours go
// through var(--token); no raw hex in any rule body. The :root token block is
// emitted VERBATIM from design.md §3.
export const STATS_PAGE_CSS = `:root{
  /* --- Razzoozle cream design system (design.md §3) --- */
  --color-field-cream:#F4F1EA;
  --surface:#FFFFFF;
  --border-hairline:#E2DDD2;
  --color-primary:#7c3aed;        /* violet brand — white text OK on this FILL only */
  --color-secondary:#2e1065;      /* dark-ink headings */
  --color-accent:#ff9900;         /* AMBER accent — INK text on it, never white-on-amber on cream */
  --accent-contrast-text:#0E1120;
  --game-fg:#0E1120;              /* CRITICAL: ink fg. default white => invisible on cream */
  --radius-theme:16px;
  --shadow-flat:0 1px 2px rgba(14,17,32,.06), 0 10px 30px rgba(14,17,32,.07); /* ONE flat rung */
  --footer-bg:#ffffff; --footer-text:#1f2937;
  --rank-up:#10b981; --timer-urgent:#ff3b30;
  --font-display:'Rubik', system-ui, -apple-system, 'Segoe UI', sans-serif;

  /* --- page-local derived tokens (still tokens, not literals) --- */
  --ink-muted:#4A4F5C;            /* secondary label ink; ~7:1 on cream & white */
  --pulse-violet:var(--color-primary);
  --pulse-amber:var(--color-accent);
  --gap:clamp(.875rem,2.5vw,1.25rem);
  --ease-out:cubic-bezier(.22,.61,.36,1);
}
@font-face{
  font-family:'Rubik';
  src:url(/fonts/rubik.woff2) format('woff2');
  font-weight:300 700;           /* variable axis */
  font-style:normal;
  font-display:swap;
}

*,*::before,*::after{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{
  margin:0;
  background:var(--color-field-cream);
  color:var(--game-fg);
  font-family:var(--font-display);
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
}

.wrap{
  max-width:64rem;
  margin-inline:auto;
  padding:clamp(1.25rem,4vw,2.5rem);
}

.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:.75rem;
  margin-bottom:var(--gap);
}
.wordmark{
  margin:0;
  font-size:1.35rem;
  font-weight:700;
  color:var(--color-secondary);
  letter-spacing:-.01em;
}
.status{
  display:inline-flex;
  align-items:center;
  gap:.5rem;
  margin:0;
  font-size:.9rem;
  color:var(--ink-muted);
}
.pulse-dot{
  width:8px;height:8px;
  border-radius:50%;
  background:var(--pulse-violet);
  flex:0 0 auto;
  animation:pulse 2s var(--ease-out) infinite;
}
.status[data-live="zero"] .pulse-dot{background:var(--pulse-amber);}
.status[data-live="error"] .pulse-dot{
  background:var(--timer-urgent);
  animation-play-state:paused;
}

.hero{
  background:var(--surface);
  border:1px solid var(--border-hairline);
  box-shadow:var(--shadow-flat);
  border-radius:var(--radius-theme);
  padding:clamp(1.5rem,5vw,2.75rem);
  margin-block:var(--gap);
  position:relative;
}
.hero-label{
  margin:0;
  font-size:1rem;
  font-weight:600;
  letter-spacing:.04em;
  text-transform:uppercase;
  color:var(--ink-muted);
}
.hero-num{
  margin:.25rem 0 0;
  font-size:clamp(3.5rem,14vw,7rem);
  font-weight:700;
  line-height:.95;
  color:var(--game-fg);
  font-variant-numeric:tabular-nums slashed-zero;
}
.hero-underline{
  display:block;
  height:3px;
  width:min(8rem,40%);
  margin-top:1rem;
  background:var(--color-primary);
  border-radius:2px;
  transform-origin:left;
  transform:scaleX(0);
}
.wrap.in .hero-underline{
  transform:scaleX(1);
  transition:transform .7s var(--ease-out) .15s;
}

.grid{
  list-style:none;
  margin:0;
  padding:0;
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));
  gap:var(--gap);
}
.stat-card{
  background:var(--surface);
  border:1px solid var(--border-hairline);
  box-shadow:var(--shadow-flat);
  border-radius:var(--radius-theme);
  padding:clamp(1rem,2.5vw,1.5rem);
  display:flex;
  flex-direction:column;
  gap:.4rem;
  /* entrance: hidden until .in is toggled */
  opacity:0;
  transform:translateY(12px);
}
.wrap.in .stat-card{
  opacity:1;
  transform:none;
  transition:opacity .5s var(--ease-out), transform .5s var(--ease-out);
}
.wrap.in .stat-card:nth-child(1){transition-delay:.05s;}
.wrap.in .stat-card:nth-child(2){transition-delay:.1s;}
.wrap.in .stat-card:nth-child(3){transition-delay:.15s;}
.wrap.in .stat-card:nth-child(4){transition-delay:.2s;}
.wrap.in .stat-card:nth-child(5){transition-delay:.25s;}
.stat-label{
  font-size:.85rem;
  font-weight:600;
  color:var(--ink-muted);
  text-transform:uppercase;
  letter-spacing:.03em;
}
.stat-value{
  font-size:clamp(1.75rem,5vw,2.5rem);
  font-weight:700;
  color:var(--game-fg);
  font-variant-numeric:tabular-nums slashed-zero;
}

.foot{
  margin-top:calc(var(--gap)*2);
  padding-top:var(--gap);
  border-top:1px solid var(--border-hairline);
  color:var(--ink-muted);
  font-size:.85rem;
}
.foot p{margin:.25rem 0;}

.visually-hidden{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;
  overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;
}

a:focus-visible,button:focus-visible{
  outline:2px solid var(--color-primary);
  outline-offset:2px;
}

@keyframes pulse{
  0%,100%{opacity:1;transform:scale(1);}
  50%{opacity:.45;transform:scale(.8);}
}

@media (prefers-reduced-motion: reduce){
  .pulse-dot{animation:none;}
  .hero-underline,
  .wrap.in .hero-underline{transition:none;transform:scaleX(1);}
  .stat-card,
  .wrap.in .stat-card{transition:none;opacity:1;transform:none;}
}
`;

// Static bootstrap script (served at /stats.js, CSP script-src 'self'). Vanilla,
// no imports, no external calls. Polls the same-origin aggregate API, count-ups
// each number via rAF, drives the loading/live/zero/error state machine. Never
// injects HTML — textContent only. No raw hex anywhere (colours live in the CSS
// tokens; this script only toggles data-attributes).
export const STATS_PAGE_JS = `(function () {
  'use strict';
  var POLL_MS = 5000;
  var FIELDS = ['live','waiting','online','tunnels','totalRegistered'];
  // Map data-stat attr -> API key (the hero + cards reuse the API names; uptime
  // is derived from uptimeSeconds, handled separately).
  var API_KEY = {
    live: 'liveSessions',
    waiting: 'waiting',
    online: 'online',
    tunnels: 'relayTunnels',
    totalRegistered: 'totalRegistered'
  };

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var wrap = document.querySelector('.wrap');
  var statusEl = document.querySelector('.status');
  var statusText = document.querySelector('.status-text');
  var heroLive = document.querySelector('[data-stat="live"]');
  var heroAnnounce = document.getElementById('hero-announce');

  var els = {};
  FIELDS.forEach(function (f) {
    els[f] = document.querySelector('[data-stat="' + f + '"]');
  });
  var uptimeEl = document.querySelector('[data-stat="uptime"]');

  // last rendered numeric value per field (for count-up start + error hold).
  var lastVal = {};
  var entered = false;
  var timer = null;
  var controller = null;

  function setState(state, text) {
    if (statusEl) statusEl.setAttribute('data-live', state);
    if (statusText) statusText.textContent = text;
  }

  // rAF count-up, transform/opacity-free (text only). Instant if reduced motion
  // or first paint from a dash placeholder where we just snap.
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function animateNumber(el, from, to, duration) {
    if (!el) return;
    if (reduceMotion || from === to) {
      el.textContent = String(to);
      return;
    }
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var v = Math.round(from + (to - from) * easeOutCubic(p));
      el.textContent = String(v);
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = String(to);
    }
    requestAnimationFrame(frame);
  }

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function enter() {
    if (entered || !wrap) return;
    entered = true;
    wrap.classList.add('in');
  }

  function render(data) {
    var liveCount = Number(data.liveSessions) || 0;
    FIELDS.forEach(function (f) {
      var el = els[f];
      if (!el) return;
      var to = Number(data[API_KEY[f]]);
      if (!isFinite(to)) to = 0;
      var from = typeof lastVal[f] === 'number' ? lastVal[f] : 0;
      var dur = f === 'live' ? 650 : 500;
      animateNumber(el, from, to, dur);
      lastVal[f] = to;
    });
    if (uptimeEl) {
      uptimeEl.textContent = fmtUptime(Number(data.uptimeSeconds) || 0);
    }
    enter();
    if (liveCount > 0) {
      setState('live', 'live · auto-refreshing');
    } else {
      setState('zero', 'No games running right now');
    }
    if (heroAnnounce) {
      heroAnnounce.textContent = liveCount + (liveCount === 1 ? ' live game' : ' live games');
    }
  }

  function showError() {
    setState('error', 'Stats unavailable');
    // keep last-known numbers; if none yet, leave the em-dash placeholders.
  }

  function tick() {
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
    }
    var opts = { cache: 'no-store', headers: { 'accept': 'application/json' } };
    if (controller) opts.signal = controller.signal;
    fetch('/api/v1/stats', opts).then(function (res) {
      if (!res.ok) throw new Error('bad status');
      return res.json();
    }).then(function (data) {
      render(data);
    }).catch(function () {
      showError();
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(loop, POLL_MS);
  }

  function loop() {
    if (document.hidden) { schedule(); return; }
    tick();
    schedule();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      tick();
    }
  });

  // initial loading state (numbers already show '—' from the static HTML).
  setState('loading', 'connecting…');
  void heroLive;
  tick();
  schedule();
})();
`;

// Fully static document. The ONLY script is the external same-origin /stats.js.
// Inline <style> holds the token block + layout (style-src 'unsafe-inline').
export function renderStatsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Razzoozle — live stats</title>
<link rel="stylesheet" href="/stats.css">
</head>
<body>
<main class="wrap">
  <header class="topbar">
    <p class="wordmark">Razzoozle</p>
    <p class="status" role="status" aria-live="polite" data-live="loading">
      <span class="pulse-dot" aria-hidden="true"></span>
      <span class="status-text">connecting…</span>
    </p>
  </header>

  <section class="hero" aria-labelledby="hero-label">
    <h1 id="hero-label" class="hero-label">Live games</h1>
    <p class="hero-num" data-stat="live" aria-hidden="true">—</p>
    <span class="hero-underline" aria-hidden="true"></span>
    <span id="hero-announce" class="visually-hidden" aria-live="polite" aria-atomic="true"></span>
  </section>

  <ul class="grid" role="list">
    <li class="stat-card"><span class="stat-label">Players waiting</span><span class="stat-value" data-stat="waiting">—</span></li>
    <li class="stat-card"><span class="stat-label">Hosts online</span><span class="stat-value" data-stat="online">—</span></li>
    <li class="stat-card"><span class="stat-label">Relay tunnels</span><span class="stat-value" data-stat="tunnels">—</span></li>
    <li class="stat-card"><span class="stat-label">Sessions hosted</span><span class="stat-value" data-stat="totalRegistered">—</span></li>
    <li class="stat-card"><span class="stat-label">Uptime</span><span class="stat-value" data-stat="uptime">—</span></li>
  </ul>

  <footer class="foot">
    <p>Aggregate stats only — this page never shows join codes, sessions, or any per-game data.</p>
    <p>The gateway is rendezvous-only. It never sees your game traffic.</p>
  </footer>
</main>
<script src="/stats.js" defer></script>
</body>
</html>`;
}
