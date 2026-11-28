import * as THREE from "three";
import { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { VRMHandle } from "../loader";
import type { MotionDelta, MotionState } from "./motion";
import type { ExpressionController } from "../expression/controller";
import { updateCursorLook } from "../cursor-look";
import { updateCarryLean, type CarryLean } from "../carry-lean";
import type { VRMAnimation } from "@pixiv/three-vrm-animation";
import { sampleVrmaPose } from "./motion";

const _euler = new THREE.Euler();
const _qIdle = new THREE.Quaternion();
const _qMo = new THREE.Quaternion();
const _qBlend = new THREE.Quaternion();
const restHipsPos = new THREE.Vector3();
let hipsRestCaptured = false;
let restGroundY = 0;
let groundReady = false;
// The rescale denominator for custom-clip hips positions: the animation's
// authored rest hips height (MotionUpdate.hipsRestY).
let motionHipsRestY: number | undefined;
// VRM 0.x models face -Z natively (rotateVRM0 turns the scene 180° around Y),
// while .vrma canonical space faces +Z — matching the vrma-editor reference
// and three-vrm's own createVRMAnimationClip, quaternion x/z components are
// conjugated and hips x/z mirrored when playing on a VRM 0.x model.
let vrmIsVrm0 = false;

const BONES: VRMHumanBoneName[] = [
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftEye",
  "rightEye",
  "leftShoulder",
  "rightShoulder",
  "hips",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
  "leftHand",
  "rightHand",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftFoot",
  "rightFoot",
  "leftToes",
  "rightToes",
];

for (const side of ["left", "right"] as const) {
  for (const finger of ["Thumb", "Index", "Middle", "Ring", "Little"] as const) {
    for (const joint of ["Proximal", "Intermediate", "Distal"] as const) {
      BONES.push(`${side}${finger}${joint}` as VRMHumanBoneName);
    }
  }
}

// Normalized rig nodes resolved once per model (the rig the engine drives —
// identical conventions for VRM 0.x and 1.0: identity rest, world-aligned
// T-pose, facing the model's front).
const boneCache = new Map<string, THREE.Object3D | null | undefined>();

function boneNode(humanoid: VRM["humanoid"], name: VRMHumanBoneName): THREE.Object3D | null {
  let node = boneCache.get(name);
  if (node === undefined) {
    node = humanoid?.getNormalizedBoneNode(name) ?? null;
    boneCache.set(name, node);
  }
  return node;
}

// RAW foot nodes: ground contact is measured on the posed (post-sync) raw
// skeleton, exactly like the vrma-editor reference measures restFeetY.
const FOOT_BONES = ["leftFoot", "rightFoot", "leftToes", "rightToes"] as const;
const rawFootNodes: Array<THREE.Object3D | null> = [];
let firstFrame = true;
let motionOverride: MotionState | null = null;
let motionAbsolute = false;
let motionFade = 1;
let motionHipsPos: { x: number; y: number; z: number } | null = null;

export function setMotionOverride(
  state: MotionState | null,
  absolute = false,
  fade = 1,
  hipsPos?: { x: number; y: number; z: number } | null,
  hipsRestY?: number,
): void {
  motionOverride = state;
  motionAbsolute = absolute;
  motionFade = fade;
  motionHipsPos = hipsPos ?? null;
  motionHipsRestY = hipsRestY;
}

let groundTick = 0;

// horizontal root-motion leash: avatar may drift this far from rest (meters)
const HIPS_LEASH_RADIUS = 0.35;

function minFootY(): number {
  // Reads matrixWorld directly; the caller must have run updateMatrixWorld()
  // first. Avoids getWorldPosition(), which re-walks the parent chain per bone.
  let min = Infinity;
  for (const bone of rawFootNodes) {
    if (!bone) continue;
    const y = bone.matrixWorld.elements[13];
    if (y < min) min = y;
  }
  return min;
}

// Per-model capture at attach: rest hips position of the normalized rig, raw
// foot nodes for ground measurement, and the model's VRM version. Mirrors the
// vrma-editor reference's restHipsPos / restFeetY capture.
function captureRest(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  vrmIsVrm0 = vrm.meta?.metaVersion === "0";
  for (const name of BONES) boneNode(humanoid, name);
  const hips = boneNode(humanoid, "hips");
  if (hips && !hipsRestCaptured) {
    restHipsPos.copy(hips.position);
    hipsRestCaptured = true;
  }
  firstFrame = false;
}

export function resetIdleState(): void {
  boneCache.clear();
  rawFootNodes.length = 0;
  firstFrame = true;
  hipsRestCaptured = false;
  groundReady = false;
  motionOverride = null;
  motionHipsPos = null;
  motionFade = 1;
  motionHipsRestY = undefined;
  scheduleNextBlink();
}

export function captureGroundReference(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  vrmIsVrm0 = vrm.meta?.metaVersion === "0";
  // The rig is fresh at attach: capture rest hips from the normalized rig and
  // the rest ground height from the raw feet (same capture as the reference).
  for (const name of BONES) boneNode(humanoid, name);
  const hips = boneNode(humanoid, "hips");
  if (hips) {
    restHipsPos.copy(hips.position);
    hipsRestCaptured = true;
  }
  rawFootNodes.length = 0;
  for (const name of FOOT_BONES) {
    rawFootNodes.push(humanoid.getRawBoneNode(name) ?? null);
  }
  vrm.scene.updateMatrixWorld(true);
  const y = minFootY();
  if (y !== Infinity) {
    restGroundY = y;
    groundReady = true;
  }
}

// Authored pose deltas live in CANONICAL space (+Z-facing T-pose, the space
// .vrma files and every cross-version value use). The normalized rig is
// captured BEFORE rotateVRM0, so a VRM 0.x model's rig faces its native -Z:
// canonical deltas must be conjugated by that π yaw — the same x/z negation
// canonicalToRigQuat applies to .vrma quats and three-vrm's
// createVRMAnimationClip applies to VRM 0.x tracks. VRM 1.0 rigs already face
// +Z and pass through unchanged.
function idleEulerToRigQuat(nx: number, ny: number, nz: number, out: THREE.Quaternion): THREE.Quaternion {
  out.setFromEuler(_euler.set(nx, ny, nz, "YXZ"));
  if (vrmIsVrm0) out.set(-out.x, out.y, -out.z, out.w);
  return out;
}

// Applies an authored (canonical) euler delta onto the normalized rig node —
// the rig's rest is identity, so the converted delta IS the local rotation.
function applyPose(
  humanoid: VRM["humanoid"],
  name: VRMHumanBoneName,
  nx: number,
  ny: number,
  nz: number,
): void {
  if (!humanoid) return;
  const bone = boneNode(humanoid, name);
  if (!bone) return;
  idleEulerToRigQuat(nx, ny, nz, bone.quaternion);
}

// Applies a rig-frame quaternion delta straight onto the rig node.
function applyDeltaQuat(
  humanoid: VRM["humanoid"],
  name: VRMHumanBoneName,
  delta: THREE.Quaternion,
): void {
  if (!humanoid) return;
  const bone = boneNode(humanoid, name);
  if (!bone) return;
  bone.quaternion.copy(delta);
}

// Canonical (.vrma space) quaternion → rig-frame: conjugate x/z for VRM 0.x
// (the π-yaw conjugation three-vrm's createVRMAnimationClip applies). Euler
// deltas (legacy authored poses) are canonical too and go through the same
// conversion.
function canonicalToRigQuat(d: MotionDelta, out: THREE.Quaternion): THREE.Quaternion {
  if (d.w !== undefined) {
    out.set(d.x, d.y, d.z, d.w);
    if (vrmIsVrm0) out.set(-out.x, out.y, -out.z, out.w);
    return out;
  }
  return idleEulerToRigQuat(d.x, d.y, d.z, out);
}

function applyMotionOverride(
  humanoid: VRM["humanoid"],
  base: (h: VRM["humanoid"], name: VRMHumanBoneName, nx: number, ny: number, nz: number) => void,
  name: VRMHumanBoneName,
  nx: number,
  ny: number,
  nz: number,
): void {
  const mo = motionOverride?.[name];
  if (mo) {
    if (motionAbsolute) {
      // Both sides are rig-frame quats: the idle delta conjugated from
      // canonical space, the motion delta likewise. Slerp by the fade.
      idleEulerToRigQuat(nx, ny, nz, _qIdle);
      canonicalToRigQuat(mo, _qMo);
      _qBlend.copy(_qIdle).slerp(_qMo, motionFade);
      applyDeltaQuat(humanoid, name, _qBlend);
    } else {
      // additive pose (builtins): eulers add in the normalized frame
      base(humanoid, name, nx + mo.x, ny + mo.y, nz + mo.z);
    }
  } else {
    base(humanoid, name, nx, ny, nz);
  }
}

// Blink state
let nextBlinkTime = 0;
let blinkPhase = 0;
let blinkTimer = 0;

const BLINK_SPEED = 12;

function scheduleNextBlink() {
  nextBlinkTime = 2 + Math.random() * 4;
  blinkTimer = 0;
}

function updateBlink(vrm: VRM, dt: number): void {
  const expr = vrm.expressionManager;
  if (!expr) return;

  if (blinkPhase === 0) {
    blinkTimer += dt;
    if (blinkTimer >= nextBlinkTime) {
      blinkPhase = 1;
      blinkTimer = 0;
    }
    return;
  }

  blinkTimer += dt * BLINK_SPEED;
  if (blinkTimer < 1) {
    expr.setValue("blink", blinkTimer);
  } else if (blinkTimer < 2) {
    expr.setValue("blink", 1.0);
  } else if (blinkTimer < 3) {
    expr.setValue("blink", 3 - blinkTimer);
  } else {
    expr.setValue("blink", 0);
    blinkPhase = 0;
    scheduleNextBlink();
  }
}

let breathPhase = 0;

// Idle pose deltas, authored in CANONICAL space: +Z-facing T-pose rest,
// viewer's right = +X — the .vrma convention, shared by both VRM versions.
// Left arm hangs along +X at T-pose, so lowering it rotates about Z toward
// -Y (z: -1.2); the right arm mirrors. Elbow flexion swings the forearm
// toward the front (+Z): y: -0.3 left / +0.3 right. Knee flexion swings the
// shin backward (-Z): +X rotation. idleEulerToRigQuat conjugates these into
// the model's rig frame (VRM 0.x rigs face their native -Z).
const POSE = {
  spine: { x: 0, y: 0, z: 0 },
  chest: { x: 0, y: 0, z: 0 },
  upperChest: { x: 0, y: 0, z: 0 },
  neck: { x: 0, y: 0, z: 0 },
  head: { x: 0, y: 0, z: 0 },
  leftShoulder: { x: 0, y: 0, z: -0.05 },
  rightShoulder: { x: 0, y: 0, z: 0.05 },
  hips: { x: 0, y: 0, z: 0 },
  leftUpperArm: { x: 0, y: 0, z: -1.2 },
  rightUpperArm: { x: 0, y: 0, z: 1.2 },
  leftLowerArm: { x: 0, y: -0.3, z: 0 },
  rightLowerArm: { x: 0, y: 0.3, z: 0 },
  leftHand: { x: 0, y: -0.2, z: 0 },
  rightHand: { x: 0, y: 0.2, z: 0 },
  leftUpperLeg: { x: 0, y: 0, z: 0 },
  rightUpperLeg: { x: 0, y: 0, z: 0 },
  leftLowerLeg: { x: 0.15, y: 0, z: 0 },
  rightLowerLeg: { x: 0.15, y: 0, z: 0 },
} as const;

// bones that updateBody applies via applyMotionOverride
const IDLE_APPLIED = new Set<string>([...Object.keys(POSE), "leftEye", "rightEye"]);

// The bundled idle clip (assets/animations/Idle.vrma), when available: it owns
// the base pose and is sampled on a loop each frame — replacing the manual
// POSE fallback below, exactly like the vrma-editor reference drives an
// animation. The manual pose stays as the fallback when no clip loads.
let idleClip: VRMAnimation | null = null;
let idleTime = 0;
const IDENTITY_DELTA: MotionDelta = { x: 0, y: 0, z: 0, w: 1 };
const _qB = new THREE.Quaternion();
const _qLook = new THREE.Quaternion();
const _qCarry = new THREE.Quaternion();
const _hipsMotion = new THREE.Vector3();

/** Install the bundled idle clip (null restores the manual pose fallback). */
export function setIdleClip(anim: VRMAnimation | null): void {
  idleClip = anim;
  idleTime = 0;
}

function updateBody(vrm: VRM, dt: number): void {
  if (firstFrame) captureRest(vrm);

  // Carry reaction (see carry-lean.ts): smooths the host's drag feed, shifts
  // the model root opposite the motion (spring bones follow), and returns the
  // body lean. Zero when the window is at rest, so this costs nothing idle.
  const carry = updateCarryLean(dt);

  if (idleClip) {
    updateIdleClipBody(vrm, dt, carry);
    return;
  }

  breathPhase += dt;

  const breath = Math.sin(breathPhase * 1.2) * 0.01;
  const sway = Math.sin(breathPhase * 0.55) * 0.012;
  // Cursor tracking rides on the idle sway (targets smoothed in cursor-look;
  // zero while tracking is off or the cursor is outside the window). Applied
  // through the same neck/head/eye deltas, so motion overrides keep winning.
  const cursor = updateCursorLook(dt);
  const lookYaw = Math.sin(breathPhase * 0.3) * 0.12 + cursor.yaw;
  const lookPitch = Math.sin(breathPhase * 0.22) * 0.05 + cursor.pitch;
  const armBob = Math.sin(breathPhase * 0.9) * 0.04;
  const weightShift = Math.sin(breathPhase * 0.5);
  const breathY = Math.sin(breathPhase * 1.2) * 0.01;

  // Carry lean rides on the idle pose (targets smoothed in carry-lean): the
  // roll tips the body opposite the drag (inertia lag), distributed down the
  // spine chain; the pitch is the smaller forward/back component.
  applyMotionOverride(vrm.humanoid, applyPose, "spine", POSE.spine.x + carry.pitch * 0.3, POSE.spine.y + breathY, POSE.spine.z + sway + carry.roll * 0.4);
  applyMotionOverride(vrm.humanoid, applyPose, "chest", POSE.chest.x + carry.pitch * 0.3, POSE.chest.y, POSE.chest.z + sway * 0.6 + carry.roll * 0.35);
  applyMotionOverride(vrm.humanoid, applyPose, "upperChest", POSE.upperChest.x, POSE.upperChest.y, POSE.upperChest.z + breath * 0.5 + carry.roll * 0.25);
  applyMotionOverride(vrm.humanoid, applyPose, "neck", POSE.neck.x + lookPitch * 0.3, POSE.neck.y + lookYaw * 0.3, POSE.neck.z + Math.sin(breathPhase * 0.5) * 0.02);
  applyMotionOverride(vrm.humanoid, applyPose, "head", POSE.head.x + lookPitch, POSE.head.y + lookYaw, POSE.head.z + Math.sin(breathPhase * 0.4) * 0.02);

  applyMotionOverride(vrm.humanoid, applyPose, "leftEye", lookPitch * 0.4, lookYaw * 0.3, 0);
  applyMotionOverride(vrm.humanoid, applyPose, "rightEye", lookPitch * 0.4, lookYaw * 0.3, 0);

  applyMotionOverride(vrm.humanoid, applyPose, "leftShoulder", POSE.leftShoulder.x, POSE.leftShoulder.y, POSE.leftShoulder.z + armBob * 0.3);
  applyMotionOverride(vrm.humanoid, applyPose, "rightShoulder", POSE.rightShoulder.x, POSE.rightShoulder.y, POSE.rightShoulder.z - armBob * 0.3);

  applyMotionOverride(vrm.humanoid, applyPose, "hips", POSE.hips.x + breath * 0.3 + carry.pitch * 0.4, POSE.hips.y, POSE.hips.z + weightShift * 0 + carry.roll * 0.2);

  applyMotionOverride(vrm.humanoid, applyPose, "leftUpperArm", POSE.leftUpperArm.x, POSE.leftUpperArm.y, POSE.leftUpperArm.z + armBob);
  applyMotionOverride(vrm.humanoid, applyPose, "rightUpperArm", POSE.rightUpperArm.x, POSE.rightUpperArm.y, POSE.rightUpperArm.z - armBob);

  applyMotionOverride(vrm.humanoid, applyPose, "leftLowerArm", POSE.leftLowerArm.x, POSE.leftLowerArm.y + Math.sin(breathPhase * 0.9) * 0.05, POSE.leftLowerArm.z);
  applyMotionOverride(vrm.humanoid, applyPose, "rightLowerArm", POSE.rightLowerArm.x, POSE.rightLowerArm.y + Math.sin(breathPhase * 0.9 + 0.5) * 0.05, POSE.rightLowerArm.z);

  applyMotionOverride(vrm.humanoid, applyPose, "leftHand", POSE.leftHand.x, POSE.leftHand.y + Math.sin(breathPhase * 1.3) * 0.06, POSE.leftHand.z);
  applyMotionOverride(vrm.humanoid, applyPose, "rightHand", POSE.rightHand.x, POSE.rightHand.y + Math.sin(breathPhase * 1.3 + 0.4) * 0.06, POSE.rightHand.z);

  applyMotionOverride(vrm.humanoid, applyPose, "leftUpperLeg", POSE.leftUpperLeg.x, POSE.leftUpperLeg.y, POSE.leftUpperLeg.z + weightShift * 0.015);
  applyMotionOverride(vrm.humanoid, applyPose, "rightUpperLeg", POSE.rightUpperLeg.x, POSE.rightUpperLeg.y, POSE.rightUpperLeg.z - weightShift * 0.015);

  applyMotionOverride(vrm.humanoid, applyPose, "leftLowerLeg", POSE.leftLowerLeg.x + Math.sin(breathPhase * 0.6) * 0.015, POSE.leftLowerLeg.y, POSE.leftLowerLeg.z);
  applyMotionOverride(vrm.humanoid, applyPose, "rightLowerLeg", POSE.rightLowerLeg.x + Math.sin(breathPhase * 0.6 + 1) * 0.015, POSE.rightLowerLeg.y, POSE.rightLowerLeg.z);

  // Hips position on the normalized rig: rest by default; with a custom clip
  // driving translation, blend rest → the clip's position (rescaled to the
  // model via the rest-height ratio, x/z mirrored for VRM 0.x) by the fade —
  // the vrma-editor reference's hips handling plus an idle blend.
  const hipsNode = boneNode(vrm.humanoid, "hips");
  if (hipsNode && hipsRestCaptured) {
    hipsNode.position.copy(restHipsPos);
    if (motionHipsPos && motionHipsRestY && motionHipsRestY > 1e-3) {
      const s = restHipsPos.y / motionHipsRestY;
      _hipsTarget.set(
        vrmIsVrm0 ? -motionHipsPos.x * s : motionHipsPos.x * s,
        motionHipsPos.y * s,
        vrmIsVrm0 ? -motionHipsPos.z * s : motionHipsPos.z * s,
      );
      hipsNode.position.lerp(_hipsTarget, motionFade);
      // leash: clamp horizontal offset to a circle around rest position
      const dx = hipsNode.position.x - restHipsPos.x;
      const dz = hipsNode.position.z - restHipsPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > HIPS_LEASH_RADIUS) {
        const k = HIPS_LEASH_RADIUS / dist;
        hipsNode.position.x = restHipsPos.x + dx * k;
        hipsNode.position.z = restHipsPos.z + dz * k;
      }
    }
  }
}

