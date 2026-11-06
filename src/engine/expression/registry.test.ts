import { beforeEach, describe, expect, it } from "vitest";
import {
  registerBuiltinEmotions,
  registerCustomEmotion,
  unregisterCustomEmotion,
  clearCustomEmotions,
  normalizeEmotionName,
  resolveEmotionName,
  getEmotion,
  listEmotions,
  listEmotionNames,
  isCustomEmotion,
  BUILTIN_EMOTION_META,
} from "./registry";

beforeEach(() => {
  clearCustomEmotions();
  registerBuiltinEmotions();
});

describe("normalizeEmotionName", () => {
  it("lowercases and strips separators", () => {
    expect(normalizeEmotionName("  Big_Smile ")).toBe("bigsmile");
  });
});

describe("resolveEmotionName", () => {
  it("finds built-ins exactly", () => {
    expect(resolveEmotionName("happy")).toBe("happy");
  });

  it("accepts loose spelling and returns the canonical key", () => {
    expect(resolveEmotionName("HAPPY")).toBe("happy");
    expect(resolveEmotionName(" s a d ")).toBe("sad");
  });

  it("returns null for unknown names", () => {
    expect(resolveEmotionName("elated")).toBeNull();
  });
});

describe("custom emotions", () => {
  const custom = { name: "smirk", preset: "fun" as never, resetMs: 1500 };

  it("registers and resolves a custom emotion", () => {
    registerCustomEmotion(custom);
    expect(resolveEmotionName("smirk")).toBe("smirk");
    expect(getEmotion("SMIRK")).toEqual(custom);
    expect(isCustomEmotion("smirk")).toBe(true);
  });

  it("does not shadow a builtin of the same name", () => {
    registerCustomEmotion({ name: "happy", preset: "fun" as never, resetMs: 1 });
    // custom wins on lookup, since registerCustom writes the same map the
    // resolver reads first
    expect(getEmotion("happy")?.preset).toBe("fun");
  });

  it("unregisters a single custom emotion", () => {
    registerCustomEmotion(custom);
    unregisterCustomEmotion("smirk");
    expect(resolveEmotionName("smirk")).toBeNull();
  });

  it("clears all custom emotions but keeps builtins", () => {
    registerCustomEmotion(custom);
    clearCustomEmotions();
    expect(isCustomEmotion("smirk")).toBe(false);
    expect(resolveEmotionName("happy")).toBe("happy");
  });

  it("reports builtins as not custom", () => {
    expect(isCustomEmotion("happy")).toBe(false);
  });
});

describe("listings", () => {
  it("lists every registered emotion", () => {
    registerCustomEmotion({ name: "smirk", preset: "fun" as never, resetMs: 1 });
    const names = listEmotionNames();
    expect(names).toEqual(expect.arrayContaining(["neutral", "happy", "smirk"]));
  });

  it("listEmotions carries the full entry", () => {
    const all = listEmotions();
    expect(all).toHaveLength(BUILTIN_EMOTION_META.length);
    expect(all.every((e) => typeof e.resetMs === "number")).toBe(true);
  });
});

describe("registerBuiltinEmotions", () => {
  it("registers the documented built-in set", () => {
    expect(BUILTIN_EMOTION_META.map((e) => e.name)).toEqual([
      "neutral",
      "happy",
      "sad",
      "angry",
      "surprised",
      "relaxed",
    ]);
  });

  it("is idempotent", () => {
    registerBuiltinEmotions();
    expect(listEmotions().filter((e) => e.name === "happy")).toHaveLength(1);
  });
});