import { afterEach, describe, expect, it, vi } from "vitest";
import { callWithRetry } from "./retry";

// Constants mirror the private ones in retry.ts (8s call timeout, 500ms
// retry pause); the tests drive them with fake timers.
const CALL_TIMEOUT_MS = 8_000;
const CALL_RETRY_PAUSE_MS = 500;

const quietLog = { warn: () => {} };

afterEach(() => {
  vi.useRealTimers();
});

describe("callWithRetry", () => {
  it("returns the first successful attempt directly", async () => {
    const op = vi.fn(async () => "ok");
    await expect(callWithRetry(op, quietLog, "t")).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries after a timed-out attempt and converges", async () => {
    vi.useFakeTimers();
    // First attempt hangs forever (the macOS lost-invoke case), the retry
    // succeeds — like the avatar boot sequence relies on.
    const op = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>(() => {}))
      .mockImplementationOnce(async () => "ok");
    const warn = vi.fn();

    const promise = callWithRetry(op, { warn }, "test.call");
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + CALL_RETRY_PAUSE_MS);
    await expect(promise).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("test.call: attempt 1 timed out");
  });

  it("surfaces a rejection without retrying", async () => {
    const op = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      callWithRetry(op, quietLog, "test.call"),
    ).rejects.toThrow("boom");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("honors per-call timeout and retry overrides", async () => {
    vi.useFakeTimers();
    const op = vi.fn(() => new Promise<string>(() => {}));
    const warn = vi.fn();
    const promise = callWithRetry(op, { warn }, "test.call", {
      timeoutMs: 100,
      retries: 2,
    });
    // Attach before the timers run so the eventual rejection is never
    // unhandled while runAllTimersAsync advances the clock.
    const expectation = expect(promise).rejects.toThrow("attempt 2 timed out");
    await vi.runAllTimersAsync();
    expect(op).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("test.call: attempt 2 timed out");
    await expectation;
  });
});