const _hipsTarget = new THREE.Vector3();

// The idle-clip body: samples the bundled idle clip on a loop and writes the
// normalized rig directly — the vrma-editor reference's applyPose pattern.
// The idle clip owns the base pose; motions blend over it (absolute slerp /
// additive multiply), the cursor look pre-multiplies onto neck/head/eyes, and
// the carry lean pre-multiplies onto the spine chain.
function updateIdleClipBody(vrm: VRM, dt: number, carry: CarryLean): void {
  const humanoid = vrm.humanoid;
  if (!humanoid || !idleClip) return;
  idleTime = (idleTime + dt) % Math.max(idleClip.duration, 0.05);
  const { state, hipsPos, hipsRestY } = sampleVrmaPose(idleClip, idleTime);
  const cursor = updateCursorLook(dt);
  const lookPitch = cursor.pitch;
  const lookYaw = cursor.yaw;

  for (const name of Object.keys(humanoid.humanBones)) {
    const boneName = name as VRMHumanBoneName;
    const node = boneNode(humanoid, boneName);
    if (!node) continue;
    const q = canonicalToRigQuat(state[name] ?? IDENTITY_DELTA, _qB);
    const mo = motionOverride?.[name];
    if (mo) {
      canonicalToRigQuat(mo, _qMo);
      if (motionAbsolute) {
        _qB.copy(q).slerp(_qMo, motionFade);
      } else {
        // additive legacy pose: rotate the idle pose by the delta
        _qB.copy(q).multiply(_qMo);
      }
    }
    // Cursor look rides on top of the clip pose (a small world-frame turn,
    // pre-multiplied; weights mirror the manual fallback).
    let pitchW = 0;
    let yawW = 0;
    if (name === "head") { pitchW = 1; yawW = 1; }
    else if (name === "neck") { pitchW = 0.3; yawW = 0.3; }
    else if (name === "leftEye" || name === "rightEye") { pitchW = 0.4; yawW = 0.3; }
    if ((pitchW || yawW) && !(motionAbsolute && motionOverride?.[name])) {
      idleEulerToRigQuat(lookPitch * pitchW, lookYaw * yawW, 0, _qLook);
      node.quaternion.copy(_qB.premultiply(_qLook));
      continue;
    }
    // Carry lean rides the spine chain the same way (weights sum to ~1.2 of
    // the clamped lean, like the manual fallback).
    let rollW = 0;
    let carryPitchW = 0;
    if (name === "hips") { rollW = 0.2; carryPitchW = 0.4; }
    else if (name === "spine") { rollW = 0.4; carryPitchW = 0.3; }
    else if (name === "chest") { rollW = 0.35; carryPitchW = 0.3; }
    else if (name === "upperChest") { rollW = 0.25; carryPitchW = 0.2; }
    if ((rollW || carryPitchW) && !(motionAbsolute && motionOverride?.[name])) {
      idleEulerToRigQuat(carry.pitch * carryPitchW, 0, carry.roll * rollW, _qCarry);
      node.quaternion.copy(_qB.premultiply(_qCarry));
      continue;
    }
    node.quaternion.copy(_qB);
  }

  // Hips position: the clip's translation (rescaled to the model, x/z
  // mirrored for VRM 0.x), with an active motion's root motion blended over
  // it by the fade. Horizontal leash keeps the avatar anchored.
  const hipsNode = boneNode(humanoid, "hips");
  if (hipsNode && hipsRestCaptured) {
    hipsNode.position.copy(restHipsPos);
    if (hipsPos && hipsRestY && hipsRestY > 1e-3) {
      const s = restHipsPos.y / hipsRestY;
      _hipsTarget.set(
        vrmIsVrm0 ? -hipsPos.x * s : hipsPos.x * s,
        hipsPos.y * s,
        vrmIsVrm0 ? -hipsPos.z * s : hipsPos.z * s,
      );
      hipsNode.position.lerp(_hipsTarget, 1);
    }
    if (motionHipsPos && motionHipsRestY && motionHipsRestY > 1e-3) {
      const s = restHipsPos.y / motionHipsRestY;
      _hipsMotion.set(
        vrmIsVrm0 ? -motionHipsPos.x * s : motionHipsPos.x * s,
        motionHipsPos.y * s,
        vrmIsVrm0 ? -motionHipsPos.z * s : motionHipsPos.z * s,
      );
      hipsNode.position.lerp(_hipsMotion, motionFade);
    }
    const dx = hipsNode.position.x - restHipsPos.x;
    const dz = hipsNode.position.z - restHipsPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > HIPS_LEASH_RADIUS) {
      const k = HIPS_LEASH_RADIUS / dist;
      hipsNode.position.x = restHipsPos.x + dx * k;
      hipsNode.position.z = restHipsPos.z + dz * k;
    }
  }
}

