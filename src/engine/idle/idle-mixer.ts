import { getMotion } from "./registry";

export interface IdleMixerConfig {
  enabled: boolean;
  minSec: number;
  maxSec: number;
  idleMotions: string[];
}

export const DEFAULT_IDLE_MIXER: IdleMixerConfig = {
  enabled: true,
  minSec: 8,
  maxSec: 20,
  idleMotions: [],
};

const STORE_KEY = "companion:idle-mixer";

export function loadIdleMixer(): IdleMixerConfig {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<IdleMixerConfig>;
      const min = clampSec(p.minSec, 8);
      const max = clampSec(p.maxSec, 20);
      return {
        enabled: p.enabled ?? true,
        minSec: Math.min(min, max),
        maxSec: Math.max(min, max),
        idleMotions: sanitizeSelection(p.idleMotions),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_IDLE_MIXER };
}

export function saveIdleMixer(cfg: IdleMixerConfig): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

function clampSec(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(300, Math.max(3, Math.round(n)));
}

function sanitizeSelection(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export class IdleMixer {
  private cfg: IdleMixerConfig = loadIdleMixer();
  private nextIn = 0;
  private lastPick: string | null = null;

  constructor() {
    this.resetTimer();
  }

  setConfig(cfg: IdleMixerConfig): void {
    this.cfg = cfg;
    saveIdleMixer(cfg);
    this.resetTimer();
  }

  getConfig(): IdleMixerConfig {
    return this.cfg;
  }

  notifyBusy(): void {
    this.resetTimer();
  }

  private resetTimer(): void {
    const { minSec, maxSec } = this.cfg;
    this.nextIn = minSec + Math.random() * Math.max(0, maxSec - minSec);
  }

  tick(dt: number, opts: { busy: boolean }): string | null {
    if (!this.cfg.enabled) return null;
    if (opts.busy) {
      this.resetTimer();
      return null;
    }
    this.nextIn -= dt;
    if (this.nextIn > 0) return null;
    this.resetTimer();
    const pool = this.cfg.idleMotions
      .map((name) => getMotion(name)?.name)
      .filter((name): name is string => !!name);
    if (!pool.length) return null;
    const choices = pool.length > 1 ? pool.filter((n) => n !== this.lastPick) : pool;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    this.lastPick = pick;
    return pick;
  }
}
