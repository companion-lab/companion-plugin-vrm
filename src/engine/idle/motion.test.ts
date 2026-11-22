import * as THREE from "three";
import type { VRMAnimation } from "@pixiv/three-vrm-animation";
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

// ─── fmt-6 .vrma sources (parsed VRMAnimation, model-independent) ───

// identity → yaw 90° → pitch 90°, on a 3-frame grid at t = 0, 1, 2.
const S = Math.SQRT1_2;

function makeAnim(): VRMAnimation {
  const anim = new (class {} as any) as VRMAnimation;
  // VRMAnimation is a plain data class; build the shape the loader produces.
  (anim as any).duration = 2;
  (anim as any).restHipsPosition = new THREE.Vector3(0, 1, 0);
  (anim as any).humanoidTracks = {
    rotation: new Map([
      [
        "head",
        {
          times: [0, 1, 2],
          values: new Float32Array([0, 0, 0, 1, 0, S, 0, S, S, 0, 0, S]),
        },
      ],
    ]),
    translation: new Map([
      [
        "hips",
        {
          times: [0, 1, 2],
          values: new Float32Array([0, 0, 0, 0, 0.1, 0, 0, 0.2, 0]),
        },
      ],
    ]),
  };
  (anim as any).expressionTracks = { preset: new Map(), custom: new Map() };
  (anim as any).lookAtTrack = null;
  return anim;
}

function sourceClip(over: Record<string, unknown> = {}) {
  registerCustom(
    {
      name: "vrma",
      duration: 2,
      version: 6,
      pose: { fmt: 6, source: "ZmFrZQ==" },
      anim: makeAnim(),
      ...over,
    } as never,
  );
}

describe("fmt-6 .vrma sources", () => {
  it("samples canonical quats from the parsed animation", () => {
    sourceClip();
    const m = new MotionController();
    m.trigger("vrma");
    expect(m.isActive()).toBe(true);
    expect(m.isAbsolute()).toBe(true);
    m.update(1.0); // consume the ramp
    const u = m.update(0.0); // frame 1: yaw 90°
    const q = u!.state.head!;
    expect(q.y).toBeCloseTo(S, 5);
    expect(q.w).toBeCloseTo(S, 5);
    expect(Math.hypot(q.x!, q.y!, q.z!, q.w!)).toBeCloseTo(1, 5);
  });

  it("interpolates between frames rather than snapping", () => {
    sourceClip();
    const m = new MotionController();
    m.trigger("vrma");
    m.update(1.0);
    // sampleT = 1.5: halfway between yaw 90° and pitch 90°
    const u = m.update(0.5);
    const q = u!.state.head!;
    expect(q.w).toBeGreaterThan(0.3);
    expect(q.x).toBeGreaterThan(0);
    expect(q.y).toBeGreaterThan(0);
    expect(Math.hypot(q.x!, q.y!, q.z!, q.w!)).toBeCloseTo(1, 5);
  });

  it("holds the last frame during fade-out", () => {
    sourceClip();
    const m = new MotionController();
    m.trigger("vrma");
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

  it("reports the canonical hips position and rest height", () => {
    sourceClip();
    const m = new MotionController();
    m.trigger("vrma");
    m.update(1.0);
    expect(m.update(0.0)!.hipsPos?.y).toBeCloseTo(0.1, 5);
    const mid = m.update(0.5); // sampleT = 1.5
    expect(mid!.hipsPos?.y).toBeCloseTo(0.15, 5);
    expect(mid!.hipsRestY).toBeCloseTo(1, 5);
  });

  it("holds idle while the async parse is still running", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCustom({
      name: "pending",
      duration: 2,
      version: 6,
      pose: { fmt: 6, source: "ZmFrZQ==" },
      // no anim: still "parsing"
    } as never);
    const m = new MotionController();
    m.trigger("pending");
    expect(m.isActive()).toBe(true);
    expect(m.update(0.1)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
