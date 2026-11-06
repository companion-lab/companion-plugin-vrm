import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import type { VRM } from "@pixiv/three-vrm";
import { MOTION_BAKE_VERSION, type Keyframe, type Pose } from "./registry";

const SAMPLE_RATE = 30;
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
  pose: Pose;
  duration: number;
  expressions: ExpressionInfo[];
  hipsPos?: Keyframe[];
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
  const pose: Pose = {};
  let maxDuration = 0;

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

  for (const [boneName, track] of vrmAnim.humanoidTracks.rotation.entries()) {
    const keyframes: Keyframe[] = [];
    const rest = rests.get(boneName);
    const p = rest?.p ?? new THREE.Quaternion();
    const b = rest?.b ?? new THREE.Quaternion();

    for (let i = 0; i <= steps; i++) {
      const t = Math.min(i * dt, vrmAnim.duration);
      const q = sampleQuatAt(track.times, track.values, t);

      // VRM 0.x spec: negate x and z (same sign flip createVRMAnimationClip applies)
      if (metaVersion === "0") q.set(-q.x, q.y, -q.z, q.w);

      _qA.copy(b).invert().multiply(_qB.copy(p).invert()).multiply(q).multiply(p).multiply(b);

      keyframes.push({ t, v: { x: _qA.x, y: _qA.y, z: _qA.z, w: _qA.w } });
    }

    pose[boneName] = keyframes;
    if (keyframes.length > 0) {
      maxDuration = Math.max(maxDuration, keyframes[keyframes.length - 1].t);
    }
  }

  // hips translation: full XYZ root motion (offset from rest, rescaled).
  // Playback applies rest + offset with a horizontal leash (see animation.ts).
  let hipsPos: Keyframe[] | undefined;
  const hipsTrack = vrmAnim.humanoidTracks.translation.get("hips");
  if (hipsTrack) {
    const animRest = vrmAnim.restHipsPosition;
    const humanoidRest =
      humanoid.normalizedRestPose?.hips?.position != null
        ? new THREE.Vector3().fromArray(humanoid.normalizedRestPose.hips.position)
        : (humanoid.getRawBoneNode("hips")?.position.clone() ?? new THREE.Vector3(0, 1, 0));
    const scale = animRest.y > 1e-4 ? humanoidRest.y / animRest.y : 1.0;
    hipsPos = [];
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(i * dt, vrmAnim.duration);
      sampleVec3At(hipsTrack.times as unknown as Float32Array, hipsTrack.values as unknown as Float32Array, t, _vA);
      let dx = (_vA.x - animRest.x) * scale;
      const dy = (_vA.y - animRest.y) * scale;
      let dz = (_vA.z - animRest.z) * scale;
      // VRM 0.x spec: negate x and z (same sign flip createVRMAnimationClip applies)
      if (metaVersion === "0") {
        dx = -dx;
        dz = -dz;
      }
      hipsPos.push({ t, v: { x: dx, y: dy, z: dz } });
    }
  }

  const expressions: ExpressionInfo[] = [];
  for (const [presetName, track] of vrmAnim.expressionTracks.preset.entries()) {
    expressions.push({ preset: presetName, peakWeight: extractPeakWeight(track.values) });
  }

  return {
    name,
    pose,
    duration: maxDuration || vrmAnim.duration,
    expressions,
    hipsPos,
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