export function idleAnimation(handle: VRMHandle, _t: number, dt: number, expr?: ExpressionController | null): void {
  const vrm = handle.vrm;
  if (!vrm) return;

  if (expr?.getEmotion() !== "happy") {
    updateBlink(vrm, dt);
  }

  updateBody(vrm, dt);

  // bones not covered by updateBody's POSE calls (fingers, toes, feet):
  // slerp from rest (identity) to the motion delta by the blend weight
  if (motionOverride) {
    const k = motionAbsolute ? motionFade : 1;
    for (const name in motionOverride) {
      if (IDLE_APPLIED.has(name)) continue;
      const mo = motionOverride[name];
      canonicalToRigQuat(mo, _qMo);
      _qBlend.identity().slerp(_qMo, k);
      applyDeltaQuat(vrm.humanoid, name as VRMHumanBoneName, _qBlend);
    }
  }

  // Propagate the normalized rig onto the raw bones (autoUpdateHumanBones) —
  // the same sync the vrma-editor reference runs after posing the rig. The
  // engine loop's vrm.update(dt) call then advances expressions/lookAt/
  // springbones on top of the posed skeleton.
  vrm.humanoid?.update();
}

/** Post-sync pass: runs after vrm.update(dt) has propagated the normalized
 *  rig onto the raw bones and updated world matrices. Ground contact is
 *  measured on the raw skeleton here — the reference's applyHipsLift slot. */
