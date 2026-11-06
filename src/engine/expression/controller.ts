import type { VRM, VRMExpressionPresetName } from "@pixiv/three-vrm";
import {
  registerBuiltinEmotions,
  getEmotion,
  resolveEmotionName,
  listEmotionNames,
} from "./registry";

// Re-export for consumers that need the type / list
export type Emotion = "neutral" | "happy" | "sad" | "angry" | "surprised" | "relaxed";
export const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "sad", "angry", "surprised", "relaxed"];

// Register built-in emotions on module load
registerBuiltinEmotions();

// How long an emotion set by the LLM sticks before reverting to neutral.
const RESET_AFTER_MS = 4000;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class ExpressionController {
  private current: string = "neutral";
  private target: string = "neutral";
  private t = 1;
  private duration = 0.3;
  private vrm: VRM | null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(vrm: VRM | null) {
    this.vrm = vrm;
  }

  setVrm(vrm: VRM | null) {
    this.vrm = vrm;
    this.current = "neutral";
    this.target = "neutral";
    this.t = 1;
  }

  getEmotion(): string {
    return this.target;
  }

  setEmotion(next: string, lerpMs = 300) {
    const key = resolveEmotionName(next) ?? "neutral";
    if (key === this.target) return;
    this.target = key;
    this.duration = lerpMs / 1000;
    this.t = 0;
    this.scheduleReset();
  }

  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    if (this.target === "neutral") return;
    const entry = getEmotion(this.target);
    const resetMs = entry?.resetMs ?? RESET_AFTER_MS;
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.target = "neutral";
      this.duration = 0.5;
      this.t = 0;
    }, resetMs);
  }

  update(_dt: number) {
    if (!this.vrm) return;
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + _dt / this.duration);
    const k = easeInOut(this.t);
    const fromEntry = getEmotion(this.current);
    const toEntry = getEmotion(this.target);
    const from = fromEntry?.preset as VRMExpressionPresetName | undefined;
    const to = toEntry?.preset as VRMExpressionPresetName | undefined;
    const expr = this.vrm.expressionManager;
    if (!expr) return;

    const allPresets = new Set<string>();
    if (from) allPresets.add(from);
    if (to) allPresets.add(to);

    for (const name of allPresets) {
      const isFrom = name === from;
      const isTo = name === to;
      const weight = (isFrom ? 1 - k : 0) + (isTo ? k : 0);
      expr.setValue(name as VRMExpressionPresetName, weight);
    }
    if (this.t >= 1) {
      this.current = this.target;
      if (this.current !== "neutral" && !this.resetTimer) {
        this.scheduleReset();
      }
    }
  }
}

export function getAllEmotionNames(): string[] {
  return listEmotionNames();
}
