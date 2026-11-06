import type { VRMExpressionPresetName } from "@pixiv/three-vrm";

export interface EmotionEntry {
  name: string;
  preset: VRMExpressionPresetName;
  resetMs: number;
}

// Built-in emotions, loaded from controller.ts defaults.
const builtins = new Map<string, EmotionEntry>();

// Custom emotions loaded from user data.
const custom = new Map<string, EmotionEntry>();

export const BUILTIN_EMOTION_META: Array<{ name: string; preset: VRMExpressionPresetName; resetMs: number }> = [
  { name: "neutral", preset: "neutral", resetMs: 4000 },
  { name: "happy", preset: "happy", resetMs: 4000 },
  { name: "sad", preset: "sad", resetMs: 4000 },
  { name: "angry", preset: "angry", resetMs: 4000 },
  { name: "surprised", preset: "surprised", resetMs: 4000 },
  { name: "relaxed", preset: "relaxed", resetMs: 4000 },
];

export function registerBuiltinEmotions(): void {
  for (const { name, preset, resetMs } of BUILTIN_EMOTION_META) {
    builtins.set(name, { name, preset, resetMs });
  }
}

export function registerCustomEmotion(entry: EmotionEntry): void {
  custom.set(entry.name, entry);
}

export function unregisterCustomEmotion(name: string): void {
  custom.delete(name);
}

export function clearCustomEmotions(): void {
  custom.clear();
}

export function normalizeEmotionName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

export function resolveEmotionName(name: string): string | null {
  const direct = custom.get(name) ?? builtins.get(name);
  if (direct) return direct.name;
  const norm = normalizeEmotionName(name);
  for (const key of [...custom.keys(), ...builtins.keys()]) {
    if (normalizeEmotionName(key) === norm) return key;
  }
  return null;
}

export function getEmotion(name: string): EmotionEntry | undefined {
  const key = resolveEmotionName(name);
  if (!key) return undefined;
  return custom.get(key) ?? builtins.get(key);
}

export function listEmotions(): EmotionEntry[] {
  return [...builtins.values(), ...custom.values()];
}

export function listEmotionNames(): string[] {
  return [...builtins.keys(), ...custom.keys()];
}

export function isCustomEmotion(name: string): boolean {
  const key = resolveEmotionName(name);
  return key !== null && custom.has(key);
}