export function postIdleAnimation(handle: VRMHandle): void {
  const vrm = handle.vrm;
  if (!vrm) return;

  vrm.scene.updateMatrixWorld();
  if (!motionOverride) {
    // Cheap duty cycle: the idle ground reference drifts slowly, if at all.
    groundTick++;
    if (groundTick % 15 === 0) {
      const y = minFootY();
      if (y !== Infinity) {
        restGroundY = y;
        groundReady = true;
      }
    }
    return;
  }

  // cheap root clamp: push the avatar up when a foot sinks below rest
  // ground height. One-sided only (never pulls down) so it can't cancel
  // jumps or the clip's hips Y motion. Runs for absolute (custom) motions.
  if (motionAbsolute && motionFade > 0.001 && groundReady) {
    const y = minFootY();
    if (y !== Infinity) {
      let lift = restGroundY - y;
      if (lift < 1e-5) lift = 0;
      else if (lift > 0.5) lift = 0.5;
      if (lift > 0) {
        const humanoid = vrm.humanoid;
        const hipsNode = humanoid?.getRawBoneNode("hips") ?? null;
        if (hipsNode) {
          hipsNode.position.y += lift;
          // Position write marks the subtree dirty; a normal update propagates it.
          vrm.scene.updateMatrixWorld();
        }
      }
    }
  }
}
