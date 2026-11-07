import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import type { VRM } from "@pixiv/three-vrm";
import {
  MOTION_BAKE_VERSION,
  type BakedPoseV4,
} from "./registry";
import { arrayBufferToBase64 } from "../base64";

const SAMPLE_RATE = 30;
// Import-time budget, headroom under the backend's 64MB MOTION_LOAD_CAP:
// a bake the backend refuses to load would sit in the motion list forever,
// listed but silently unplayable — refuse it here instead, before anything
// is persisted.
const BAKE_BUDGET = 48 * 1024 * 1024;
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _qD = new THREE.Quaternion();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();

function extractPeakWeight(values: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) peak = values[i];
  }
  return peak;
}

export interface ExpressionInfo {
  preset: string;
  peakWeight: number;
}

export interface VrmaResult {
  name: string;
  pose: BakedPoseV4;
  duration: number;
  expressions: ExpressionInfo[];
  version: number;
}

export async function loadVrma(
  file: File | ArrayBuffer,
  name: string,
  vrm: VRM,
): Promise<VrmaResult> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const data = file instanceof File ? await file.arrayBuffer() : file;
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);

  let gltf: GLTF;
  try {
    gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const animations = (gltf as any).userData?.vrmAnimations;
  if (!animations?.length) {
    throw new Error("No VRM animation found in file");
  }

  const vrmAnim = animations[0];
  const boneBlobs: Record<string, Float32Array> = {};
  let hipsPos: Float32Array | undefined;

  // humanoidTracks.rotation quats (N) are normalized rest-relative deltas,
  // assigned straight onto normalized bones by createVRMAnimationClip.
  // three-vrm maps them to raw bones as: raw = invP * N * P * B
  // (P = parent world rest, B = local rest). Playback drives raw bones as
  // rest * delta, so bake delta = B^-1 * P^-1 * N * P * B.
  // P excludes scene-level yaw (rotateVRM0): built from ancestor locals.
  // Stored as quats, no euler roundtrip.
  // ponytail: P assumes identity scene transform; recompute from matrixWorld if models gain scene-level rotation.
  const humanoid = vrm.humanoid;
  humanoid.resetRawPose();

  const rests = new Map<string, { p: THREE.Quaternion; b: THREE.Quaternion }>();
  for (const [boneName] of vrmAnim.humanoidTracks.rotation.entries()) {
    const node = humanoid.getRawBoneNode(boneName);
    const b = new THREE.Quaternion();
    const p = new THREE.Quaternion();
    if (node) {
      b.copy(node.quaternion);
      const chain: THREE.Object3D[] = [];
      let cur: THREE.Object3D | null = node.parent;
      while (cur && cur !== vrm.scene) {
        chain.unshift(cur);
        cur = cur.parent;
      }
      for (const ancestor of chain) p.multiply(ancestor.quaternion);
    }
    rests.set(boneName, { p, b });
  }

  const metaVersion = vrm.meta.metaVersion;

  const steps = Math.max(1, Math.ceil(vrmAnim.duration * SAMPLE_RATE));
  const dt = vrmAnim.duration / steps;
  const frameCount = steps + 1;
  // Every bone is sampled on this one shared time grid; the v4 pose stores
  // it once and per-bone quat blobs keyed to it.
  const times = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) times[i] = Math.min(i * dt, vrmAnim.duration);

  for (const [boneName, track] of vrmAnim.humanoidTracks.rotation.entries()) {
    const values = new Float32Array(frameCount * 4);
    const rest = rests.get(boneName);
    const p = rest?.p ?? new THREE.Quaternion();
    const b = rest?.b ?? new THREE.Quaternion();

    for (let i = 0; i < frameCount; i++) {
      const q = sampleQuatAt(track.times, track.values, times[i]);

      // VRM 0.x spec: negate x and z (same sign flip createVRMAnimationClip applies)
      if (metaVersion === "0") q.set(-q.x, q.y, -q.z, q.w);

      _qA.copy(b).invert().multiply(_qB.copy(p).invert()).multiply(q).multiply(p).multiply(b);

      values[i * 4] = _qA.x;
      values[i * 4 + 1] = _qA.y;
      values[i * 4 + 2] = _qA.z;
      values[i * 4 + 3] = _qA.w;
    }

    boneBlobs[boneName] = values;
  }

  // hips translation: full XYZ root motion (offset from rest, rescaled).
  // Playback applies rest + offset with a horizontal leash (see animation.ts).
  const hipsTrack = vrmAnim.humanoidTracks.translation.get("hips");
  if (hipsTrack) {
    const animRest = vrmAnim.restHipsPosition;
    const humanoidRest =
      humanoid.normalizedRestPose?.hips?.position != null
        ? new THREE.Vector3().fromArray(humanoid.normalizedRestPose.hips.position)
        : (humanoid.getRawBoneNode("hips")?.position.clone() ?? new THREE.Vector3(0, 1, 0));
    const scale = animRest.y > 1e-4 ? humanoidRest.y / animRest.y : 1.0;
    hipsPos = new Float32Array(frameCount * 3);
    for (let i = 0; i < frameCount; i++) {
      sampleVec3At(hipsTrack.times as unknown as Float32Array, hipsTrack.values as unknown as Float32Array, times[i], _vA);
      let dx = (_vA.x - animRest.x) * scale;
      const dy = (_vA.y - animRest.y) * scale;
      let dz = (_vA.z - animRest.z) * scale;
      // VRM 0.x spec: negate x and z (same sign flip createVRMAnimationClip applies)
      if (metaVersion === "0") {
        dx = -dx;
        dz = -dz;
      }
      hipsPos[i * 3] = dx;
      hipsPos[i * 3 + 1] = dy;
      hipsPos[i * 3 + 2] = dz;
    }
  }

  const boneCount = Object.keys(boneBlobs).length;
  // bytes per frame: shared time (4) + one quat per bone (16 each) + hips xyz (12)
  const rawBytes = frameCount * (4 + boneCount * 16) + (hipsPos ? frameCount * 12 : 0);
  const bakedBytes = Math.ceil(rawBytes / 3) * 4; // base64 inflation
  if (bakedBytes > BAKE_BUDGET) {
    const bytesPerSec = (SAMPLE_RATE * (4 + boneCount * 16 + (hipsPos ? 12 : 0)) * 4) / 3;
    const maxDuration = Math.floor((BAKE_BUDGET / bytesPerSec) * 10) / 10;
    throw new Error(
      `Clip too long: ${vrmAnim.duration.toFixed(0)}s bakes to ~${Math.round(bakedBytes / 1048576)}MB ` +
        `(limit ${Math.round(BAKE_BUDGET / 1048576)}MB); trim it to under ~${maxDuration}s`,
    );
  }

  const encode = (f32: Float32Array): string => arrayBufferToBase64(f32.buffer);

  const pose: BakedPoseV4 = {
    fmt: 4,
    times: encode(times),
    bones: Object.fromEntries(Object.entries(boneBlobs).map(([name, v]) => [name, encode(v)])),
  };
  if (hipsPos) pose.hipsPos = encode(hipsPos);

  const expressions: ExpressionInfo[] = [];
  for (const [presetName, track] of vrmAnim.expressionTracks.preset.entries()) {
    expressions.push({ preset: presetName, peakWeight: extractPeakWeight(track.values) });
  }

  return {
    name,
    pose,
    duration: vrmAnim.duration,
    expressions,
    version: MOTION_BAKE_VERSION,
  };
}

