import { beforeEach, describe, expect, it, vi } from "vitest";
import "./motion";
import { registerCustom, clearCustomMotions } from "./registry";
import { MotionController } from "./motion";

beforeEach(() => clearCustomMotions());

/** A clip with linear euler keyframes so assertions can read exact values. */
function clip(over: Partial<Parameters<typeof registerCustom>[0]> = {}) {
  return registerCustom({
    name: "wave",
    duration: 2,
    pose: {
      head: [
        { t: 0, v: { x: 0, y: 0, z: 0 } },
        { t: 1, v: { x: 0, y: 1, z: 0 } },
        { t: 2, v: { x: 0, y: 0, z: 0 } },
      ],
    },
    ...over,
  });
}

describe("trigger", () => {
  it("ignores an empty motion and 'none'", () => {
    const m = new MotionController();
    m.trigger("");
    m.trigger("none");
    expect(m.isActive()).toBe(false);
  });

  it("warns and ignores an unknown motion", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new MotionController();
    m.trigger("teleport");
    expect(m.isActive()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("activates a registered clip", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    expect(m.isActive()).toBe(true);
  });

  it("accepts a loosely spelled name", () => {
    registerCustom({ name: "VRMA_02", pose: {}, duration: 1 });
    const m = new MotionController();
    m.trigger(" vrma-02 ");
    expect(m.isActive()).toBe(true);
  });

  // Asking for the clip that is already playing should restart it, not
  // silently do nothing.
  it("restarts the clip when the same motion is requested again", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    m.update(1.5);
    m.trigger("wave");
    const first = m.update(0.1);
    expect(first?.state.head?.y).toBeLessThan(0.5);
  });

  // A clip deleted from the registry mid-play leaves the controller active
  // until the next tick, which is where it is actually cleared.
  it("stops on the next tick when the clip vanished from the registry", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    expect(m.isActive()).toBe(true);
    clearCustomMotions();
    expect(m.update(0.1)).toBeNull();
    expect(m.isActive()).toBe(false);
  });
});

describe("update", () => {
  it("returns null while idle", () => {
    expect(new MotionController().update(0.016)).toBeNull();
  });

  it("ramps in from rest", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    const early = m.update(0.01);
    expect(early!.fade).toBeLessThan(0.05);
    const later = m.update(0.5);
    expect(later!.fade).toBeGreaterThan(early!.fade);
  });

  it("reaches full blend partway through the clip", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    m.update(1.5);
    expect(m.update(0.1)!.fade).toBe(1);
  });

  it("poses the bones along the clip", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    m.update(1.0);
    const mid = m.update(0.01);
    expect(mid!.state.head).toBeDefined();
    expect(mid!.state.head!.y).toBeGreaterThan(0.5);
  });

  // A one-shot clip holds its last pose through the fade-out instead of
  // snapping back to rest the moment it ends.
  it("holds the final pose while fading out", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    while (m.isActive()) {
      const u = m.update(0.5);
      if (u && u.fade < 1 && u.fade > 0) {
        expect(u.state.head).toBeDefined();
      }
    }
    expect(m.isActive()).toBe(false);
  });

  it("retires after the clip duration plus the fade", () => {
    clip({ duration: 0.1 });
    const m = new MotionController();
    m.trigger("wave");
    for (let i = 0; i < 50 && m.isActive(); i++) m.update(0.1);
    expect(m.isActive()).toBe(false);
  });

  it("stops cleanly if the clip is removed mid-play", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    clearCustomMotions();
    expect(m.update(0.1)).toBeNull();
    expect(m.isActive()).toBe(false);
  });

  it("reports hips position when the clip has one", () => {
    clip({ hipsPos: [{ t: 0, v: { x: 0, y: 0, z: 0.1 } }] });
    const m = new MotionController();
    m.trigger("wave");
    const u = m.update(0.5);
    expect(u!.hipsPos).toBeDefined();
  });

  it("omits hips position when the clip has none", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    expect(m.update(0.5)!.hipsPos).toBeUndefined();
  });

  // Imported clips carry absolute root motion, which must not be added on top
  // of the idle pose or the character drifts off its ground plane.
  it("marks an imported clip as absolute", () => {
    clip();
    const m = new MotionController();
    m.trigger("wave");
    expect(m.isAbsolute()).toBe(true);
  });

  it("does not mark a built-in clip as absolute", () => {
    const m = new MotionController();
    m.trigger("nod");
    expect(m.isAbsolute()).toBe(false);
    m.update(0.5);
  });
});

describe("quaternion keyframes", () => {
  it("interpolates between rotations rather than component-wise", () => {
    registerCustom({
      name: "spin",
      duration: 2,
      pose: {
        head: [
          { t: 0, v: { x: 0, y: 0, z: 0, w: 1 } },
          { t: 2, v: { x: 0, y: 0, z: 0, w: 1 } },
        ],
      },
    });
    const m = new MotionController();
    m.trigger("spin");
    const u = m.update(1.0);
    const q = u!.state.head!;
    expect(q.w).toBeDefined();
    // Unit length must be preserved through slerp.
    expect(Math.hypot(q.x!, q.y!, q.z!, q.w!)).toBeCloseTo(1, 5);
  });
});

