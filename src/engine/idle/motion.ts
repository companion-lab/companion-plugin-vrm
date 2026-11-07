import * as THREE from "three";
import {
  registerBuiltin,
  getMotion,
  resolveMotionName,
  isCustomMotion,
  type Keyframe,
  type MotionTracks,
} from "./registry";

export type { Keyframe } from "./registry";

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const _sA = new THREE.Quaternion();
const _sB = new THREE.Quaternion();
const _sOut = new THREE.Quaternion();

function isQuatKey(v: {
  x: number;
  y: number;
  z: number;
  w?: number;
}): boolean {
  return v.w !== undefined;
}

function sample(
  frames: Keyframe[],
  t: number,
): { x: number; y: number; z: number; w?: number } | null {
  if (!frames.length) return null;
  if (t <= frames[0].t) return frames[0].v;
  if (t >= frames[frames.length - 1].t) return null;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = easeInOut((t - a.t) / (b.t - a.t));
      if (isQuatKey(a.v) && isQuatKey(b.v)) {
        _sA.set(a.v.x, a.v.y, a.v.z, a.v.w!);
        _sB.set(b.v.x, b.v.y, b.v.z, b.v.w!);
        _sOut.slerpQuaternions(_sA, _sB, k);
        return { x: _sOut.x, y: _sOut.y, z: _sOut.z, w: _sOut.w };
      }
      return {
        x: lerp(a.v.x, b.v.x, k),
        y: lerp(a.v.y, b.v.y, k),
        z: lerp(a.v.z, b.v.z, k),
      };
    }
  }
  return null;
}

// ─── Built-in poses (registered into the registry at load) ───

registerBuiltin(
  "nod",
  {
    neck: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.15, v: { x: -0.35, y: 0, z: 0 } },
      { t: 0.35, v: { x: 0.15, y: 0, z: 0 } },
      { t: 0.55, v: { x: -0.25, y: 0, z: 0 } },
      { t: 0.75, v: { x: 0.15, y: 0, z: 0 } },
      { t: 0.95, v: { x: 0, y: 0, z: 0 } },
    ],
    head: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.15, v: { x: -0.15, y: 0, z: 0 } },
      { t: 0.35, v: { x: 0.05, y: 0, z: 0 } },
      { t: 0.55, v: { x: -0.15, y: 0, z: 0 } },
      { t: 0.75, v: { x: 0.05, y: 0, z: 0 } },
      { t: 0.95, v: { x: 0, y: 0, z: 0 } },
    ],
  },
  1.1,
);

registerBuiltin(
  "shake",
  {
    head: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.15, v: { x: 0, y: 0.35, z: 0 } },
      { t: 0.35, v: { x: 0, y: -0.35, z: 0 } },
      { t: 0.55, v: { x: 0, y: 0.35, z: 0 } },
      { t: 0.75, v: { x: 0, y: -0.35, z: 0 } },
      { t: 0.95, v: { x: 0, y: 0, z: 0 } },
    ],
    neck: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.95, v: { x: 0, y: 0, z: 0 } },
    ],
  },
  1.1,
);

registerBuiltin(
  "think",
  {
    head: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.3, v: { x: 0.05, y: 0.15, z: 0.2 } },
      { t: 1.7, v: { x: 0.05, y: 0.15, z: 0.2 } },
      { t: 2.0, v: { x: 0, y: 0, z: 0 } },
    ],
    leftEye: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.3, v: { x: 0.15, y: -0.2, z: 0 } },
      { t: 1.7, v: { x: 0.15, y: -0.2, z: 0 } },
      { t: 2.0, v: { x: 0, y: 0, z: 0 } },
    ],
    rightEye: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.3, v: { x: 0.15, y: -0.2, z: 0 } },
      { t: 1.7, v: { x: 0.15, y: -0.2, z: 0 } },
      { t: 2.0, v: { x: 0, y: 0, z: 0 } },
    ],
  },
  2.2,
);

// ─── Controller ───

export type MotionDelta = { x: number; y: number; z: number; w?: number };
export type MotionState = Record<string, MotionDelta>;
export type MotionUpdate = {
  state: MotionState;
  absolute: boolean;
  fade: number;
  hipsPos?: MotionDelta;
};

// Blend in/out times, seconds
const RAMP = 1.0; // ease-in (idle -> motion)
const FADE = 1.0; // fade-out (motion -> idle)

