// VRM avatar feature plugin: settings sections for the custom avatar library
// (models / motions / emotions) plus the runtime that feeds the live avatar
// from the plugin backend.
//
// The plugin activates in BOTH windows. Settings-window work is the three
// sections; the avatar-driving runtime below is safe in both windows —
// ctx.avatar calls no-op (or queue, for register*) outside the main window,
// and only the .vrma import responder is gated to the main window, because a
// second responder would race the real one with an error reply.

import { useEffect, useRef, useState } from "react";
import { definePlugin, type PluginContext } from "@companion-lab/plugin";
import {
  MOTION_BAKE_VERSION,
  makeLibraryApi,
  type LibraryApi,
  type MotionMeta,
} from "./backend";
import { callWithRetry } from "./retry";
import { currentWindowLabel } from "./vendor/tauri-events";
import { ModelsSection } from "./ModelsSection";
import { MotionsSection } from "./MotionsSection";
import { EmotionsSection } from "./EmotionsSection";
import { DisplaySection } from "./DisplaySection";
import { GraphicsSection } from "./PerfSection";
import { IdleMixerSection } from "./IdleMixerSection";
import {
  onEngineError,
  startAvatarEngine,
  stopAvatarEngine,
} from "./engine/engine";

/** True in the settings webview ("settings" label; loads settings.html).
 *  Used to keep a second .vrma responder from racing the main window's,
 *  whose "avatar is not available in this window" rejection would otherwise
 *  answer the importer first. Falls back to the page path if the Tauri
 *  window metadata is unavailable. */
function isSettingsWindow(): boolean {
  const label = currentWindowLabel();
  if (label) return label !== "main";
  return (
    typeof location !== "undefined" &&
    location.pathname.endsWith("/settings.html")
  );
}

type LibrarySets = {
  motions: Array<{
    name: string;
    pose: unknown;
    duration: number;
    hipsPos?: unknown;
    version?: number;
    description?: string;
  }>;
  emotions: Array<{ name: string; preset: string; resetMs: number }>;
};

/**
 * Fetch the stored library and apply the host App.tsx reloadCustomLibrary
 * logic: drop (delete) motion bakes whose version doesn't match the current
 * bake format, backfill missing descriptions, and map emotion reset_ms to
 * the resetMs field the avatar surface expects.
 */
