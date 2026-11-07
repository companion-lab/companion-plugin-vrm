import { base64ToFloat32Array } from "../base64";

export type Keyframe = { t: number; v: { x: number; y: number; z: number; w?: number } };
export type Pose = Record<string, Keyframe[]>;

/** Stored v4 pose payload: one shared sampled-time grid plus per-bone
 *  base64 Float32 blobs (quats, 4N) — see vrma-loader.ts. A tenth the size
 *  of the v3 per-frame keyframe JSON and far cheaper to parse. */
export interface BakedPoseV4 {
  fmt: 4;
  times: string;
  bones: Record<string, string>;
  hipsPos?: string;
}

/** Decoded v4 tracks, ready to sample (customs). */
export interface MotionTracks {
  times: Float32Array;
  bones: Record<string, Float32Array>;
  hipsPos?: Float32Array;
}

export const MOTION_BAKE_VERSION = 4;

export interface MotionEntry {
  name: string;
  duration: number;
  /** Authored keyframes (built-ins; legacy v3 customs). */
  pose?: Pose;
  /** Decoded v4 bake (customs). */
  tracks?: MotionTracks;
  hipsPos?: Keyframe[];
  version?: number;
  description?: string;
}

/** What callers may register: v4 bakes carry a BakedPoseV4 as pose (decoded
 *  into tracks on registration); built-ins/legacy pass authored keyframes. */
export type CustomMotionInput = Omit<MotionEntry, "pose"> & {
  pose?: Pose | BakedPoseV4;
};

// Built-in motions hardcoded in motion.ts, loaded once.
const builtins = new Map<string, MotionEntry>();

// Custom motions loaded from user data.
const custom = new Map<string, MotionEntry>();

export function registerBuiltin(name: string, pose: Pose, duration: number): void {
  builtins.set(name, { name, pose, duration });
}

function isBakedPoseV4(pose: unknown): pose is BakedPoseV4 {
  return (
    typeof pose === "object" &&
    pose !== null &&
    (pose as BakedPoseV4).fmt === 4 &&
    typeof (pose as BakedPoseV4).times === "string" &&
    typeof (pose as BakedPoseV4).bones === "object" &&
    (pose as BakedPoseV4).bones !== null
  );
}

function decodeTracks(pose: BakedPoseV4): MotionTracks | null {
  const times = base64ToFloat32Array(pose.times);
  if (!times.length) return null;
  const bones: Record<string, Float32Array> = {};
  for (const [name, b64] of Object.entries(pose.bones)) {
    const values = base64ToFloat32Array(b64);
    // A length mismatch means a corrupt/truncated bake; reject the whole
    // pose rather than sample garbage later.
    if (values.length !== times.length * 4) return null;
    bones[name] = values;
  }
  let hipsPos: Float32Array | undefined;
  if (pose.hipsPos) {
    hipsPos = base64ToFloat32Array(pose.hipsPos);
    if (hipsPos.length !== times.length * 3) return null;
  }
  return { times, bones, hipsPos };
}

export function registerCustom(entry: CustomMotionInput): void {
  if (isBakedPoseV4(entry.pose)) {
    const tracks = decodeTracks(entry.pose);
    if (!tracks) {
      console.warn(`[motion] corrupt baked pose for "${entry.name}", ignoring`);
      return;
    }
    custom.set(entry.name, { ...entry, pose: undefined, tracks });
    return;
  }
  // Not a v4 blob, so the pose is authored keyframes at runtime.
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
