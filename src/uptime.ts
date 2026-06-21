// UptimeRecorder — tracks per-COMPONENT health over the last 90 UTC days for the
// public status page. Self-contained: node:fs / node:path only, no new deps.
//
// PRIVACY: this records ONLY aggregate per-day health ratios per component
// (counts of healthy samples vs total). NEVER a join code / sessionId / hostId /
// IP / candidate. It is structurally incapable of holding per-session data — the
// sample() callback hands it component statuses, nothing else.
//
// HONESTY: days before the first observed sample are `nodata` (grey on the bar),
// not invented green. A fresh deploy shows a grey run-in + today's live status.
// All fs operations are best-effort (try/catch); an unwritable stateDir degrades
// to in-memory-only for this process — it never crashes the gateway.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Fixed component list (order = render order on the status page).
export const UPTIME_COMPONENTS = [
  { key: "rendezvous", name: "Rendezvous API" },
  { key: "relay-control", name: "Relay control plane" },
  { key: "relay-public", name: "Player relay (play.razzoozle.xyz)" },
] as const;

export type ComponentKey = (typeof UPTIME_COMPONENTS)[number]["key"];

// A single sample's per-component health (what sample() returns).
export type SampleStatus = "operational" | "degraded" | "maintenance" | "down";

// A rolled-up per-day status on the bar.
export type DayStatus = "operational" | "degraded" | "down" | "nodata";

export interface DayCell {
  ratio: number | null; // healthy/total in [0,1]; null = nodata
  status: DayStatus;
}

export interface ComponentHistory {
  key: ComponentKey;
  name: string;
  uptime90: number | null; // mean of known ratios * 100, or null if no data
  days: DayCell[]; // up to 90, oldest -> newest (today last)
}

const HISTORY_DAYS = 90;
const FILE_NAME = "uptime-history.json";
const PERSIST_DEBOUNCE_MS = 5 * 1000;

// On-disk per-component per-day rollup. healthy = operational samples; partial =
// degraded/maintenance samples; total = all samples; down = any 'down' seen.
interface DayRollup {
  healthy: number;
  partial: number;
  total: number;
  down: boolean;
}

type DayMap = Record<string, DayRollup>; // "YYYY-MM-DD" -> rollup
type DiskShape = Record<string, DayMap>; // componentKey -> DayMap

function utcDay(ms: number): string {
  // "YYYY-MM-DD" in UTC. Slice of the ISO string (stable, no locale).
  return new Date(ms).toISOString().slice(0, 10);
}

// Generate the last N UTC day keys, oldest -> newest (today last).
function lastNDays(n: number, nowMs: number): string[] {
  const out: string[] = [];
  const MS_DAY = 86_400_000;
  // Anchor at today's UTC midnight to avoid DST/local drift.
  const todayMidnight = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  for (let i = n - 1; i >= 0; i--) {
    out.push(utcDay(todayMidnight - i * MS_DAY));
  }
  return out;
}

function emptyRollup(): DayRollup {
  return { healthy: 0, partial: 0, total: 0, down: false };
}

// Fold one sample status into a day rollup (in place).
function fold(roll: DayRollup, status: SampleStatus): void {
  roll.total += 1;
  if (status === "operational") roll.healthy += 1;
  else if (status === "degraded" || status === "maintenance") roll.partial += 1;
  else if (status === "down") roll.down = true;
}

// Derive a bar cell from a day rollup.
function cellFromRollup(roll: DayRollup | undefined): DayCell {
  if (!roll || roll.total === 0) return { ratio: null, status: "nodata" };
  const ratio = roll.healthy / roll.total;
  let status: DayStatus;
  if (roll.down) status = "down";
  else if (roll.healthy === roll.total) status = "operational";
  else status = "degraded";
  return { ratio, status };
}

export interface UptimeRecorderOpts {
  stateDir: string;
  sample: () => Record<string, SampleStatus>;
  intervalMs?: number; // default 60s
}

