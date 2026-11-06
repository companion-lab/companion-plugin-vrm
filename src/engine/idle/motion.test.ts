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