import * as THREE from "three";
import type { VRMAnimation } from "@pixiv/three-vrm-animation";
import {
  registerBuiltin,
  getMotion,
  resolveMotionName,
  isCustomMotion,
  type Keyframe,
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
// Authored in the NORMALIZED humanoid frame (the space the vrma-editor
// reference drives): world-aligned T-pose rest, model facing +Z. Positive X
// euler pitches the face down (+Z → -Y), positive Y yaw turns it toward +X
// (viewer's right).

registerBuiltin(
  "nod",
  {
    neck: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.15, v: { x: 0.35, y: 0, z: 0 } },
      { t: 0.35, v: { x: -0.15, y: 0, z: 0 } },
      { t: 0.55, v: { x: 0.25, y: 0, z: 0 } },
      { t: 0.75, v: { x: -0.15, y: 0, z: 0 } },
      { t: 0.95, v: { x: 0, y: 0, z: 0 } },
    ],
    head: [
      { t: 0, v: { x: 0, y: 0, z: 0 } },
      { t: 0.15, v: { x: 0.15, y: 0, z: 0 } },
      { t: 0.35, v: { x: -0.05, y: 0, z: 0 } },
      { t: 0.55, v: { x: 0.15, y: 0, z: 0 } },
      { t: 0.75, v: { x: -0.05, y: 0, z: 0 } },
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
  /** Sampled canonical-space hips position (custom clips with a translation
   *  track). animation.ts flips x/z for VRM 0.x and rescales by
   *  modelRestHips.y / hipsRestY before writing the normalized hips node. */
  hipsPos?: MotionDelta;
  /** The animation's authored rest hips height (the rescale denominator). */
  hipsRestY?: number;
};

// Blend in/out times, seconds
const RAMP = 1.0; // ease-in (idle -> motion)
const FADE = 1.0; // fade-out (motion -> idle)

// zero acceleration at both ends (quintic)
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Greatest i with times[i] <= t (log2(n) per bone per frame, immune to float
// drift in dt).
function trackIndex(times: ArrayLike<number>, t: number): number {
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

const _tA = new THREE.Quaternion();
const _tB = new THREE.Quaternion();
const _tOut = new THREE.Quaternion();

// Linear slerp between the bracketing keys; holds first/last past the ends.
function sampleQuatTrack(track: { times: ArrayLike<number>; values: Float32Array }, t: number, out: THREE.Quaternion): void {
  const { times, values } = track;
  if (times.length === 0) {
    out.identity();
    return;
  }
  const idx = trackIndex(times, t);
  const i4 = idx * 4;
  _tA.set(values[i4], values[i4 + 1], values[i4 + 2], values[i4 + 3]);
  const last = times.length - 1;
  if (idx >= last) {
    out.copy(_tA);
    return;
  }
  const next = idx + 1;
  const span = times[next] - times[idx];
  const k = span > 0 ? (t - times[idx]) / span : 0;
  const j4 = next * 4;
  _tB.set(values[j4], values[j4 + 1], values[j4 + 2], values[j4 + 3]);
  out.slerpQuaternions(_tA, _tB, k);
}

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();

function sampleVec3Track(track: { times: ArrayLike<number>; values: Float32Array }, t: number, out: THREE.Vector3): void {
  const { times, values } = track;
  if (times.length === 0) {
    out.set(0, 0, 0);
    return;
  }
  const idx = trackIndex(times, t);
  const i3 = idx * 3;
  _vA.set(values[i3], values[i3 + 1], values[i3 + 2]);
  const last = times.length - 1;
  if (idx >= last) {
    out.copy(_vA);
    return;
  }
  const next = idx + 1;
  const span = times[next] - times[idx];
  const k = span > 0 ? (t - times[idx]) / span : 0;
  const j3 = next * 3;
  _vB.set(values[j3], values[j3 + 1], values[j3 + 2]);
  out.copy(_vA).lerp(_vB, k);
}

export class MotionController {
  private current: string | null = null;
  private t = 0;
  private duration = 0;
  private fadeT = 0;
  private fade = 1;
  private warnedNoAnim = new Set<string>();

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

    if (entry.anim) {
      // Custom .vrma clip: sample the parsed tracks — canonical normalized-
      // frame rotations (rest-relative, identity at rest) and the canonical
      // hips position. Per-model handling (VRM 0.x flip + hips rescale)
      // happens in animation.ts against the current model.
      const anim = entry.anim;
      for (const [bone, track] of anim.humanoidTracks.rotation.entries()) {
        const q = new THREE.Quaternion();
        sampleQuatTrack(track, sampleT, q);
        out[bone] = { x: q.x, y: q.y, z: q.z, w: q.w };
      }
      let hipsPos: MotionDelta | undefined;
      let hipsRestY: number | undefined;
      const hipsTrack = anim.humanoidTracks.translation.get("hips");
      if (hipsTrack) {
        const v = new THREE.Vector3();
        sampleVec3Track(hipsTrack, sampleT, v);
        hipsPos = { x: v.x, y: v.y, z: v.z };
        hipsRestY = anim.restHipsPosition.y;
      }
      return {
        state: out,
        absolute: true,
        fade: this.fade,
        hipsPos,
        hipsRestY,
      };
    }

    if (entry.source && !entry.anim) {
      // fmt-6 source registered but its async parse hasn't resolved yet:
      // stay active, keep the idle pose on screen until the clip is ready.
      if (!this.warnedNoAnim.has(this.current)) {
        this.warnedNoAnim.add(this.current);
        console.warn(`[motion] "${this.current}" is still parsing; holding idle`);
      }
      return null;
    }

    // Authored keyframes (built-ins; legacy cross-plugin pose customs).
    for (const [bone, frames] of Object.entries(entry.pose ?? {})) {
      const v = sampleHold(frames, sampleT);
      if (v) out[bone] = v;
    }
    return {
      state: out,
      absolute: this.isAbsolute(),
      fade: this.fade,
    };
  }
}

// hold last keyframe value during fade-out instead of returning null
function sampleHold(frames: Keyframe[], t: number) {
  if (!frames.length) return null;
  if (t >= frames[frames.length - 1].t) return frames[frames.length - 1].v;
  return sample(frames, t);
}
