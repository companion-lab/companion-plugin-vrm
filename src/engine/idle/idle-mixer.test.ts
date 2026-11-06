import { beforeEach, describe, expect, it } from "vitest";
import { registerBuiltin, registerCustom, clearCustomMotions } from "./registry";
import { IdleMixer, loadIdleMixer, saveIdleMixer } from "./idle-mixer";

// Vitest defaults to the node environment, which has no localStorage.
let store: Map<string, string>;
beforeEach(() => {
  store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  clearCustomMotions();
});

describe("idle mixer config", () => {
  it("has sane defaults", () => {
    const d = loadIdleMixer();
    expect(d.enabled).toBe(true);
    expect(d.minSec).toBe(8);
    expect(d.maxSec).toBe(20);
    expect(d.idleMotions).toEqual([]);
  });

  it("sanitizes min/max and the selection on save", () => {
    saveIdleMixer({ enabled: true, minSec: 30, maxSec: 10, idleMotions: [" a ", "a", 1 as never, "b"] });
    const swapped = loadIdleMixer();
    expect(swapped.minSec).toBeLessThanOrEqual(swapped.maxSec);
    expect(swapped.idleMotions).toEqual(["a", "b"]);
  });
});

describe("IdleMixer.tick", () => {
  const m = new IdleMixer();

  it("returns null when nothing is selectable", () => {
    m.setConfig({ enabled: true, minSec: 3, maxSec: 3, idleMotions: [] });
    expect(m.tick(999, { busy: false })).toBeNull();
    expect(m.tick(999, { busy: true })).toBeNull();
  });

  it("picks from the pool without immediate repeats", () => {
    registerCustom({ name: "a", pose: {}, duration: 1 });
    registerCustom({ name: "b", pose: {}, duration: 1 });
    m.setConfig({ enabled: true, minSec: 3, maxSec: 3, idleMotions: ["a", "b"] });
    const first = m.tick(999, { busy: false });
    expect(["a", "b"]).toContain(first);
    const second = m.tick(999, { busy: false });
    expect(["a", "b"]).toContain(second);
    expect(second).not.toBe(first);
  });

  it("ignores unknown names and can use builtins", () => {
    // Registered per-test: beforeEach clears the registry, so relying on a
    // previous test's registration silently yields null.
    registerCustom({ name: "b", pose: {}, duration: 1 });
    registerBuiltin("nod", {}, 1.1);
    m.setConfig({ enabled: true, minSec: 3, maxSec: 3, idleMotions: ["b", "ghost"] });
    expect(m.tick(999, { busy: false })).toBe("b");
    m.setConfig({ enabled: true, minSec: 3, maxSec: 3, idleMotions: ["nod"] });
    expect(m.tick(999, { busy: false })).toBe("nod");
  });

  it("returns null when disabled", () => {
    registerCustom({ name: "a", pose: {}, duration: 1 });
    m.setConfig({ enabled: false, minSec: 3, maxSec: 3, idleMotions: ["a"] });
    expect(m.tick(999, { busy: false })).toBeNull();
  });
});