// GET / — public FLAT-CREAM STATUS page (status.claude.com pattern, Razzoozle
// look). Mirrors src/join-page.ts: HTML/CSS/JS exported as string consts, served
// same-origin under JOIN_PAGE_CSP. Replaces the old live-stats dashboard.
//
// PRIVACY: this page (and the /api/v1/status it polls) expose ONLY aggregate
// component health + per-day uptime ratios + integer counts. NEVER a join code /
// sessionId / hostId / IP / candidate URL / token. The HTML is fully static (no
// per-request interpolation — no XSS sink). The JS only sets data-* attributes +
// textContent; it never writes HTML or hex.
//
// DESIGN (Razzoozle design.md §3 + status spec): FLAT cream front-of-house. Cream
// field bg, white surface cards (hairline + ONE flat shadow + 16px radius), INK
// text (--game-fg:#0E1120 — default white renders invisible on cream). Status
// colours via --status-* tokens only (green==rank-up, amber==accent, red==
// timer-urgent, grey==hairline). Identity = motion (count-up + staggered
// entrance + uptime-bar grow-in + a calm pulse), transform/opacity ONLY. ZERO
// glass effects anywhere (flat surfaces only). prefers-reduced-motion honoured.
//
// CSP: the only script is the same-origin external <script src="/stats.js">. The
// inline logo <svg> is markup (CSP-safe — no eval/external). Stylesheet stays
// external /stats.css (style-src 'self').
//
// INCIDENTS: the "Past incidents" panel is intentionally STATIC (empty state).
// There is no incident store/timeline backend yet and wiring one is out of MVP
// scope; this panel renders "No incidents reported." until that exists.

// ── De-glassed Razzoozle logo (inline SVG markup, asset-derived) ────────────
// Source: src/assets/razzoozle-logo.svg (cd-src branding). De-glassed per the
// spec: the source's cyan liquid-glass bottom rim (<use fill="#22D3EE">) is
// replaced by a FLAT violet offset (#2e1065 @ .18) that reads as depth, not
// glass. The 10 glyph <path>s are VERBATIM from the source. The gradient stops +
// the offset colour live INSIDE the inline asset markup (not the page body token
// system) — acceptable; the page body's colours stay var-only.
const LOGO_SVG = `<svg class="logo" viewBox="0 0 560 140" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="rzViolet" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8B5CF6"/>
      <stop offset="1" stop-color="#6D28D9"/>
    </linearGradient>
    <g id="rzWord">
      <path d="M20 32 h34 a26 26 0 0 1 5 51 l20 21 h-27 l-17-19 h-2 v19 h-22 z M42 53 h-22 v12 h22 a6 6 0 0 0 0-12 z"/>
      <path d="M98 80 a24 24 0 0 1 47-7 v31 h-21 v-4 a23 23 0 1 1 -3-39 a23 23 0 0 1 3 1 a24 24 0 0 0 -26 18 z M122 72 a11 11 0 1 0 0 22 a11 11 0 0 0 0-22 z"/>
      <path d="M156 58 h44 v14 l-21 18 h21 v14 h-46 v-14 l23-18 h-21 z"/>
      <path d="M210 58 h44 v14 l-21 18 h21 v14 h-46 v-14 l23-18 h-21 z"/>
      <path d="M289 56 a24 24 0 1 1 0 48 a24 24 0 0 1 0-48 z M289 73 a7 7 0 1 0 0 14 a7 7 0 0 0 0-14 z"/>
      <path d="M347 56 a24 24 0 1 1 0 48 a24 24 0 0 1 0-48 z M347 73 a7 7 0 1 0 0 14 a7 7 0 0 0 0-14 z"/>
      <path d="M385 58 h44 v14 l-21 18 h21 v14 h-46 v-14 l23-18 h-21 z"/>
      <path d="M439 28 h21 v76 h-21 z"/>
      <path fill-rule="evenodd" d="M495 56 a24 24 0 1 0 17 41 l-11-12 a9 9 0 0 1 -6 3 a9 9 0 0 1 -8-12 h31 a24 24 0 0 0 -23-20 z M495 73 a9 9 0 0 0 -8 5 h16 a9 9 0 0 0 -8-5 z"/>
    </g>
  </defs>
  <use href="#rzWord" transform="translate(0,2)" fill="#2e1065" opacity="0.18"/>
  <use href="#rzWord" fill="url(#rzViolet)"/>
</svg>`;

