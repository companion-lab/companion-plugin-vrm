import { describe, expect, it } from "vitest";
import { coerceDisplay, DEFAULT_DISPLAY } from "./display";

describe("coerceDisplay", () => {
  it("returns the defaults for null/undefined/malformed payloads", () => {
    expect(coerceDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(coerceDisplay(undefined)).toEqual(DEFAULT_DISPLAY);
    expect(coerceDisplay({ scale: "big", x: true, y: [], tracking: 1 })).toEqual(
      DEFAULT_DISPLAY,
    );
  });

  it("keeps valid fields and fills the missing ones per-field", () => {
    expect(coerceDisplay({ scale: 1.5, y: -40 })).toEqual({
      scale: 1.5,
      x: DEFAULT_DISPLAY.x,
      y: -40,
      tracking: DEFAULT_DISPLAY.tracking,
    });
    expect(coerceDisplay({ tracking: false })).toEqual({
      scale: DEFAULT_DISPLAY.scale,
      x: DEFAULT_DISPLAY.x,
      y: DEFAULT_DISPLAY.y,
      tracking: false,
    });
  });
});