async function fetchFreshLibrary(
  ctx: PluginContext,
  api: LibraryApi,
): Promise<LibrarySets | null> {
  try {
    // Reads retry (retry.ts): this runs at activation, inside the macOS
    // lost-invoke window — a lost list call here would silently strip the
    // custom motions/emotions from the live avatar after a re-enable.
    const stored = await callWithRetry(
      () => api.listMotions(),
      ctx.log,
      "vrm.list_motions",
    );
    const motions: LibrarySets["motions"] = [];
    for (const m of stored as MotionMeta[]) {
      if (m.version !== MOTION_BAKE_VERSION) {
        ctx.log.warn(
          `Skipping stale motion bake "${m.name}" (v${m.version ?? "?"}, current v${MOTION_BAKE_VERSION}); re-import the .vrma`,
        );
        try {
          await api.deleteMotion(m.name);
        } catch {
          /* ignore */
        }
        continue;
      }
      const description = m.description?.trim()
        ? m.description
        : `${m.name.replace(/[_-]+/g, " ").trim()} custom motion clip`;
      if (!m.description?.trim()) {
        void api.updateMotionDescription(m.name, description).catch(() => {});
      }
      // Pose loads per-motion: list_motions no longer ships pose payloads,
      // so one pathological bake can't stall activation (a full JSON DOM
      // parse of a giant bake used to starve the whole app at startup).
      try {
        const full = await callWithRetry(
          () => api.loadMotion(m.name),
          ctx.log,
          "vrm.load_motion",
        );
        motions.push({
          name: m.name,
          pose: full.pose,
          duration: full.duration,
          hipsPos: full.hipsPos,
          version: full.version,
          description,
        });
      } catch (e) {
        ctx.log.warn(
          `Skipping motion "${m.name}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const storedEmotions = await callWithRetry(
      () => api.listEmotions(),
      ctx.log,
      "vrm.list_emotions",
    );
    const emotions = storedEmotions.map((e) => ({
      name: e.name,
      preset: e.preset,
      resetMs: typeof e.reset_ms === "number" ? e.reset_ms : 4000,
    }));
    return { motions, emotions };
  } catch (e) {
    ctx.log.error(
      `library reload failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

export default definePlugin((ctx: PluginContext) => {
  ctx.log.info("activating vrm plugin");

  // ── Main-window runtime ──
  // The backdrop canvas widget only exists in the main window's layout, so
  // the avatar engine starts (and stops) with its mount. The canvas is a
  // non-interactive pixel layer behind the core interaction canvas; the
  // engine answers the host's ctx.avatar bus and click-through probes.
  ctx.main.registerWidget({
    slot: "main.backdrop",
    component: function AvatarCanvas() {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        startAvatarEngine(ctx, canvas);
        return () => stopAvatarEngine();
      }, []);
      return (
        <canvas
          ref={canvasRef}
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      );
    },
  });

  // Engine / model-load failures surface here (the host's App.tsx used to
  // own this; the state now lives where the failure happens).
  ctx.main.registerWidget({
    slot: "main.overlay",
    component: function AvatarEngineError() {
      const [message, setMessage] = useState<string | null>(null);
      useEffect(() => onEngineError(setMessage), []);
      const { ErrorOverlay } = ctx.ui;
      if (!message) return null;
      return <ErrorOverlay message={message} />;
    },
  });

  // ── Settings contributions ──
  // Same tab ids/labels/order the core registered (icons copied from
  // app/src/plugins/builtin.tsx). Tab registration is first-wins in the
  // host, so this is a no-op while the core tab exists and a drop-in
  // replacement when it doesn't.
  ctx.settings.registerTab({
    id: "model",
    label: "Model",
    group: "Avatar",
    order: 20,
    desc: "Active VRM avatar, uploaded models, and display.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 12l10 5 10-5" /><path d="M2 17l10 5 10-5" /></svg>
    ),
  });
  ctx.settings.registerTab({
    id: "motion",
    label: "Motion & Emotion",
    group: "Avatar",
    order: 30,
    desc: "Animations, expressions, and .vrma imports.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
    ),
  });
  // Graphics (the former core Performance tab): same tab/section ids the core
  // used so the override contract holds; icon copied from the host's
  // builtin.tsx performance entry.
  ctx.settings.registerTab({
    id: "performance",
    label: "Graphics",
    group: "Avatar",
    order: 40,
    desc: "Render resolution, frame cap, and antialiasing.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
    ),
  });

  // Section ids keep the core contract ("motion.idleMixer" now lives here
  // with the engine it configures). Same order band (100) as the core
  // sections; ties render in registration order, so idle mixer → motions →
  // emotions matches the order the host rendered them in.
  ctx.settings.registerSection({
    id: "model.models",
    tabId: "model",
    slot: "top",
    order: 100,
    component: function LibraryModelsSection() {
      return <ModelsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "model.display",
    tabId: "model",
    slot: "top",
    order: 100,
    component: function LibraryDisplaySection() {
      return <DisplaySection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "motion.idleMixer",
    tabId: "motion",
    slot: "top",
    order: 100,
    component: function LibraryIdleMixerSection() {
      return <IdleMixerSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "motion.motions",
    tabId: "motion",
    slot: "top",
    order: 100,
    component: function LibraryMotionsSection() {
      return <MotionsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "motion.emotions",
    tabId: "motion",
    slot: "top",
    order: 100,
    component: function LibraryEmotionsSection() {
      return <EmotionsSection ctx={ctx} />;
    },
  });
  // Same section id the core registered (override contract); the component
  // pulls perf state from the shared settings-page context (see PerfSection).
  ctx.settings.registerSection({
    id: "performance.performance",
    tabId: "performance",
    slot: "top",
    order: 100,
    component: function VrmGraphicsSection() {
      return <GraphicsSection ctx={ctx} />;
    },
  });

  // ── Runtime: keep the live avatar's custom library in sync ──
  const api = makeLibraryApi(ctx);

  const pushLibrary = async (mode: "register" | "reload"): Promise<void> => {
    const lib = await fetchFreshLibrary(ctx, api);
    if (!lib) return;
    if (mode === "reload") {
      // Live replacement: the bus handler clears customs and registers the
      // fetched sets (main window; no-op elsewhere).
      ctx.avatar.reloadLibrary(lib.motions, lib.emotions);
      return;
    }
    // On activation the main window's avatar handlers may not be installed
    // yet (plugins activate before the first render). registerMotion/
    // registerEmotion are queued by the bus and replayed on install, while a
    // bare reloadLibrary call landing early would be silently dropped — so
    // activation registers entry-by-entry. Safe no-op/queue in the settings
    // window.
    for (const m of lib.motions) ctx.avatar.registerMotion(m);
    for (const e of lib.emotions) ctx.avatar.registerEmotion(e);
  };

  void pushLibrary("register");

  // ModelsSection: the active model changed → load it through the bus.
  ctx.events.on("model-changed", (payload) => {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) return;
    ctx.avatar.loadModel({ id }).catch((e) => {
      ctx.log.warn(`model load failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  // Sections' Test buttons.
  ctx.events.on("motion-test", (name) => {
    if (typeof name === "string" && name) ctx.avatar.triggerMotion(name);
  });
  ctx.events.on("expression-test", (name) => {
    if (typeof name === "string" && name) ctx.avatar.setEmotion(name);
  });

  // Sections emit this after any motion/emotion save/delete.
  ctx.events.on("motion-library-changed", () => {
    void pushLibrary("reload");
  });

  // .vrma imports: parse against the live model, persist, answer the
  // importer, then refresh the registered library. Main window only — see
  // isSettingsWindow above.
  if (!isSettingsWindow()) {
    ctx.events.on("vrma-import-request", (payload) => {
      void (async () => {
        const p = (payload ?? {}) as { name?: unknown; data?: unknown };
        try {
          if (typeof p.name !== "string" || typeof p.data !== "string") {
            throw new Error("malformed vrma-import-request");
          }
          const result = await ctx.avatar.loadVrmaBase64(p.data, p.name);
          const description = `${result.name.replace(/[_-]+/g, " ").trim()} custom motion clip`;
          await api.saveMotion({
            name: result.name,
            duration: result.duration,
            pose: result.pose,
            version: result.version,
            description,
          });
          for (const expr of result.expressions) {
            await api.saveEmotion({
              name: `${result.name}_${expr.preset}`,
              preset: expr.preset,
              reset_ms: 4000,
            });
          }
          ctx.events.emit("vrma-imported", {
            name: result.name,
            duration: result.duration,
            pose: result.pose,
            expressions: result.expressions,
          });
          // Pick the new clip up in the live registries (and drop any stale
          // bakes while at it).
          await pushLibrary("reload");
        } catch (err) {
          ctx.events.emit("vrma-imported", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });
  }
});