// Static stylesheet (served at /stats.css, CSP style-src 'self'). All colours go
// through var(--token); no raw hex in any rule body. The :root token block is
// emitted from design.md §3 + the design-system-consistent --status-* tokens.
export const STATUS_PAGE_CSS = `:root{
  /* --- Razzoozle cream design system (design.md §3) --- */
  --color-field-cream:#F4F1EA;
  --surface:#FFFFFF;
  --border-hairline:#E2DDD2;
  --color-primary:#7c3aed;        /* violet brand — white text OK on this FILL only */
  --color-secondary:#2e1065;      /* dark-ink headings */
  --color-accent:#ff9900;         /* AMBER accent — INK text on it */
  --accent-contrast-text:#0E1120;
  --game-fg:#0E1120;              /* CRITICAL: ink fg. default white => invisible on cream */
  --radius-theme:16px;
  --shadow-flat:0 1px 2px rgba(14,17,32,.06), 0 10px 30px rgba(14,17,32,.07); /* ONE flat rung */
  --footer-bg:#ffffff; --footer-text:#1f2937;
  --rank-up:#10b981; --timer-urgent:#ff3b30;
  --font-display:'Rubik', system-ui, -apple-system, 'Segoe UI', sans-serif;

  /* --- page-local derived tokens (still tokens, not literals) --- */
  --ink-muted:#4A4F5C;            /* secondary label ink; ~7:1 on cream & white */
  --gap:clamp(.875rem,2.5vw,1.25rem);
  --ease-out:cubic-bezier(.22,.61,.36,1);

  /* --- status tokens (design-system-consistent) --- */
  --status-operational:#10b981;   /* green  — == --rank-up        */
  --status-degraded:#ff9900;      /* amber  — == --color-accent   */
  --status-down:#ff3b30;          /* red    — == --timer-urgent   */
  --status-nodata:#E2DDD2;        /* grey   — == --border-hairline */
  /* soft washes for pills/banner accents — color-mix keeps them token-derived,
     no new hex. ~14% tint over white reads as a label chip, ink text on top. */
  --wash-operational:color-mix(in srgb, var(--status-operational) 14%, #fff);
  --wash-degraded:color-mix(in srgb, var(--status-degraded) 16%, #fff);
  --wash-down:color-mix(in srgb, var(--status-down) 14%, #fff);
  --wash-nodata:color-mix(in srgb, var(--status-nodata) 55%, #fff);
}
@font-face{
  font-family:'Rubik';
  src:url(/fonts/rubik.woff2) format('woff2');
  font-weight:300 700;
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
  max-width:56rem;
  margin-inline:auto;
  padding:clamp(1.25rem,4vw,2.5rem);
}

.visually-hidden{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;
  overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;
}
a:focus-visible,button:focus-visible,[tabindex]:focus-visible{
  outline:2px solid var(--color-primary);
  outline-offset:2px;
}

/* --- header: logo (the brand) + status subtitle --- */
.topbar{
  display:flex; align-items:flex-end; justify-content:space-between;
  flex-wrap:wrap; gap:.75rem; margin-bottom:var(--gap);
}
.brand{ margin:0; line-height:0; }
.logo{ height:clamp(40px,7vw,48px); width:auto; display:block; }
.brand-sub{ margin:.35rem 0 0; font-size:.85rem; color:var(--ink-muted); }
.brand-sub span{ font-variant-numeric:tabular-nums; }

/* --- overall banner: white surface + LEFT accent bar (not a colored fill) --- */
.banner{
  display:flex; align-items:center; gap:1rem;
  background:var(--surface); border:1px solid var(--border-hairline);
  border-left:6px solid var(--status-nodata);   /* recolored by state */
  box-shadow:var(--shadow-flat); border-radius:var(--radius-theme);
  padding:clamp(1.1rem,3.5vw,1.6rem) clamp(1.25rem,4vw,1.9rem);
  margin-block:var(--gap);
}
.banner[data-overall="operational"]{ border-left-color:var(--status-operational); }
.banner[data-overall="degraded"]   { border-left-color:var(--status-degraded); }
.banner[data-overall="down"]       { border-left-color:var(--status-down); }
.banner[data-overall="error"]      { border-left-color:var(--ink-muted); }
.banner-dot{
  width:14px;height:14px;border-radius:50%;flex:0 0 auto;
  background:var(--status-nodata);
}
.banner[data-overall="operational"] .banner-dot{ background:var(--status-operational); }
.banner[data-overall="degraded"]    .banner-dot{ background:var(--status-degraded); }
.banner[data-overall="down"]        .banner-dot{ background:var(--status-down); }
.banner[data-overall="error"]       .banner-dot{ background:var(--ink-muted); }
.banner[data-overall="operational"] .banner-dot{ animation:pulse 2.4s var(--ease-out) infinite; }
.banner-head{
  margin:0; font-size:clamp(1.25rem,4vw,1.6rem); font-weight:700;
  color:var(--game-fg); letter-spacing:-.01em;
}
.banner-sub{ margin:.2rem 0 0; font-size:.9rem; color:var(--ink-muted); }

/* --- panels (surface cards) --- */
.panel{
  background:var(--surface); border:1px solid var(--border-hairline);
  box-shadow:var(--shadow-flat); border-radius:var(--radius-theme);
  padding:clamp(1.1rem,3.5vw,1.6rem); margin-block:var(--gap);
  opacity:0; transform:translateY(12px);
}
.wrap.in .panel{
  opacity:1; transform:none;
  transition:opacity .5s var(--ease-out), transform .5s var(--ease-out);
}
.wrap.in .panel:nth-of-type(2){ transition-delay:.05s; }
.wrap.in .panel:nth-of-type(3){ transition-delay:.10s; }
.wrap.in .panel:nth-of-type(4){ transition-delay:.15s; }
.panel-h{
  margin:0 0 .75rem; font-size:1.05rem; font-weight:700;
  color:var(--color-secondary); letter-spacing:.01em;
}

/* --- component rows --- */
.components{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
.component{ padding:1rem 0; border-top:1px solid var(--border-hairline); }
.component:first-child{ border-top:0; padding-top:0; }
.comp-top{
  display:grid; grid-template-columns:1fr auto auto; align-items:center;
  column-gap:.75rem;
}
.comp-name{ margin:0; font-size:1rem; font-weight:600; color:var(--game-fg); }
.comp-pct{
  font-size:.9rem; font-weight:600; color:var(--game-fg);
  font-variant-numeric:tabular-nums slashed-zero;
}
.comp-note{ margin:.3rem 0 0; font-size:.82rem; color:var(--ink-muted); }

/* --- status pill: wash fill + INK label + dot. never white-on-color --- */
.pill{
  display:inline-flex; align-items:center; gap:.4rem;
  padding:.18rem .55rem; border-radius:999px; font-size:.78rem; font-weight:600;
  color:var(--game-fg); background:var(--wash-nodata);
  border:1px solid var(--border-hairline);
}
.pill-dot{ width:8px;height:8px;border-radius:50%; background:var(--status-nodata); }
.component[data-status="operational"] .pill{ background:var(--wash-operational); }
.component[data-status="operational"] .pill-dot{ background:var(--status-operational); }
.component[data-status="degraded"]    .pill{ background:var(--wash-degraded); }
.component[data-status="degraded"]    .pill-dot{ background:var(--status-degraded); }
.component[data-status="down"]        .pill{ background:var(--wash-down); }
.component[data-status="down"]        .pill-dot{ background:var(--status-down); }
.component[data-status="maintenance"] .pill,
.component[data-status="nodata"]      .pill{ background:var(--wash-nodata); }

/* ============================================================================
   90-SEGMENT DAILY UPTIME BAR — status.claude.com signature, FLAT-CREAM.
   90 thin vertical segments, one per day, oldest->newest left->right. Colour =
   that day's worst status from the --status-* tokens. nodata = hairline grey.
   Never color-only: each segment carries a native title= + aria-label, and the
   row pairs the bar with a pill + uptime %. Grow-in via transform:scaleY +
   opacity only; reduced-motion disables it.
   ========================================================================== */
.uptime{ margin:.6rem 0 .35rem; }
.uptime-track{
  display:grid;
  grid-template-columns:repeat(90, 1fr);
  gap:2px;
  align-items:stretch;
  height:34px;
  width:100%;
}
.uptime-seg{
  border-radius:2px;
  background:var(--status-nodata);
  min-width:0;
  transform:scaleY(.35);
  opacity:0;
  transform-origin:bottom;
}
.uptime-seg[data-day="operational"]{ background:var(--status-operational); }
.uptime-seg[data-day="degraded"]   { background:var(--status-degraded); }
.uptime-seg[data-day="down"]       { background:var(--status-down); }
.uptime-seg[data-day="nodata"]     { background:var(--status-nodata); }
.wrap.in .uptime-seg{
  transform:scaleY(1);
  opacity:1;
  transition:transform .45s var(--ease-out), opacity .45s var(--ease-out);
}
.wrap.in .uptime-seg:nth-child(10n+1){ transition-delay:.00s; }
.wrap.in .uptime-seg:nth-child(10n+2){ transition-delay:.02s; }
.wrap.in .uptime-seg:nth-child(10n+3){ transition-delay:.04s; }
.wrap.in .uptime-seg:nth-child(10n+4){ transition-delay:.06s; }
.wrap.in .uptime-seg:nth-child(10n+5){ transition-delay:.08s; }
.wrap.in .uptime-seg:nth-child(10n+6){ transition-delay:.10s; }
.wrap.in .uptime-seg:nth-child(10n+7){ transition-delay:.12s; }
.wrap.in .uptime-seg:nth-child(10n+8){ transition-delay:.14s; }
.wrap.in .uptime-seg:nth-child(10n+9){ transition-delay:.16s; }
.wrap.in .uptime-seg:nth-child(10n)  { transition-delay:.18s; }
.uptime-seg:hover,
.uptime-seg:focus-visible{
  outline:2px solid var(--color-primary);
  outline-offset:1px;
  filter:brightness(1.06);
}
.uptime-axis{
  display:flex;
  justify-content:space-between;
  margin-top:.3rem;
  font-size:.72rem;
  color:var(--ink-muted);
  letter-spacing:.01em;
}
.uptime-pct{
  font-variant-numeric:tabular-nums slashed-zero;
  font-weight:600;
  color:var(--game-fg);
}
.uptime[data-state="loading"] .uptime-seg{
  background:var(--status-nodata);
  animation:seg-shim 1.4s var(--ease-out) infinite;
}
@keyframes seg-shim{ 0%,100%{opacity:.55;} 50%{opacity:.9;} }

/* --- live activity --- */
.live-head{ display:flex; align-items:center; justify-content:space-between; gap:.75rem; }
.live-pulse{
  display:inline-flex; align-items:center; gap:.5rem; margin:0;
  font-size:.85rem; color:var(--ink-muted);
}
.live-pulse .pulse-dot{
  width:8px;height:8px;border-radius:50%;
  background:var(--color-primary); animation:pulse 2s var(--ease-out) infinite;
}
.live-pulse[data-live="zero"]  .pulse-dot{ background:var(--color-accent); }
.live-pulse[data-live="error"] .pulse-dot{ background:var(--timer-urgent); animation-play-state:paused; }
.live-hero{ display:flex; flex-direction:column; margin:.5rem 0 1rem; }
.live-hero-label{
  font-size:.8rem; font-weight:600; text-transform:uppercase;
  letter-spacing:.04em; color:var(--ink-muted);
}
.live-hero-num{
  font-size:clamp(2.75rem,11vw,5rem); font-weight:700; line-height:.95;
  color:var(--game-fg); font-variant-numeric:tabular-nums slashed-zero;
}
.metrics{
  list-style:none; margin:0; padding:0; display:grid;
  grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:.75rem;
}
.metric{
  display:flex; flex-direction:column; gap:.2rem; padding:.6rem 0;
  border-top:1px solid var(--border-hairline);
}
.metric-label{
  font-size:.78rem; font-weight:600; text-transform:uppercase;
  letter-spacing:.03em; color:var(--ink-muted);
}
.metric-val{
  font-size:clamp(1.3rem,4vw,1.8rem); font-weight:700; color:var(--game-fg);
  font-variant-numeric:tabular-nums slashed-zero;
}

/* --- incidents --- */
.incidents-empty{ margin:0; color:var(--ink-muted); font-size:.92rem; }

/* --- footer --- */
.foot{
  margin-top:calc(var(--gap)*2);
  padding-top:var(--gap);
  border-top:1px solid var(--border-hairline);
  color:var(--ink-muted);
  font-size:.85rem;
}
.foot p{margin:.25rem 0;}
.foot-fine{ font-size:.78rem; }

@keyframes pulse{
  0%,100%{opacity:1;transform:scale(1);}
  50%{opacity:.45;transform:scale(.8);}
}

/* --- responsive --- */
@media (max-width:600px){
  .comp-top{ grid-template-columns:1fr auto; }
  .comp-pct{ grid-column:2; justify-self:end; }
}
@media (prefers-reduced-motion: reduce){
  .banner-dot,.live-pulse .pulse-dot{ animation:none; }
  .panel,.wrap.in .panel{ transition:none; opacity:1; transform:none; }
  .uptime-seg,
  .wrap.in .uptime-seg{ transition:none; transform:none; opacity:1; }
  .uptime[data-state="loading"] .uptime-seg{ animation:none; opacity:.7; }
  .uptime-seg:hover,.uptime-seg:focus-visible{ filter:none; }
}
`;

