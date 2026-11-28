import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  MAX_PITCH,
  MAX_ROLL,
  MAX_SHIFT_X,
  captureCarryRoot,
  releaseCarryRoot,
  resetCarryLeanForTests,
  setCarryLean,
  updateCarryLean,
} from "./carry-lean";

// Model-root stand-in: the module only touches position, a real Vector3
// satisfies the structural CarryRoot type.
function fakeRoot(x = 0, y = 0, z = 0) {
  return { position: new THREE.Vector3(x, y, z) };
}

const FRAME = 1 / 60;

beforeEach(() => {
  resetCarryLeanForTests();
});

describe("setCarryLean", () => {
  it("clamps the normalized feed to ±1 per axis", () => {
    setCarryLean({ x: 5, y: -9 });
    // Drive one long frame: the smoothing converges toward the clamped target.
    let lean = { roll: 0, pitch: 0 };
    for (let i = 0; i < 120; i++) lean = updateCarryLean(FRAME);
    expect(lean.roll).toBeCloseTo(MAX_ROLL, 5);
    expect(lean.pitch).toBeCloseTo(MAX_PITCH, 5);
  });

  it("null feed (release) settles every channel back to rest", () => {
    setCarryLean({ x: 1, y: 1 });
    for (let i = 0; i < 120; i++) updateCarryLean(FRAME);
    setCarryLean(null);
    let lean = { roll: 1, pitch: 1 };
    for (let i = 0; i < 120; i++) lean = updateCarryLean(FRAME);
    expect(lean.roll).toBeCloseTo(0, 5);
    expect(lean.pitch).toBeCloseTo(0, 5);
  });
});

describe("updateCarryLean", () => {
  it("lags the root opposite the motion around the captured base", () => {
    const root = fakeRoot(0, 0.6, 0);
    captureCarryRoot(root);
    setCarryLean({ x: 1, y: 0 });
    for (let i = 0; i < 120; i++) updateCarryLean(FRAME);
    // Dragging right: root shifts left of base, top tips left (positive roll).
    expect(root.position.x).toBeLessThan(0);
    expect(root.position.x).toBeGreaterThanOrEqual(-MAX_SHIFT_X - 1e-6);
    expect(root.position.y).toBeCloseTo(0.6, 5);
  });

  it("is quiet at rest and with no model attached", () => {
    releaseCarryRoot();
    setCarryLean(null);
    const lean = updateCarryLean(FRAME);
    expect(lean.roll).toBe(0);
    expect(lean.pitch).toBe(0);
  });

  it("keeps the vertical lag on y and the pitch negative for a downward drag", () => {
    const root = fakeRoot(0, 0.6, 0);
    captureCarryRoot(root);
    setCarryLean({ x: 0, y: 1 });
    for (let i = 0; i < 120; i++) updateCarryLean(FRAME);
    // Dragging down: root lags up, body tips up (negative pitch = away from viewer).
    expect(root.position.y).toBeGreaterThan(0.6);
    const lean = updateCarryLean(0); // settled; a zero-dt frame is a pure read
    expect(lean.pitch).toBeLessThanOrEqual(0);
    expect(lean.roll).toBeCloseTo(0, 5);
  });
});