// zero acceleration at both ends (quintic)
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class MotionController {
  private current: string | null = null;
  private t = 0;
  private duration = 0;
  private fadeT = 0;
  private fade = 1;

  trigger(motion: string): void {
    if (!motion || motion === "none") return;
    const key = resolveMotionName(motion) ?? undefined;
    if (!key) {
      console.warn(`[motion] unknown motion "${motion}", ignoring`);
      return;
    }
    if (this.current === key) {
      this.t = 0;
      this.fadeT = 0;
      this.fade = 0;
      return;
    }
    const entry = getMotion(key);
    if (!entry) return;
    this.current = key;
    this.t = 0;
    this.fadeT = 0;
    this.fade = 0;
    this.duration = entry.duration;
  }

  isActive(): boolean {
    return this.current !== null;
  }

  isAbsolute(): boolean {
    return this.current !== null && isCustomMotion(this.current);
  }

  update(dt: number): MotionUpdate | null {
    if (!this.current) return null;
    const entry = getMotion(this.current);
    if (!entry) {
      this.current = null;
      return null;
    }

    if (this.t >= this.duration) {
      this.fadeT += dt;
      if (this.fadeT >= FADE) {
        this.current = null;
        return null;
      }
      this.fade = 1 - smootherstep(this.fadeT / FADE);
    } else {
      this.t += dt;
      this.fade = this.t < RAMP ? smootherstep(this.t / RAMP) : 1;
    }

    const sampleT = Math.min(this.t, this.duration);
    const out: MotionState = {};
    let hipsPos: MotionDelta | undefined;
    if (entry.tracks) {
      // v4 bake: shared time grid + per-bone quat blobs, linear slerp.
      hipsPos = sampleTracks(entry.tracks, sampleT, out);
    } else {
      for (const [bone, frames] of Object.entries(entry.pose ?? {})) {
        const v = sampleHold(frames, sampleT);
        if (v) out[bone] = v;
      }
      hipsPos = entry.hipsPos
        ? (sampleHold(entry.hipsPos, sampleT) ?? undefined)
        : undefined;
    }
    return {
      state: out,
      absolute: this.isAbsolute(),
      fade: this.fade,
      hipsPos,
    };
  }
}

// hold last keyframe value during fade-out instead of returning null
function sampleHold(frames: Keyframe[], t: number) {
  if (!frames.length) return null;
  if (t >= frames[frames.length - 1].t) return frames[frames.length - 1].v;
  return sample(frames, t);
}

// ─── v4 baked tracks (base64 Float32 blobs, decoded in registry.ts) ───

const _bA = new THREE.Quaternion();
const _bB = new THREE.Quaternion();
const _bOut = new THREE.Quaternion();

// Greatest i with times[i] <= t. The grid is uniform, but binary-search
// anyway — log2(n) per bone per frame and immune to float drift in dt.
function trackIndex(times: Float32Array, t: number): number {
  const last = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[last]) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Samples every bone (and hips, when present) at t into out. Holds the last
// frame past the end (fade-out), first frame before the start.
function sampleTracks(
  tracks: MotionTracks,
  t: number,
  out: MotionState,
): MotionDelta | undefined {
  const { times } = tracks;
  const last = times.length - 1;
  const idx = trackIndex(times, t);
  const span = idx < last ? times[idx + 1] - times[idx] : 0;
  const k = span > 0 ? (t - times[idx]) / span : 0;

  for (const [bone, values] of Object.entries(tracks.bones)) {
    const i4 = idx * 4;
    if (idx >= last || span <= 0) {
      out[bone] = { x: values[i4], y: values[i4 + 1], z: values[i4 + 2], w: values[i4 + 3] };
      continue;
    }
    _bA.set(values[i4], values[i4 + 1], values[i4 + 2], values[i4 + 3]);
    const j4 = i4 + 4;
    _bB.set(values[j4], values[j4 + 1], values[j4 + 2], values[j4 + 3]);
    _bOut.slerpQuaternions(_bA, _bB, k);
    out[bone] = { x: _bOut.x, y: _bOut.y, z: _bOut.z, w: _bOut.w };
  }

  if (!tracks.hipsPos) return undefined;
  const values = tracks.hipsPos;
  const i3 = idx * 3;
  if (idx >= last || span <= 0) {
    return { x: values[i3], y: values[i3 + 1], z: values[i3 + 2] };
  }
  const j3 = i3 + 3;
  return {
    x: lerp(values[i3], values[j3], k),
    y: lerp(values[i3 + 1], values[j3 + 1], k),
    z: lerp(values[i3 + 2], values[j3 + 2], k),
  };
}