// Static bootstrap script (served at /stats.js, CSP script-src 'self'). Vanilla,
// no imports, no external calls. Polls /api/v1/status, builds the 90-day bars
// (once, then recolors), count-ups the live numbers, drives the overall banner +
// loading/operational/degraded/down/nodata/error state machine. Never injects
// HTML — textContent + setAttribute('data-*') only. No raw hex anywhere.
export const STATUS_PAGE_JS = `(function () {
  'use strict';
  var POLL_MS = 5000;
  var STATUS_WORD = {
    operational: 'Operational',
    degraded: 'Degraded',
    down: 'Down',
    nodata: 'No data',
    maintenance: 'Maintenance'
  };
  // Map a sample status to the data-status the component CSS understands.
  function pillStatus(s) {
    if (s === 'maintenance') return 'maintenance';
    if (s === 'degraded' || s === 'down' || s === 'operational') return s;
    return 'nodata';
  }

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var wrap = document.querySelector('.wrap');
  var banner = document.querySelector('.banner');
  var bannerHead = document.querySelector('[data-overall-head]');
  var bannerSub = document.querySelector('[data-overall-sub]');

  var livePulse = document.querySelector('[data-live]');
  var liveStatusText = livePulse ? livePulse.querySelector('.status-text') : null;
  var liveAnnounce = document.querySelector('[data-announce]');

  // live-activity number cells (data-stat -> API key under .live)
  var LIVE_FIELDS = {
    live: 'liveSessions',
    waiting: 'waiting',
    online: 'online',
    tunnels: 'relayTunnels',
    totalRegistered: 'totalRegistered'
  };
  var liveEls = {};
  Object.keys(LIVE_FIELDS).forEach(function (k) {
    liveEls[k] = document.querySelector('[data-stat="' + k + '"]');
  });
  var uptimeEl = document.querySelector('[data-stat="uptime"]');

  var lastVal = {};
  var entered = false;
  var timer = null;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function animateNumber(el, from, to, duration) {
    if (!el) return;
    if (reduceMotion || from === to) { el.textContent = String(to); return; }
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

  // Build the 90 segments once per component, then only recolor + relabel.
  function buildBar(track, days) {
    if (track.childElementCount === 90) { recolor(track, days); return; }
    while (track.firstChild) track.removeChild(track.firstChild);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 90; i++) {
      var d = days[i] || { date: '', status: 'nodata' };
      var seg = document.createElement('span');
      seg.className = 'uptime-seg';
      seg.setAttribute('data-day', d.status || 'nodata');
      seg.setAttribute('tabindex', '0');
      seg.setAttribute('role', 'img');
      var label = labelFor(d);
      seg.title = label;
      seg.setAttribute('aria-label', label);
      frag.appendChild(seg);
    }
    track.appendChild(frag);
  }

  function labelFor(d) {
    var word = STATUS_WORD[d.status] || STATUS_WORD.nodata;
    return (d.date ? d.date : 'No data') + ' — ' + word;
  }

  function recolor(track, days) {
    var segs = track.children;
    for (var i = 0; i < segs.length && i < 90; i++) {
      var d = days[i] || { date: '', status: 'nodata' };
      segs[i].setAttribute('data-day', d.status || 'nodata');
      var label = labelFor(d);
      segs[i].title = label;
      segs[i].setAttribute('aria-label', label);
    }
  }

  // Build dated day cells from the API days[] (ratio/status). The API doesn't
  // send per-day dates; derive them client-side (90 days ago .. today, UTC).
  function datedDays(days) {
    var out = [];
    var n = days.length;
    var todayMs = Date.now();
    for (var i = 0; i < n; i++) {
      var ageDays = (n - 1) - i; // index 0 == oldest
      var ms = todayMs - ageDays * 86400000;
      var date = new Date(ms).toISOString().slice(0, 10);
      out.push({ date: date, status: (days[i] && days[i].status) || 'nodata' });
    }
    return out;
  }

  function renderComponent(comp) {
    var li = document.querySelector('.component[data-comp="' + comp.key + '"]');
    if (!li) return;
    var ps = pillStatus(comp.status);
    li.setAttribute('data-status', ps);
    var pillText = li.querySelector('.pill-text');
    if (pillText) pillText.textContent = STATUS_WORD[comp.status] || STATUS_WORD.nodata;

    var pctText = (typeof comp.uptime90 === 'number')
      ? comp.uptime90.toFixed(2) + '%'
      : '—';
    var pctEl = li.querySelector('[data-pct]');
    if (pctEl) pctEl.textContent = pctText;
    var pct90 = li.querySelector('[data-pct90]');
    if (pct90) pct90.textContent = pctText;

    var noteEl = li.querySelector('[data-note]');
    if (noteEl) {
      if (comp.note) { noteEl.textContent = comp.note; noteEl.hidden = false; }
      else { noteEl.textContent = ''; noteEl.hidden = true; }
    }

    var uptimeBox = li.querySelector('.uptime');
    var track = li.querySelector('[data-track]');
    if (track) buildBar(track, datedDays(comp.days || []));
    if (uptimeBox) uptimeBox.setAttribute('data-state', 'ok');
  }

  function renderBanner(overall, components) {
    if (!banner) return;
    banner.setAttribute('data-overall', overall);
    var head, sub;
    if (overall === 'operational') {
      head = 'All Systems Operational';
      sub = 'Every component is up.';
    } else if (overall === 'down') {
      head = 'Major Outage';
      sub = 'One or more components are down.';
    } else { // degraded (incl. maintenance)
      head = 'Partial Degradation';
      // surface the first non-operational component's reason.
      sub = 'One or more components are degraded.';
      for (var i = 0; i < components.length; i++) {
        var c = components[i];
        if (c.status !== 'operational') {
          sub = c.name + ': ' + (c.note || STATUS_WORD[c.status] || 'Degraded') + '.';
          break;
        }
      }
    }
    banner.removeAttribute('role');
    banner.setAttribute('role', 'status');
    if (bannerHead) bannerHead.textContent = head;
    if (bannerSub) bannerSub.textContent = sub;
  }

  function setLive(state, text) {
    if (livePulse) livePulse.setAttribute('data-live', state);
    if (liveStatusText) liveStatusText.textContent = text;
  }

  function renderLive(live, uptimeSeconds) {
    Object.keys(LIVE_FIELDS).forEach(function (k) {
      var el = liveEls[k];
      if (!el) return;
      var to = Number(live[LIVE_FIELDS[k]]);
      if (!isFinite(to)) to = 0;
      var from = typeof lastVal[k] === 'number' ? lastVal[k] : 0;
      animateNumber(el, from, to, k === 'live' ? 650 : 500);
      lastVal[k] = to;
    });
    if (uptimeEl) uptimeEl.textContent = fmtUptime(Number(uptimeSeconds) || 0);
    var liveCount = Number(live.liveSessions) || 0;
    if (liveCount > 0) setLive('live', 'live · auto-refreshing');
    else setLive('zero', 'No games running right now');
    if (liveAnnounce) {
      liveAnnounce.textContent = liveCount + (liveCount === 1 ? ' live game' : ' live games');
    }
  }

  function render(data) {
    var components = data.components || [];
    components.forEach(renderComponent);
    renderBanner(data.overall || 'operational', components);
    if (data.live) renderLive(data.live, data.uptimeSeconds);
    enter();
  }

  function showError() {
    // Neutral grey — we failed to READ status; we do NOT assert an outage.
    if (banner) {
      banner.setAttribute('data-overall', 'error');
      banner.setAttribute('role', 'alert');
      if (bannerHead) bannerHead.textContent = 'Status unavailable';
      if (bannerSub) bannerSub.textContent = "Couldn't reach the gateway.";
    }
    setLive('error', 'Stats unavailable');
    // hold last-known component bars/numbers.
    enter();
  }

  function tick() {
    var opts = { cache: 'no-store', headers: { 'accept': 'application/json' } };
    var ctrl = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
    }
    fetch('/api/v1/status', opts).then(function (res) {
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
    if (!document.hidden) tick();
  });

  setLive('loading', 'connecting…');
  tick();
  schedule();
})();
`;

