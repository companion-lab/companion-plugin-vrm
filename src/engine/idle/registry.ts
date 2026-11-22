import type { VRMAnimation } from "@pixiv/three-vrm-animation";

export type Keyframe = { t: number; v: { x: number; y: number; z: number; w?: number } };
export type Pose = Record<string, Keyframe[]>;

/** Stored custom-motion payload: the ORIGINAL .vrma bytes (base64). Playback
 *  parses them once into a VRMAnimation and drives three-vrm's normalized rig
 *  directly — the same pipeline the vrma-editor reference uses — so one clip
 *  plays correctly on every model, VRM 0.x and 1.0 alike. No per-model bakes. */
export interface StoredVrmaSource {
  fmt: 6;
  source: string;
}

export const MOTION_SOURCE_VERSION = 6;

export interface MotionEntry {
  name: string;
  duration: number;
  /** Authored keyframes (built-ins; normalized-frame eulers). */
  pose?: Pose;
  /** Parsed .vrma animation (customs; filled in async after registration). */
  anim?: VRMAnimation;
  /** Raw .vrma source bytes (customs, base64) — parsed into `anim`. */
  source?: string;
  version?: number;
  description?: string;
}

/** What callers may register: built-ins pass authored keyframes; customs pass
 *  a StoredVrmaSource (and may pass a pre-parsed `anim` to skip the parse). */
export type CustomMotionInput = Omit<MotionEntry, "pose"> & {
  pose?: Pose | StoredVrmaSource;
};

// Built-in motions hardcoded in motion.ts, loaded once.
const builtins = new Map<string, MotionEntry>();

// Custom motions loaded from user data.
const custom = new Map<string, MotionEntry>();

export function registerBuiltin(name: string, pose: Pose, duration: number): void {
  builtins.set(name, { name, pose, duration });
}

function isStoredVrmaSource(pose: unknown): pose is StoredVrmaSource {
  const p = pose as StoredVrmaSource;
  return (
    typeof pose === "object" &&
    pose !== null &&
    p.fmt === 6 &&
    typeof p.source === "string" &&
    p.source.length > 0
  );
}

/** Register a custom motion. The .vrma parse is async (GLTFLoader) — the
 *  entry is registered immediately with `source`, and `anim` fills in when
 *  the parse resolves; triggers before that are inert. Pass `anim` to skip
 *  the parse (already parsed at import time). `parse` is only needed for
 *  fmt-6 sources; authored-keyframe entries never parse. */
export function registerCustom(
  entry: CustomMotionInput,
  parse?: (source: string) => Promise<VRMAnimation>,
): void {
  if (isStoredVrmaSource(entry.pose)) {
    const source = entry.pose.source;
    const stored: MotionEntry = {
      ...entry,
      pose: undefined,
      source,
      anim: entry.anim,
    };
    custom.set(entry.name, stored);
    if (!stored.anim && parse) {
      parse(source)
        .then((anim) => {
          stored.anim = anim;
        })
        .catch((e) => {
          console.warn(
            `[motion] failed to parse "${entry.name}": ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }
    return;
  }
  // Not a .vrma source, so the pose is authored keyframes at runtime.
  custom.set(entry.name, entry as MotionEntry);
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
