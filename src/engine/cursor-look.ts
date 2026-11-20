// Cursor-driven head/eye look, blended into the idle pose (idle/animation.ts).
// The canvas never receives pointer events (it sits behind the host
// interaction canvas), so the cursor position is polled through the host
// command cursor_global — window-local CSS coords that are NOT clamped to
// the window, so the look keeps tracking the cursor while it is outside the
// window (saturating at the window-edge angles). A host that predates
// cursor_global still has the click-through probe (cursor_window_local,
// clamped to the window), so a rejected invoke falls back to that command.
// If BOTH reject — an app build without the cursor probes, e.g. an older
// release — the look degrades to document-level pointermove events (see
// ensurePointerFallback): while the window takes events (it does whenever
// click-through isn't ignoring the cursor), clientX/Y are the same
// window-local CSS coords, and events stop once click-through engages, so
// the probe path stays the primary source wherever it exists. Targets are
// smoothed per frame by updateCursorLook, the stand-in for the l2d engine's
// FocusController smoothing.

import { tauriInvoke } from "../vendor/tauri-events";

// How far head+eyes track the cursor at the window edges (rad). The idle
// sway's own ±0.12 yaw rides on top.
const MAX_YAW = 0.5;
const MAX_PITCH = 0.3;

// A DOM pointermove within this window means the fallback is driving the
// look: probe-null results (unsupported platform, or the clamped fallback
// reporting "cursor outside the window") must not zero targets it just fed.
const POINTER_FALLBACK_TTL_MS = 500;

const state = {
  enabled: true,
  targetYaw: 0,
  targetPitch: 0,
  yaw: 0,
  pitch: 0,
  lastPointerAt: 0,
  probesUnavailable: false,
  fallbackInstalled: false,
};

export function setCursorLookEnabled(enabled: boolean): void {
  state.enabled = enabled;
  if (!enabled) {
    state.targetYaw = 0;
    state.targetPitch = 0;
  }
}

/** Normalized -1..1 → look angles, clamped so the gaze saturates at the
 *  window-edge deflection once the cursor is outside the window (the coords
 *  themselves may be unclamped — cursor_global extrapolates across
 *  displays). Window y grows downward, but the rig's local X euler (YXZ,
 *  applied to neck/head/eyes in idle/animation.ts) tilts the face DOWN for
 *  positive angles — so pitch negates ny to look toward the cursor. +yaw
 *  (Y euler) turns the face toward screen right. Shared by the probe path
 *  and the DOM fallback. */
function setTargetsFromLocal(x: number, y: number, w: number, h: number): void {
  const nx = Math.max(-1, Math.min(1, (x / w) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, (y / h) * 2 - 1));
  state.targetYaw = nx * MAX_YAW;
  state.targetPitch = -ny * MAX_PITCH;
}

/** Poll the cursor and refresh the look targets; the engine drives the
 *  cadence (a 120ms interval, same as the l2d tracker). */
export function pollCursorLook(): void {
  if (!state.enabled) return;
  ensurePointerFallback();
  void tauriInvoke<[number, number, number, number] | null>("cursor_global")
    .catch(() =>
      tauriInvoke<[number, number, number, number] | null>("cursor_window_local"),
    )
    .then((cursor) => {
      if (!cursor) {
        // null means "no cursor position available": an unsupported platform
        // (native Wayland exposes no global cursor), or the clamped fallback
        // reporting "outside the window". Face forward — unless the DOM
        // fallback has been feeding targets just now, which means it owns
        // the look and zeroing would fight it.
        if (Date.now() - state.lastPointerAt > POINTER_FALLBACK_TTL_MS) {
          state.targetYaw = 0;
          state.targetPitch = 0;
        }
        return;
      }
      const [x, y, w, h] = cursor;
      if (w <= 0 || h <= 0) return;
      setTargetsFromLocal(x, y, w, h);
    })
    .catch(() => {
      // Both probes rejected (host build predates them): report once, not
      // every 120ms — the DOM fallback keeps the look tracking meanwhile.
      if (!state.probesUnavailable) {
        state.probesUnavailable = true;
        console.warn(
          "[vrm] cursor probe commands missing on this host — cursor look follows DOM pointermove only (while the window takes events)",
        );
      }
    });
}

/** Document-level pointermove fallback (capture phase: the host interaction
 *  canvas on top can't starve a document-level listener). Runs alongside the
 *  probe path — duplicate target feeds are harmless (updateCursorLook
 *  smooths both) and this is what keeps the look alive on hosts without the
 *  probe commands. Module-lifetime like the state itself: the enabled gate
 *  is enough, engine remounts just keep writing to it. */
function ensurePointerFallback(): void {
  if (state.fallbackInstalled || typeof document === "undefined") return;
  state.fallbackInstalled = true;
  document.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!state.enabled) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w <= 0 || h <= 0) return;
      state.lastPointerAt = Date.now();
      setTargetsFromLocal(e.clientX, e.clientY, w, h);
    },
    true,
  );
}

/** Per-frame smoothing toward the targets; returns the deltas the idle pose
 *  adds to its own sway for head, neck, and eyes. */
export function updateCursorLook(dt: number): { yaw: number; pitch: number } {
  const k = 1 - Math.exp(-dt * 8);
  state.yaw += (state.targetYaw - state.yaw) * k;
  state.pitch += (state.targetPitch - state.pitch) * k;
  return { yaw: state.yaw, pitch: state.pitch };
}
