// Cursor-driven head/eye look, blended into the idle pose (idle/animation.ts).
// The canvas never receives pointer events (it sits behind the host
// interaction canvas), so the cursor position is polled through the host
// command cursor_global — window-local CSS coords that are NOT clamped to
// the window, so the look keeps tracking the cursor while it is outside the
// window (saturating at the window-edge angles). Targets are smoothed per
// frame by updateCursorLook, the stand-in for the l2d engine's
// FocusController smoothing.

import { tauriInvoke } from "../vendor/tauri-events";

// How far head+eyes track the cursor at the window edges (rad). The idle
// sway's own ±0.12 yaw rides on top.
const MAX_YAW = 0.5;
const MAX_PITCH = 0.3;

const state = {
  enabled: true,
  targetYaw: 0,
  targetPitch: 0,
  yaw: 0,
  pitch: 0,
};

export function setCursorLookEnabled(enabled: boolean): void {
  state.enabled = enabled;
  if (!enabled) {
    state.targetYaw = 0;
    state.targetPitch = 0;
  }
}

/** Poll the cursor and refresh the look targets; the engine drives the
 *  cadence (a 120ms interval, same as the l2d tracker). */
export function pollCursorLook(): void {
  if (!state.enabled) return;
  void tauriInvoke<[number, number, number, number] | null>("cursor_global")
    .then((cursor) => {
      if (!cursor) {
        // No cursor position available (unsupported platform): face forward.
        state.targetYaw = 0;
        state.targetPitch = 0;
        return;
      }
      const [x, y, w, h] = cursor;
      if (w <= 0 || h <= 0) return;
      // Normalized -1..1 → look angles, clamped so the gaze saturates at the
      // window-edge deflection once the cursor is outside the window (the
      // coords themselves are unclamped — cursor_global extrapolates across
      // displays). Window y grows downward, but the rig's local X euler
      // (YXZ, applied to neck/head/eyes in idle/animation.ts) tilts the face
      // DOWN for positive angles — so pitch negates ny to look toward the
      // cursor. +yaw (Y euler) turns the face toward screen right.
      const nx = Math.max(-1, Math.min(1, (x / w) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, (y / h) * 2 - 1));
      state.targetYaw = nx * MAX_YAW;
      state.targetPitch = -ny * MAX_PITCH;
    })
    .catch(() => undefined);
}

/** Per-frame smoothing toward the targets; returns the deltas the idle pose
 *  adds to its own sway for head, neck, and eyes. */
export function updateCursorLook(dt: number): { yaw: number; pitch: number } {
  const k = 1 - Math.exp(-dt * 8);
  state.yaw += (state.targetYaw - state.yaw) * k;
  state.pitch += (state.targetPitch - state.pitch) * k;
  return { yaw: state.yaw, pitch: state.pitch };
}
