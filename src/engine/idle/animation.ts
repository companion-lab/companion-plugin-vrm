import * as THREE from "three";
import { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { VRMHandle } from "../loader";
import type { MotionDelta, MotionState } from "./motion";
import type { ExpressionController } from "../expression/controller";
import { updateCursorLook } from "../cursor-look";

const _euler = new THREE.Euler();
const _delta = new THREE.Quaternion();
const _qIdle = new THREE.Quaternion();
const _qMo = new THREE.Quaternion();
const _qBlend = new THREE.Quaternion();
const restHipsPos = new THREE.Vector3();
let hipsRestCaptured = false;
let restGroundY = 0;
let groundReady = false;

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

const restCache = new Map<string, THREE.Quaternion>();
// Raw bone nodes resolved once per model instead of a Map lookup per bone per frame.
const boneCache = new Map<string, THREE.Object3D | null | undefined>();

function boneNode(humanoid: VRM["humanoid"], name: VRMHumanBoneName): THREE.Object3D | null {
  let node = boneCache.get(name);
  if (node === undefined) {
    node = humanoid?.getRawBoneNode(name) ?? null;
    boneCache.set(name, node);
  }
  return node;
}
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
): void {
  motionOverride = state;
  motionAbsolute = absolute;
  motionFade = fade;
  motionHipsPos = hipsPos ?? null;
}

const FOOT_BONES = ["leftFoot", "rightFoot", "leftToes", "rightToes"] as const;
let groundTick = 0;

// horizontal root-motion leash: avatar may drift this far from rest (meters)
const HIPS_LEASH_RADIUS = 0.35;

function minFootY(): number {
  // Reads matrixWorld directly; the caller must have run updateMatrixWorld()
  // first. Avoids getWorldPosition(), which re-walks the parent chain per bone.
  let min = Infinity;
  for (const name of FOOT_BONES) {
    const bone = boneCache.get(name);
    if (!bone) continue;
    const y = bone.matrixWorld.elements[13];
    if (y < min) min = y;
  }
  return min;
}

function captureRest(humanoid: VRM["humanoid"]): void {
  if (!humanoid) return;
  for (const name of BONES) {
    const bone = boneNode(humanoid, name);
    if (bone && !restCache.has(name)) {
      restCache.set(name, bone.quaternion.clone());
    }
  }
  const hips = boneNode(humanoid, "hips");
  if (hips && !hipsRestCaptured) {
    restHipsPos.copy(hips.position);
    hipsRestCaptured = true;
  }
  firstFrame = false;
}

export function resetIdleState(): void {
  restCache.clear();
  boneCache.clear();
  firstFrame = true;
  hipsRestCaptured = false;
  groundReady = false;
  motionOverride = null;
  motionHipsPos = null;
  motionFade = 1;
  scheduleNextBlink();
}

export function captureGroundReference(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;
  humanoid.resetRawPose();
  boneCache.clear();
  // Pre-populate the bone cache; minFootY() reads from it.
  for (const name of BONES) boneNode(humanoid, name);
  const hips = boneNode(humanoid, "hips");
  if (hips) {
    restHipsPos.copy(hips.position);
    hipsRestCaptured = true;
  }
  vrm.scene.updateMatrixWorld(true);
  const y = minFootY();
  if (y !== Infinity) {
    restGroundY = y;
    groundReady = true;
  }
}

function applyDelta(
  humanoid: VRM["humanoid"],
  name: VRMHumanBoneName,
  x: number,
  y: number,
  z: number,
): void {
  if (!humanoid) return;
  const bone = boneNode(humanoid, name);
  if (!bone) return;
  const rest = restCache.get(name);
  if (!rest) return;
  _euler.set(x, y, z, "YXZ");
  _delta.setFromEuler(_euler);
  bone.quaternion.copy(rest).multiply(_delta);
}