function sampleVec3At(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  t: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (times.length === 0) return out.set(0, 0, 0);
  let idx = 0;
  for (let j = 0; j < times.length - 1; j++) {
    if (t >= times[j]) idx = j;
  }
  const next = Math.min(idx + 1, times.length - 1);
  const i3A = idx * 3;
  const i3B = next * 3;
  _vA.set(values[i3A], values[i3A + 1], values[i3A + 2]);
  if (idx === next) return out.copy(_vA);
  const span = times[next] - times[idx];
  const k = span > 0 ? (t - times[idx]) / span : 0;
  _vB.set(values[i3B], values[i3B + 1], values[i3B + 2]);
  return out.copy(_vA).lerp(_vB, k);
}

function sampleQuatAt(
  times: Float32Array,
  values: Float32Array,
  t: number,
): THREE.Quaternion {
  if (times.length === 0) return new THREE.Quaternion();

  let idx = 0;
  for (let j = 0; j < times.length - 1; j++) {
    if (t >= times[j]) idx = j;
  }
  const next = Math.min(idx + 1, times.length - 1);

  const i4A = idx * 4;
  const i4B = next * 4;
  _qC.set(values[i4A], values[i4A + 1], values[i4A + 2], values[i4A + 3]);

  if (idx === next) return _qC.clone();

  const span = times[next] - times[idx];
  const k = span > 0 ? (t - times[idx]) / span : 0;
  _qD.set(values[i4B], values[i4B + 1], values[i4B + 2], values[i4B + 3]);
  return _qC.clone().slerp(_qD, k);
}
