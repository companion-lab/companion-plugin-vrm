export type Keyframe = { t: number; v: { x: number; y: number; z: number; w?: number } };
export type Pose = Record<string, Keyframe[]>;

export const MOTION_BAKE_VERSION = 3;

export interface MotionEntry {
  name: string;
  pose: Pose;
  duration: number;
  hipsPos?: Keyframe[];
  version?: number;
  description?: string;
}

// Built-in motions hardcoded in motion.ts, loaded once.
const builtins = new Map<string, MotionEntry>();

// Custom motions loaded from user data.
const custom = new Map<string, MotionEntry>();

export function registerBuiltin(name: string, pose: Pose, duration: number): void {
  builtins.set(name, { name, pose, duration });
}

export function registerCustom(entry: MotionEntry): void {
  custom.set(entry.name, entry);
}

export function unregisterCustom(name: string): void {
  custom.delete(name);
}

export function clearCustomMotions(): void {
  custom.clear();
}

export const BUILTIN_MOTION_DESCRIPTIONS: Record<string, string> = {
  none: "stay still idle, default when no motion fits",
  nod: "head nod for yes agreement",
  shake: "head shake for no disagreement",
  think: "thoughtful head tilt while thinking",
};

export const BUILTIN_MOTION_META: Array<{ name: string; duration: number }> = [
  { name: "nod", duration: 1.1 },
  { name: "shake", duration: 1.1 },
  { name: "think", duration: 2.2 },
];

export function isBuiltinMotionName(name: string): boolean {
  const key = resolveMotionName(name);
  return key !== null && builtins.has(key);
}

export function motionDescription(m: MotionEntry): string {
  const d = m.description?.trim();
  if (d) return d;
  const builtin = BUILTIN_MOTION_DESCRIPTIONS[m.name];
  if (builtin) return builtin;
  const human = m.name.replace(/[_-]+/g, " ").trim() || m.name;
  return `${human} custom motion clip`;
}
export function normalizeMotionName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

export function resolveMotionName(name: string): string | null {
  if (name.trim().toLowerCase() === "none") return "none";
  const direct = custom.get(name) ?? builtins.get(name);
  if (direct) return direct.name;
  const norm = normalizeMotionName(name);
  for (const key of [...custom.keys(), ...builtins.keys()]) {
    if (normalizeMotionName(key) === norm) return key;
  }
  return null;
}

export function getMotion(name: string): MotionEntry | undefined {
  const key = resolveMotionName(name);
  if (!key) return undefined;
  return custom.get(key) ?? builtins.get(key);
}

export function listMotions(): MotionEntry[] {
  return [...builtins.values(), ...custom.values()];
}

export function listCustomMotions(): MotionEntry[] {
  return [...custom.values()];
}

export function listMotionNames(): string[] {
  return ["none", ...custom.keys(), ...builtins.keys()];
}

export function isCustomMotion(name: string): boolean {
  const key = resolveMotionName(name);
  return key !== null && custom.has(key);
}
