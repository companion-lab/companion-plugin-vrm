// Backend access layer for the VRM avatar plugin: typed wrappers over
// ctx.backend.call (the Rust backend's `vrm.*` methods) plus the hooks the
// ported sections need (useVrmaImport) and the stale-bake helpers shared with
// the plugin runtime in index.tsx.

import { useCallback } from "react";
import type { PluginContext } from "../../sdk/js/@companion/plugin";
// Bake format lives with the engine that creates the bakes (idle/registry.ts);
// entries carrying any other version are stale bakes and get deleted on load
// (see fetchFreshLibrary in index.tsx).
import { MOTION_BAKE_VERSION } from "./engine/idle/registry";

export { MOTION_BAKE_VERSION };

// ─── Shapes returned by the Rust backend (features/vrm/backend) ───

export type ModelMeta = {
  id: string;
  name: string;
  size: number;
  is_builtin: boolean;
};

export type MotionSummary = {
  name: string;
  duration: number;
  description: string;
};

/** Stored motion metadata (`vrm.list_motions` / `vrm.save_motion`). */
export type MotionMeta = {
  name: string;
  duration: number;
  pose: unknown;
  /** Serialized as camelCase "hipsPos" by the backend. */
  hipsPos?: unknown;
  version?: number;
  description?: string;
};

export type EmotionMeta = {
  name: string;
  preset: string;
  reset_ms: number;
};

/** Payload of the plugin's "vrma-imported" event (or { error }). */
export type VrmaImportedPayload = {
  error?: string;
  name: string;
  duration: number;
  pose: unknown;
  hipsPos?: unknown;
  expressions: Array<{ preset: string }>;
};

// ─── Shared with the host port of vrm/base64.ts ───

const CHUNK = 0x8000;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─── API ───

/** Typed wrappers over the backend's `vrm.*` methods (the legacy
 *  `library.*` names and bare former tauri command names are aliases on the
 *  Rust side). */
export function makeLibraryApi(ctx: PluginContext) {
  return {
    // Models
    listModels: () => ctx.backend.call<ModelMeta[]>("vrm.list_models"),
    saveModel: (name: string, data_base64: string) =>
      ctx.backend.call<ModelMeta>("vrm.save_model", { name, data_base64 }),
    loadModelData: (id: string) =>
      ctx.backend.call<string>("vrm.load_model", { id }),
    deleteModel: (id: string) => ctx.backend.call("vrm.delete_model", { id }),
    modelThumbnail: (id: string) =>
      ctx.backend.call<string | null>("vrm.model_thumbnail", { id }),
    getActiveModel: () =>
      ctx.backend.call<string | null>("vrm.get_active_model"),
    setActiveModel: (id: string) =>
      ctx.backend.call("vrm.set_active_model", { id }),

    // Motions
    /** Cheap listing: metas WITHOUT the pose payload (`pose` is null) —
     *  the backend scans only each file's head/tail, so a giant bake never
     *  costs a full JSON DOM parse here. Full metas load per-motion. */
    listMotions: () => ctx.backend.call<MotionMeta[]>("vrm.list_motions"),
    /** Full meta including the pose for one motion. Refuses bakes over the
     *  backend's size cap. */
    loadMotion: (name: string) =>
      ctx.backend.call<MotionMeta>("vrm.load_motion", { name }),
    listMotionSummaries: () =>
      ctx.backend.call<MotionSummary[]>("vrm.list_motion_summaries"),
    saveMotion: (meta: MotionMeta) =>
      ctx.backend.call("vrm.save_motion", { meta }),
    deleteMotion: (name: string) =>
      ctx.backend.call("vrm.delete_motion", { name }),
    updateMotionDescription: (name: string, description: string) =>
      ctx.backend.call("vrm.update_motion_description", { name, description }),
    renameMotion: (old_name: string, new_name: string) =>
      ctx.backend.call("vrm.rename_motion", { old_name, new_name }),

    // Emotions
    listEmotions: () => ctx.backend.call<EmotionMeta[]>("vrm.list_emotions"),
    saveEmotion: (meta: EmotionMeta) =>
      ctx.backend.call("vrm.save_emotion", { meta }),
    deleteEmotion: (name: string) =>
      ctx.backend.call("vrm.delete_emotion", { name }),
  };
}

export type LibraryApi = ReturnType<typeof makeLibraryApi>;

// ─── useVrmaImport (port of app/src/ui/hooks/useVrmaImport.ts) ───
//
// The sections emit "vrma-import-request" {name, data}; the plugin runtime in
// the main window parses the clip against the live model, saves it, and
// replies with "vrma-imported" (or {error}).

async function importVrmaFile(
  ctx: PluginContext,
  file: File,
): Promise<VrmaImportedPayload> {
  const data = arrayBufferToBase64(await file.arrayBuffer());
  const name = file.name.replace(/\.\w+$/, "");
  return new Promise<VrmaImportedPayload>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${name}: import timed out`)),
      30000,
    );
    const off = ctx.events.on("vrma-imported", (payload) => {
      clearTimeout(timeout);
      off();
      const p = (payload ?? {}) as VrmaImportedPayload;
      if (p.error) {
        reject(new Error(`${name}: ${p.error}`));
      } else {
        resolve(p);
      }
    });
    ctx.events.emit("vrma-import-request", { name, data });
  });
}

function vrmaFiles(files: FileList | null): File[] {
  return Array.from(files ?? []).filter((f) => /\.vrma$/i.test(f.name));
}

/** Port of the host's importVrmaFile/vrmaFiles helpers, wired to ctx.events. */
export function useVrmaImport(ctx: PluginContext) {
  const importFile = useCallback(
    (file: File) => importVrmaFile(ctx, file),
    [ctx],
  );
  return { importFile, vrmaFiles };
}