// ─── v4 baked tracks (base64 Float32 blobs, decoded in registry.ts) ───

/** Encode floats the way vrma-loader.ts does (base64 of the f32 bytes). */
function f32b64(nums: number[]): string {
  const bytes = new Uint8Array(new Float32Array(nums).buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// identity → yaw 90° → pitch 90°, on a 3-frame grid at t = 0, 1, 2.
const S = Math.SQRT1_2;
const V4_TRACK = {
  fmt: 4 as const,
  times: f32b64([0, 1, 2]),
  bones: {
    head: f32b64([0, 0, 0, 1, 0, S, 0, S, S, 0, 0, S]),
  },
  hipsPos: f32b64([0, 0, 0, 0, 0.1, 0, 0, 0.2, 0]),
};

function v4clip() {
  registerCustom({ name: "v4spin", duration: 2, version: 4, pose: V4_TRACK });
}

describe("v4 baked tracks", () => {
  it("registers and activates a v4 bake", () => {
    v4clip();
    const m = new MotionController();
    m.trigger("v4spin");
    expect(m.isActive()).toBe(true);
    expect(m.isAbsolute()).toBe(true);
  });

  it("holds the first frame at t=0", () => {
    v4clip();
    const m = new MotionController();
    m.trigger("v4spin");
    const u = m.update(0);
    // the raw sampled delta is the first frame quat (identity), whatever
    // the ramp weight happens to be
    const q = u!.state.head!;
    expect(q.x).toBeCloseTo(0, 5);
    expect(q.y).toBeCloseTo(0, 5);
    expect(q.z).toBeCloseTo(0, 5);
    expect(q.w).toBeCloseTo(1, 5);
  });

  it("samples the quats along the track at full blend", () => {
    v4clip();
    const m = new MotionController();
    m.trigger("v4spin");
    m.update(1.0); // consume the ramp
    const u = m.update(0.0); // sampleT lands exactly on frame 1 (yaw 90°)
    const q = u!.state.head!;
    expect(q.y).toBeCloseTo(S, 5);
    expect(q.w).toBeCloseTo(S, 5);
    // Unit length preserved through the typed-array slerp.
    expect(Math.hypot(q.x!, q.y!, q.z!, q.w!)).toBeCloseTo(1, 5);
  });

  it("interpolates between frames rather than snapping", () => {
    v4clip();
    const m = new MotionController();
    m.trigger("v4spin");
    m.update(1.0);
    // sampleT = 1.5: halfway between yaw 90° and pitch 90°
    const u = m.update(0.5);
    const q = u!.state.head!;
    expect(q.w).toBeGreaterThan(0.3);
    expect(q.x).toBeGreaterThan(0);
    expect(q.y).toBeGreaterThan(0);
    // still a rotation, not a component lerp artifact
    expect(Math.hypot(q.x!, q.y!, q.z!, q.w!)).toBeCloseTo(1, 5);
  });

  it("holds the last frame during fade-out", () => {
    v4clip();
    const m = new MotionController();
    m.trigger("v4spin");
    // Fade is <1 through the ramp-in too; the LAST fade sample is always
    // past the clip end, where sampleT clamps to the final frame.
    const fadeSamples: Array<{ x: number; y: number; z: number; w?: number }> = [];
    while (m.isActive()) {
      const u = m.update(0.6);
      if (u && u.fade < 1 && u.fade > 0) fadeSamples.push(u.state.head!);
    }
    expect(fadeSamples.length).toBeGreaterThan(0);
    const q = fadeSamples[fadeSamples.length - 1]!;
    // frame 2 is pitch 90°
    expect(q.x).toBeCloseTo(S, 5);
    expect(q.w).toBeCloseTo(S, 5);
    expect(m.isActive()).toBe(false);
  });

  it("reports hips position along the track", () => {
    v4clip();
    const m = new MotionController();
    m.trigger("v4spin");
    m.update(1.0);
    expect(m.update(0.0)!.hipsPos?.y).toBeCloseTo(0.1, 5);
    const mid = m.update(0.5); // sampleT = 1.5
    expect(mid!.hipsPos?.y).toBeCloseTo(0.15, 5);
  });

  it("rejects a corrupt v4 blob instead of registering garbage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCustom({
      name: "broken",
      duration: 2,
      version: 4,
      pose: { fmt: 4, times: f32b64([0, 1, 2]), bones: { head: f32b64([0, 0, 0, 1]) } },
    });
    const m = new MotionController();
    m.trigger("broken");
    expect(m.isActive()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});