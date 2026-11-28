// Carry reaction: the character hangs on while its window is carried. The
// host's drag-react (app/src/ui/drag-react.ts) measures drag velocity from
// the window-move events and streams normalized lean targets through the
// avatar bus (setCarry, +x = screen right, +y = screen down); this module
// smooths them per frame exactly like cursor-look smooths gaze targets, and
// the idle pose adds the lean to hips/spine/chest (idle/animation.ts) while
// the model ROOT shifts opposite the motion.
//
// The root shift is what sells the effect: three-vrm's spring-bone simulation
// reacts to world-space bone movement, so hair, skirt, and ribbons swing as
// if the character were really being carried. With no feed (release, or no
// drag at all) the targets decay to zero and the character just stands.

import type { Vector3 } from "three";

// Lean magnitudes. The roll distributes over hips/spine/chest/upperChest
// (weights in idle/animation.ts sum to ~1.2, so max body tip ≈ 11°); the
// pitch (falling forward/back) is smaller — sideways sway reads as "carried",
// too much pitch reads as "bowing". Exported as the tuning knobs.
export const MAX_ROLL = 0.16;
export const MAX_PITCH = 0.1;
// Root lag opposite the motion, model-space meters (stage-local axes are
// unrotated: +x = screen right, +y = UP — note screen y is down, so the
// stage's y already mirrors the drag feed's y). A few centimeters — enough
// for the spring bones to notice, too small to look like the character
// teleports.
export const MAX_SHIFT_X = 0.05;
export const MAX_SHIFT_Y = 0.04;

// Per-frame follow rate for the exponential smoothing (per second); the
// release uses a slower rate so the settle reads as a spring, not a snap.
const FOLLOW_RATE = 10;
const SETTLE_RATE = 6;

const state = {
  targetX: 0,
  targetY: 0,
  roll: 0,
  pitch: 0,
  shiftX: 0,
  shiftY: 0,
  root: null as CarryRoot | null,
  baseX: 0,
  baseY: 0,
  baseZ: 0,
};

export type CarryLean = { roll: number; pitch: number };

/** The module only ever moves the root's position — the minimal structural
 *  type keeps the test fake honest (a full Object3D would be over-coupling). */
export type CarryRoot = { position: Vector3 };

/** Feed a normalized lean target from the host drag (null = released). The
 *  engine smooths from here; this only ever writes numbers, so a feed arriving
 *  before any model is attached is harmless. */
export function setCarryLean(lean: { x: number; y: number } | null): void {
  if (!lean) {
    state.targetX = 0;
    state.targetY = 0;
    return;
  }
  state.targetX = Math.max(-1, Math.min(1, lean.x));
  state.targetY = Math.max(-1, Math.min(1, lean.y));
}

/** Capture the model root and its rest position at attach (the engine's
 *  attachVrmTo has just placed it, y lifted to 0.6). The lag offset is
 *  applied around this base, so display settings and the lift stay intact. */
export function captureCarryRoot(root: CarryRoot): void {
  state.root = root;
  state.baseX = root.position.x;
  state.baseY = root.position.y;
  state.baseZ = root.position.z;
}

/** Drop the root reference (engine stop / model dispose). */
export function releaseCarryRoot(): void {
  state.root = null;
}

/** Test helper: back to rest (targets, channels, root). */
export function resetCarryLeanForTests(): void {
  state.targetX = 0;
  state.targetY = 0;
  state.roll = 0;
  state.pitch = 0;
  state.shiftX = 0;
  state.shiftY = 0;
  state.root = null;
}

/** Per-frame smoothing; applies the root lag and returns the body lean the
 *  idle pose distributes over hips/spine/chest. Signs: dragging right (+x)
 *  rolls the body's top toward screen-left and shifts the root left — the
 *  inertia lag of something being carried; dragging down (+y, screen down)
 *  tips the top up (away from the viewer, negative pitch) and shifts the
 *  root UP in stage space (+y is up there), the same lag on the other axis. */
export function updateCarryLean(dt: number): CarryLean {
  const released = state.targetX === 0 && state.targetY === 0;
  const rate = released ? SETTLE_RATE : FOLLOW_RATE;
  const k = 1 - Math.exp(-dt * rate);
  const rollTarget = state.targetX * MAX_ROLL;
  const pitchTarget = -state.targetY * MAX_PITCH;
  const shiftXTarget = -state.targetX * MAX_SHIFT_X;
  const shiftYTarget = state.targetY * MAX_SHIFT_Y;
  state.roll += (rollTarget - state.roll) * k;
  state.pitch += (pitchTarget - state.pitch) * k;
  state.shiftX += (shiftXTarget - state.shiftX) * k;
  state.shiftY += (shiftYTarget - state.shiftY) * k;
  if (state.root) {
    state.root.position.set(
      state.baseX + state.shiftX,
      state.baseY + state.shiftY,
      state.baseZ,
    );
  }
  return { roll: state.roll, pitch: state.pitch };
}