export class UptimeRecorder {
  private readonly stateDir: string;
  private readonly filePath: string;
  private readonly sample: () => Record<string, SampleStatus>;
  private readonly intervalMs: number;

  private data: DiskShape = {};
  private latest: Record<string, SampleStatus> = {};
  private timer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(opts: UptimeRecorderOpts) {
    this.stateDir = opts.stateDir;
    this.filePath = join(opts.stateDir, FILE_NAME);
    this.sample = opts.sample;
    this.intervalMs = opts.intervalMs ?? 60 * 1000;
    for (const c of UPTIME_COMPONENTS) this.data[c.key] = {};
    this.load();
  }

  // Best-effort load of persisted history. Never throws.
  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const c of UPTIME_COMPONENTS) {
          const dm = (parsed as DiskShape)[c.key];
          if (dm && typeof dm === "object") {
            // Keep only well-formed day rollups, pruned to the 90-day window.
            const keep = new Set(lastNDays(HISTORY_DAYS, Date.now()));
            const clean: DayMap = {};
            for (const [day, roll] of Object.entries(dm)) {
              if (!keep.has(day)) continue;
              if (roll && typeof roll === "object") {
                clean[day] = {
                  healthy: Number((roll as DayRollup).healthy) || 0,
                  partial: Number((roll as DayRollup).partial) || 0,
                  total: Number((roll as DayRollup).total) || 0,
                  down: Boolean((roll as DayRollup).down),
                };
              }
            }
            this.data[c.key] = clean;
          }
        }
      }
    } catch {
      // No file yet / unreadable / malformed — start empty. Never fatal.
    }
  }

  // Best-effort persist (debounced). Never throws.
  private persist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  // Synchronous write — used by the debounce and on stop(). Never throws.
  private flush(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data), "utf8");
    } catch {
      // Unwritable stateDir — keep history in memory for this process only.
    }
  }

  // Take one sample now and fold it into today's rollup.
  private record(nowMs = Date.now()): void {
    let result: Record<string, SampleStatus>;
    try {
      result = this.sample();
    } catch {
      return; // a broken sampler must never crash the recorder
    }
    this.latest = result;
    const day = utcDay(nowMs);
    const window = new Set(lastNDays(HISTORY_DAYS, nowMs));
    for (const c of UPTIME_COMPONENTS) {
      const status = result[c.key];
      if (!status) continue;
      const dm = this.data[c.key] ?? (this.data[c.key] = {});
      // Prune anything outside the 90-day ring as we touch the component.
      for (const k of Object.keys(dm)) if (!window.has(k)) delete dm[k];
      const roll = dm[day] ?? (dm[day] = emptyRollup());
      fold(roll, status);
    }
    this.persist();
  }

  start(): void {
    if (this.timer) return;
    // Take an immediate first sample so "today" is never empty on boot.
    this.record();
    this.timer = setInterval(() => this.record(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      this.flush();
    }
  }

  // Per-component last-90-day history, oldest -> newest, with overall uptime90.
  history(nowMs = Date.now()): ComponentHistory[] {
    const days = lastNDays(HISTORY_DAYS, nowMs);
    return UPTIME_COMPONENTS.map((c) => {
      const dm = this.data[c.key] ?? {};
      const cells = days.map((d) => cellFromRollup(dm[d]));
      const known = cells.filter((x) => x.ratio !== null).map((x) => x.ratio as number);
      const uptime90 =
        known.length === 0
          ? null
          : (known.reduce((a, b) => a + b, 0) / known.length) * 100;
      return { key: c.key, name: c.name, uptime90, days: cells };
    });
  }

  // Latest per-component sample (the live "current" status), defaulting to
  // 'nodata' shape via the raw sample. Returns the SampleStatus map.
  currentStatus(): Record<string, SampleStatus> {
    if (Object.keys(this.latest).length > 0) return this.latest;
    // Not started yet — take a one-off read so callers always get something.
    try {
      this.latest = this.sample();
    } catch {
      this.latest = {};
    }
    return this.latest;
  }
}
