import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin, type VRMAnimation } from "@pixiv/three-vrm-animation";
import type { VRM } from "@pixiv/three-vrm";
import { MOTION_SOURCE_VERSION, type StoredVrmaSource } from "./registry";
import { arrayBufferToBase64 } from "../base64";

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
  pose: StoredVrmaSource;
  duration: number;
  expressions: ExpressionInfo[];
  version: number;
}

/** Parse .vrma bytes into a model-independent VRMAnimation (the same object
 *  the vrma-editor reference samples for playback). Model-dependent handling
 *  (VRM 0.x x/z conjugation, hips rescale) happens at playback against the
 *  CURRENT model — see idle/animation.ts. */
export async function parseVrmaAnimation(data: ArrayBuffer): Promise<VRMAnimation> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

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
  return animations[0] as VRMAnimation;
}

/** Import a .vrma clip: parse it (for duration + expression extraction) and
 *  persist the ORIGINAL bytes — playback parses the same source and drives
 *  the normalized rig per the current model, following the vrma-editor
 *  reference. No per-model baking. The `vrm` param only guards that a model
 *  is loaded. */
export async function loadVrma(
  file: File | ArrayBuffer,
  name: string,
  vrm: VRM,
): Promise<VrmaResult> {
  void vrm;

  const data = file instanceof File ? await file.arrayBuffer() : file;
  const anim = await parseVrmaAnimation(data);

  const pose: StoredVrmaSource = {
    fmt: MOTION_SOURCE_VERSION,
    source: arrayBufferToBase64(data),
  };

  const expressions: ExpressionInfo[] = [];
  for (const [presetName, track] of anim.expressionTracks.preset.entries()) {
    expressions.push({ preset: presetName, peakWeight: extractPeakWeight(track.values) });
  }

  return {
    name,
    pose,
    duration: anim.duration,
    expressions,
    version: MOTION_SOURCE_VERSION,
  };
}