// ── Static document. The ONLY script is the external same-origin /stats.js. The
// inline logo <svg> is markup (CSP-safe). No per-request interpolation (no XSS
// sink). One component <li> template per component id (rendezvous / relay-control
// / relay-public); the JS fills pill text, %, note + the 90-day bar.
function componentRow(id: string, name: string): string {
  return `      <li class="component" data-comp="${id}" data-status="loading">
        <div class="comp-top">
          <h3 class="comp-name">${name}</h3>
          <span class="pill" data-pill><span class="pill-dot" aria-hidden="true"></span><span class="pill-text">Checking…</span></span>
          <span class="comp-pct" data-pct>—</span>
        </div>
        <p class="comp-note" data-note hidden></p>
        <div class="uptime" data-state="loading">
          <div class="uptime-track" role="img" aria-label="90-day uptime, oldest to newest" data-track></div>
          <div class="uptime-axis">
            <span>90 days ago</span>
            <span class="uptime-pct" data-pct90>—</span>
            <span>Today</span>
          </div>
        </div>
      </li>`;
}

export function renderStatusPage(): string {
  // NOTE: incidents are intentionally STATIC. There is no incident store/timeline
  // backend yet — wiring one is out of MVP scope. The panel renders the empty
  // state until that exists.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Razzoozle Gateway — System Status</title>
<link rel="stylesheet" href="/stats.css">
</head>
<body>
<main class="wrap">

  <header class="topbar">
    <h1 class="brand" aria-label="Razzoozle">
      ${LOGO_SVG}
    </h1>
    <p class="brand-sub">Gateway Status · <span>gw.razzoozle.xyz</span></p>
  </header>

  <section class="banner" data-overall="loading" role="status" aria-live="polite">
    <span class="banner-dot" aria-hidden="true"></span>
    <div class="banner-text">
      <p class="banner-head" data-overall-head>Checking system status…</p>
      <p class="banner-sub" data-overall-sub>Connecting to the gateway</p>
    </div>
  </section>

  <section class="panel" aria-labelledby="comp-h">
    <h2 id="comp-h" class="panel-h">System status</h2>
    <ul class="components" role="list">
${componentRow("rendezvous", "Rendezvous API")}
${componentRow("relay-control", "Relay control plane")}
${componentRow("relay-public", "Player relay (play.razzoozle.xyz)")}
    </ul>
  </section>

  <section class="panel live" aria-labelledby="live-h">
    <div class="live-head">
      <h2 id="live-h" class="panel-h">Live activity</h2>
      <p class="live-pulse" data-live="loading"><span class="pulse-dot" aria-hidden="true"></span>
        <span class="status-text">connecting…</span></p>
    </div>
    <div class="live-hero">
      <span class="live-hero-label">Live games</span>
      <span class="live-hero-num" data-stat="live" aria-hidden="true">—</span>
      <span class="visually-hidden" data-announce aria-live="polite" aria-atomic="true"></span>
    </div>
    <ul class="metrics" role="list">
      <li class="metric"><span class="metric-label">Players waiting</span><span class="metric-val" data-stat="waiting">—</span></li>
      <li class="metric"><span class="metric-label">Hosts online</span><span class="metric-val" data-stat="online">—</span></li>
      <li class="metric"><span class="metric-label">Relay tunnels</span><span class="metric-val" data-stat="tunnels">—</span></li>
      <li class="metric"><span class="metric-label">Sessions hosted</span><span class="metric-val" data-stat="totalRegistered">—</span></li>
      <li class="metric"><span class="metric-label">Uptime</span><span class="metric-val" data-stat="uptime">—</span></li>
    </ul>
  </section>

  <section class="panel" aria-labelledby="inc-h">
    <h2 id="inc-h" class="panel-h">Past incidents</h2>
    <p class="incidents-empty">No incidents reported.</p>
  </section>

  <footer class="foot">
    <p>Razzoozle Gateway · gw.razzoozle.xyz</p>
    <p class="foot-fine">Aggregate status only — never a join code, session, host, or IP.</p>
  </footer>

</main>
<script src="/stats.js" defer></script>
</body>
</html>`;
}
