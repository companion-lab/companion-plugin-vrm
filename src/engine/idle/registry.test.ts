import { beforeEach, describe, expect, it } from "vitest";
import {
  registerBuiltin,
  registerCustom,
  unregisterCustom,
  clearCustomMotions,
  resolveMotionName,
  getMotion,
  listMotions,
  listCustomMotions,
  listMotionNames,
  isCustomMotion,
  isBuiltinMotionName,
  motionDescription,
  normalizeMotionName,
  BUILTIN_MOTION_DESCRIPTIONS,
  BUILTIN_MOTION_META,
} from "./registry";

const pose = { head: [{ t: 0, v: { x: 0, y: 0, z: 0 } }] };

beforeEach(() => {
  clearCustomMotions();
  // Builtins are normally registered by motion.ts on import; register the
  // canonical set here so the registry tests stand alone.
  registerBuiltin("nod", pose, 1.1);
  registerBuiltin("shake", pose, 1.1);
  registerBuiltin("think", pose, 2.2);
});

describe("normalizeMotionName", () => {
  it("strips case, spaces, underscores and dashes", () => {
    expect(normalizeMotionName("  VRMA_02 ")).toBe("vrma02");
    expect(normalizeMotionName("Big-Wave")).toBe("bigwave");
  });
});

describe("resolveMotionName", () => {
  it("treats 'none' as a valid answer with no clip", () => {
    expect(resolveMotionName("none")).toBe("none");
    expect(resolveMotionName("NONE")).toBe("none");
  });

  it("finds built-ins and customs", () => {
    registerCustom({ name: "wave", pose, duration: 1 });
    expect(resolveMotionName("nod")).toBe("nod");
    expect(resolveMotionName("wave")).toBe("wave");
  });

  it("accepts loose spelling and returns the canonical key", () => {
    expect(resolveMotionName("VRMA_02")).toBeNull();
    registerCustom({ name: "VRMA_02", pose, duration: 2 });
    expect(resolveMotionName("vrma_02")).toBe("VRMA_02");
    expect(resolveMotionName(" vrma-02 ")).toBe("VRMA_02");
  });

  it("returns null for unknown names", () => {
    expect(resolveMotionName("teleport")).toBeNull();
  });
});

describe("builtin vs custom", () => {
  it("classifies each correctly", () => {
    registerCustom({ name: "wave", pose, duration: 1 });
    expect(isBuiltinMotionName("nod")).toBe(true);
    expect(isBuiltinMotionName("wave")).toBe(false);
    expect(isCustomMotion("wave")).toBe(true);
    expect(isCustomMotion("nod")).toBe(false);
  });

  it("isCustomMotion is false for unknown names", () => {
    expect(isCustomMotion("teleport")).toBe(false);
  });
});

describe("motionDescription", () => {
  it("prefers an explicit description", () => {
    expect(motionDescription({ name: "x", pose, duration: 1, description: "waves hello" })).toBe(
      "waves hello",
    );
  });

  it("falls back to the builtin description", () => {
    expect(motionDescription({ name: "nod", pose, duration: 1 })).toBe(
      BUILTIN_MOTION_DESCRIPTIONS.nod,
    );
  });

  it("humanises an unnamed custom clip", () => {
    expect(motionDescription({ name: "VRMA_02", pose, duration: 1 })).toBe(
      "VRMA 02 custom motion clip",
    );
  });

  it("copes with a name made only of separators", () => {
    expect(motionDescription({ name: "___", pose, duration: 1 })).toBe(
      "___ custom motion clip",
    );
  });

  it("describes every registered builtin", () => {
    for (const { name } of BUILTIN_MOTION_META) {
      expect(BUILTIN_MOTION_DESCRIPTIONS[name]).toBeTruthy();
    }
  });
});

describe("listings", () => {
  it("always offers 'none' first", () => {
    expect(listMotionNames()[0]).toBe("none");
  });

  it("includes builtins and customs", () => {
    registerCustom({ name: "wave", pose, duration: 1 });
    const names = listMotionNames();
    expect(names).toEqual(expect.arrayContaining(["none", "nod", "shake", "think", "wave"]));
    expect(listMotions().some((m) => m.name === "wave")).toBe(true);
  });

  it("listCustomMotions excludes builtins", () => {
    registerCustom({ name: "wave", pose, duration: 1 });
    expect(listCustomMotions().map((m) => m.name)).toEqual(["wave"]);
  });
});

describe("registration", () => {
  it("unregisters a single custom motion", () => {
    registerCustom({ name: "wave", pose, duration: 1 });
    unregisterCustom("wave");
    expect(getMotion("wave")).toBeUndefined();
  });

  it("a custom motion overrides a builtin of the same name", () => {
    registerCustom({ name: "nod", pose, duration: 99 });
    expect(getMotion("nod")?.duration).toBe(99);
  });
});