function applyDeltaQuat(
  humanoid: VRM["humanoid"],
  name: VRMHumanBoneName,
  delta: THREE.Quaternion,
): void {
  if (!humanoid) return;
  const bone = boneNode(humanoid, name);
  if (!bone) return;
  const rest = restCache.get(name);
  if (!rest) return;
  bone.quaternion.copy(rest).multiply(delta);
}

// YXZ euler -> quat (builtin euler deltas)
function eulerToQuat(x: number, y: number, z: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(_euler.set(x, y, z, "YXZ"));
}

function deltaToQuat(d: MotionDelta, out: THREE.Quaternion): THREE.Quaternion {
  if (d.w !== undefined) return out.set(d.x, d.y, d.z, d.w);
  return eulerToQuat(d.x, d.y, d.z, out);
}

function applyMotionOverride(
  humanoid: VRM["humanoid"],
  base: (h: VRM["humanoid"], name: VRMHumanBoneName, x: number, y: number, z: number) => void,
  name: VRMHumanBoneName,
  x: number,
  y: number,
  z: number,
): void {
  const mo = motionOverride?.[name];
  if (mo) {
    if (motionAbsolute) {
      eulerToQuat(x, y, z, _qIdle);
      deltaToQuat(mo, _qMo);
      _qBlend.copy(_qIdle).slerp(_qMo, motionFade);
      applyDeltaQuat(humanoid, name, _qBlend);
    } else {
      // additive pose (builtins)
      base(humanoid, name, x + mo.x, y + mo.y, z + mo.z);
    }
  } else {
    base(humanoid, name, x, y, z);
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

const POSE = {
  spine: { x: 0, y: 0, z: 0 },
  chest: { x: 0, y: 0, z: 0 },
  upperChest: { x: 0, y: 0, z: 0 },
  neck: { x: 0, y: 0, z: 0 },
  head: { x: 0, y: 0, z: 0 },
  leftShoulder: { x: 0, y: 0, z: 0.05 },
  rightShoulder: { x: 0, y: 0, z: -0.05 },
  hips: { x: 0, y: 0, z: 0 },
  leftUpperArm: { x: 0, y: 0, z: 1.2 },
  rightUpperArm: { x: 0, y: 0, z: -1.2 },
  leftLowerArm: { x: -0.3, y: 0, z: 0 },
  rightLowerArm: { x: -0.3, y: 0, z: 0 },
  leftHand: { x: -0.2, y: 0, z: 0 },
  rightHand: { x: -0.2, y: 0, z: 0 },
  leftUpperLeg: { x: 0, y: 0, z: 0 },
  rightUpperLeg: { x: 0, y: 0, z: 0 },
  leftLowerLeg: { x: -0.15, y: 0, z: 0 },
  rightLowerLeg: { x: -0.15, y: 0, z: 0 },
} as const;

// bones that updateBody applies via applyMotionOverride
const IDLE_APPLIED = new Set<string>([...Object.keys(POSE), "leftEye", "rightEye"]);

function updateBody(vrm: VRM, dt: number): void {
  if (firstFrame) captureRest(vrm.humanoid);

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

  applyMotionOverride(vrm.humanoid, applyDelta, "spine", POSE.spine.x, POSE.spine.y + breathY, POSE.spine.z + sway);
  applyMotionOverride(vrm.humanoid, applyDelta, "chest", POSE.chest.x, POSE.chest.y, POSE.chest.z + sway * 0.6);
  applyMotionOverride(vrm.humanoid, applyDelta, "upperChest", POSE.upperChest.x, POSE.upperChest.y, POSE.upperChest.z + breath * 0.5);
  applyMotionOverride(vrm.humanoid, applyDelta, "neck", POSE.neck.x + lookPitch * 0.3, POSE.neck.y + lookYaw * 0.3, POSE.neck.z + Math.sin(breathPhase * 0.5) * 0.02);
  applyMotionOverride(vrm.humanoid, applyDelta, "head", POSE.head.x + lookPitch, POSE.head.y + lookYaw, POSE.head.z + Math.sin(breathPhase * 0.4) * 0.02);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftEye", lookPitch * 0.4, lookYaw * 0.3, 0);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightEye", lookPitch * 0.4, lookYaw * 0.3, 0);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftShoulder", POSE.leftShoulder.x, POSE.leftShoulder.y, POSE.leftShoulder.z + armBob * 0.3);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightShoulder", POSE.rightShoulder.x, POSE.rightShoulder.y, POSE.rightShoulder.z - armBob * 0.3);

  applyMotionOverride(vrm.humanoid, applyDelta, "hips", POSE.hips.x + breath * 0.3, POSE.hips.y, POSE.hips.z + weightShift * 0);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftUpperArm", POSE.leftUpperArm.x, POSE.leftUpperArm.y, POSE.leftUpperArm.z + armBob);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightUpperArm", POSE.rightUpperArm.x, POSE.rightUpperArm.y, POSE.rightUpperArm.z - armBob);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftLowerArm", POSE.leftLowerArm.x + Math.sin(breathPhase * 0.9) * 0.05, POSE.leftLowerArm.y, POSE.leftLowerArm.z);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightLowerArm", POSE.rightLowerArm.x + Math.sin(breathPhase * 0.9 + 0.5) * 0.05, POSE.rightLowerArm.y, POSE.rightLowerArm.z);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftHand", POSE.leftHand.x + Math.sin(breathPhase * 1.3) * 0.06, POSE.leftHand.y, POSE.leftHand.z);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightHand", POSE.rightHand.x + Math.sin(breathPhase * 1.3 + 0.4) * 0.06, POSE.rightHand.y, POSE.rightHand.z);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftUpperLeg", POSE.leftUpperLeg.x, POSE.leftUpperLeg.y, POSE.leftUpperLeg.z + weightShift * 0.015);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightUpperLeg", POSE.rightUpperLeg.x, POSE.rightUpperLeg.y, POSE.rightUpperLeg.z - weightShift * 0.015);

  applyMotionOverride(vrm.humanoid, applyDelta, "leftLowerLeg", POSE.leftLowerLeg.x + Math.sin(breathPhase * 0.6) * 0.015, POSE.leftLowerLeg.y, POSE.leftLowerLeg.z);
  applyMotionOverride(vrm.humanoid, applyDelta, "rightLowerLeg", POSE.rightLowerLeg.x + Math.sin(breathPhase * 0.6 + 1) * 0.015, POSE.rightLowerLeg.y, POSE.rightLowerLeg.z);

  const hipsNode = boneNode(vrm.humanoid, "hips");
  if (hipsNode && hipsRestCaptured) {
    hipsNode.position.copy(restHipsPos);
    if (motionHipsPos) {
      hipsNode.position.x += motionHipsPos.x * motionFade;
      hipsNode.position.y += motionHipsPos.y * motionFade;
      hipsNode.position.z += motionHipsPos.z * motionFade;
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
      deltaToQuat(mo, _qMo);
      _qBlend.identity().slerp(_qMo, k);
      applyDeltaQuat(vrm.humanoid, name as VRMHumanBoneName, _qBlend);
    }
  }

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
  // jumps or the baked hips Y bob. Runs for absolute (VRMA) motions.
  if (motionAbsolute && motionFade > 0.001 && groundReady) {
    const y = minFootY();
    if (y !== Infinity) {
      let lift = restGroundY - y;
      if (lift < 1e-5) lift = 0;
      else if (lift > 0.5) lift = 0.5;
      if (lift > 0) {
        const hipsNode = boneNode(vrm.humanoid, "hips");
        if (hipsNode) {
          hipsNode.position.y += lift;
          // Position write marks the subtree dirty; a normal update propagates it.
          vrm.scene.updateMatrixWorld();
        }
      }
    }
  }
}
