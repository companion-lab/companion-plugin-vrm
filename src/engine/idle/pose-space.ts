import * as THREE from "three";

const _pInv = new THREE.Quaternion();
const _bInv = new THREE.Quaternion();

// The engine authors pose deltas (idle sway, builtin motions) in three-vrm's
// NORMALIZED humanoid frame: identity rest rotations, world-aligned T-pose,
// model facing +Z. That frame is identical for every VRM version and model —
// unlike the raw bones, whose local axes differ per export (VRM 1.0 bones
// carry identity rest rotations, VRM 0.x exports use Unity's conventions),
// so raw-local eulers cannot be shared between them.
//
// normalizedToRawDelta maps such a delta N onto the model's raw-bone LOCAL
// delta D so that raw = rest·D reproduces exactly the mapping three-vrm's
// VRMHumanoidRig.update() uses to copy the normalized rig onto raw bones:
//
//   raw = P⁻¹ · N · P · B        (P = parent world rest, B = raw local rest)
//
// For the idle pose, P must include the model's scene-level yaw (rotateVRM0's
// 180° turn for VRM 0.x) so N applies in the rendered frame; with that yaw
// folded in, raw = (yaw·P)⁻¹·N·(yaw·P)·B yields a world delta of exactly N.
// For the π yaw this equals the x/z negation three-vrm applies to VRM 0.x
// .vrma tracks (the bake keeps its own pre-yaw P + negation form — same math).
//
// Solving for the delta applied as raw = B·D gives the sandwich below — the
// same one the .vrma bake records (see vrma-loader.ts), so idle poses and
// baked motions stay in one convention per model.
export function normalizedToRawDelta(
  n: THREE.Quaternion,
  p: THREE.Quaternion,
  b: THREE.Quaternion,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _pInv.copy(p).invert();
  _bInv.copy(b).invert();
  return out.copy(_bInv).multiply(_pInv).multiply(n).multiply(p).multiply(b);
}
