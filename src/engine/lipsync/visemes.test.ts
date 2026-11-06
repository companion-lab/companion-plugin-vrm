import { describe, expect, it } from "vitest";
import { VISEMES } from "./visemes";

// The viseme set drives which mouth blend shapes lip sync can reach. Adding a
// name here without a matching shape in the controller would silently do
// nothing, so the list is pinned.
describe("VISEMES", () => {
  it("exposes the five supported mouth shapes", () => {
    expect([...VISEMES]).toEqual(["aa", "ih", "ou", "ee", "oh"]);
  });
});