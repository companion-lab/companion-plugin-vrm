// The live avatar engine, moved out of the host's App.tsx now that it belongs
// to the vrm plugin. The main window's AvatarCanvas widget mounts the canvas
// and calls startAvatarEngine; everything the host's bus exposes (ctx.avatar
// control surface, click-through pixel probes) is answered by the handlers
// installed here via ctx.avatar.provide.
//
// Runs ONLY in the main window (the backdrop widget only exists there); in
// the settings window the bus stays at no-ops, same as before.

import { VRMUtils } from "@pixiv/three-vrm";
import type { PluginContext } from "../../../../sdk/js/@companion/plugin";
import { createScene, frameLoop, type SceneHandle } from "./scene";
import { loadVRM, type VRMHandle } from "./loader";
import { ExpressionController } from "./expression/controller";
import {
  clearCustomEmotions,
  listEmotionNames,
  registerCustomEmotion,
} from "./expression/registry";
import { LipSyncController } from "./lipsync/controller";
import {
  captureGroundReference,
  idleAnimation,
  resetIdleState,
  setMotionOverride,
} from "./idle/animation";
import { MotionController } from "./idle/motion";
import {
  clearCustomMotions,
  listMotionNames,
  registerCustom,
} from "./idle/registry";
import { loadVrma } from "./idle/vrma-loader";
import { base64ToArrayBuffer } from "./base64";
import { IdleMixer, loadIdleMixer } from "./idle/idle-mixer";
import { tauriInvoke, tauriListen } from "../vendor/tauri-events";
// Shared backend-call retry: plugin-context invokes occasionally never
// resolve on macOS (see retry.ts) — the boot sequence must converge.
import { callWithRetry } from "../retry";

type FpsCap = "thirty" | "sixty" | "uncapped";

type PerfConfigShape = {
  max_pixel_ratio: number;
  fps_cap: FpsCap;
  antialias: boolean;
};

const fpsFrom = (cap: FpsCap): number | null =>
  cap === "thirty" ? 30 : cap === "sixty" ? 60 : null;

// ─── Engine error surface (drives the main-window error overlay) ───

type ErrorListener = (message: string) => void;
const errorListeners = new Set<ErrorListener>();

/** Subscribe to engine/model-load failures (main window only). */
export function onEngineError(l: ErrorListener): () => void {
  errorListeners.add(l);
  return () => errorListeners.delete(l);
}

function reportError(message: string): void {
  errorListeners.forEach((l) => l(message));
}

/** Alpha byte under a CSS point of the renderer's drawing buffer, or null. */
function canvasPixelAlpha(
  scene: SceneHandle,
  cssX: number,
  cssY: number,
): number | null {
  try {
    const gl = scene.renderer.getContext();
    const dpr = scene.renderer.getPixelRatio();
    const x = Math.floor(cssX * dpr);
    // GL origin is bottom-left; the CSS point is top-left.
    const y = Math.floor(gl.drawingBufferHeight - cssY * dpr);
    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) {
      return null;
    }
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[3];
  } catch {
    return null;
  }
}

// ─── Engine lifecycle ───

let activeStop: (() => void) | null = null;

/** Start the avatar engine on the given canvas. Idempotent: a start while
 *  one is already running is a no-op (StrictMode remounts stop first). */
export function startAvatarEngine(ctx: PluginContext, canvas: HTMLCanvasElement): void {
  if (activeStop) return;
  activeStop = runEngine(ctx, canvas);
}

/** Stop the engine and return the bus to no-ops (main window unmount). */
export function stopAvatarEngine(): void {
  activeStop?.();
  activeStop = null;
}

function runEngine(ctx: PluginContext, canvas: HTMLCanvasElement): () => void {
  let cancelled = false;
  let stopLoop = () => {};
  let cleanups: Array<() => void> = [];

  const handleRef = { current: null as VRMHandle | null };
  const exprRef = { current: null as ExpressionController | null };
  const lipsRef = { current: null as LipSyncController | null };
  const motionRef = { current: null as MotionController | null };
  const sceneRef = { current: null as ReturnType<typeof createScene> | null };
  const idleMixerRef = { current: null as IdleMixer | null };
  let swapGen = 0;

  const attachVrmTo = (scene: ReturnType<typeof createScene>, vrm: VRMHandle) => {
    const prev = handleRef.current;
    if (prev) {
      scene.scene.remove(prev.scene);
      VRMUtils.deepDispose(prev.scene);
    }
    resetIdleState();
    handleRef.current = vrm;
    vrm.scene.position.y = 0.6;
    scene.scene.add(vrm.scene);
    if (vrm.vrm?.humanoid) {
      vrm.vrm.humanoid.autoUpdateHumanBones = false;
    }
    if (vrm.vrm) {
      captureGroundReference(vrm.vrm);
    }
    if (exprRef.current) {
      exprRef.current.setVrm(vrm.vrm);
    } else {
      exprRef.current = new ExpressionController(vrm.vrm);
    }
    if (lipsRef.current) {
      lipsRef.current.setVrm(vrm.vrm);
    } else {
      lipsRef.current = new LipSyncController(vrm.vrm);
    }
    if (!motionRef.current) {
      motionRef.current = new MotionController();
    }
  };

  const resolveModel = async (id: string): Promise<VRMHandle> => {
    // Model bytes come from this plugin's own backend: custom models from its
    // data dir, the built-in demo from the plugin package's own assets (the
    // host ships no model files of its own). The base64 payload crosses IPC
    // as a multi-MB string — during boot the busy webview can delay it past
    // the default 8s timeout, and re-issuing would stack duplicate 20MB+
    // transfers, so give each attempt more headroom and fewer retries.
    const method = id.startsWith("custom:") ? "vrm.load_model" : "vrm.load_builtin_model";
    const base64 = await callWithRetry(
      () => ctx.backend.call<string>(method, { id }),
      ctx.log,
      "model bytes load",
      { timeoutMs: 30_000, retries: 3 },
    );
    const handle = await loadVRM(await base64ToArrayBuffer(base64));
    return handle;
  };

  const swapTo = async (id: string) => {
    const gen = ++swapGen;
    try {
      const vrm = await resolveModel(id);
      const scene = sceneRef.current;
      if (gen !== swapGen || !scene) {
        VRMUtils.deepDispose(vrm.scene);
        return;
      }
      attachVrmTo(scene, vrm);
      ctx.log.info(`model attached: ${id}`);
    } catch (e) {
      if (gen === swapGen) {
        reportError(e instanceof Error ? e.message : String(e));
        ctx.log.error(`model load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  // Expose live avatar control to other plugins (via ctx.avatar). Handlers
  // close over this engine's scene/controllers; the bus defaults to no-ops
  // in the settings window, where this engine never runs.
  ctx.avatar.provide({
    setEmotion: (name) => exprRef.current?.setEmotion(name as never),
    triggerMotion: (name) => {
      idleMixerRef.current?.notifyBusy();
      motionRef.current?.trigger(name as never);
    },
    setViseme: (name, weight) => {
      if (name === "neutral") {
        lipsRef.current?.stop();
      } else {
        lipsRef.current?.setViseme(name as never, weight);
      }
    },
    registerMotion: (def) => registerCustom(def as never),
    registerEmotion: (def) => registerCustomEmotion(def as never),
    loadModel: async (source) => {
      if (source.base64) {
        const vrm = await loadVRM(await base64ToArrayBuffer(source.base64));
        const scene = sceneRef.current;
        if (!cancelled && scene) attachVrmTo(scene, vrm);
        return;
      }
      if (source.id) await swapTo(source.id);
    },
    loadVrmaBase64: async (data, name) => {
      const vrm = handleRef.current?.vrm;
      if (!vrm) throw new Error("VRM model not loaded");
      return loadVrma(await base64ToArrayBuffer(data), name, vrm);
    },
    reloadLibrary: (motions, emotions) => {
      clearCustomMotions();
      clearCustomEmotions();
      for (const m of motions) {
        registerCustom(m as never);
      }
      for (const e of emotions) {
        registerCustomEmotion(e as never);
      }
    },
    describeCapabilities: () => ({
      emotions: listEmotionNames(),
      motions: listMotionNames(),
    }),
    pixelAlphaAt: (x, y) => {
      const scene = sceneRef.current;
      return scene ? canvasPixelAlpha(scene, x, y) : null;
    },
  });

  void (async () => {
    // The boot retries as a whole (individual steps retry via callWithRetry):
    // a step exhausting its retries inside the startup activation storm used
    // to leave the app permanently avatar-less with only a console line — a
    // fresh run once the window has settled converges, and only a second
    // consecutive failure surfaces the error overlay.
    for (let bootAttempt = 1; bootAttempt <= 2; bootAttempt++) {
      try {
        // Perf config is host-owned state; the engine reads it directly.
        // Retried like every boot read — an invoke response eaten while the
        // window is busy would otherwise stall the whole boot silently (the
        // one step that had no retry).
        const perf = await callWithRetry(
          () => tauriInvoke<PerfConfigShape>("get_performance_config"),
          ctx.log,
          "get_performance_config",
        );
        if (cancelled) return;

        const scene = createScene(canvas, {
          maxPixelRatio: perf.max_pixel_ratio,
          fpsCap: fpsFrom(perf.fps_cap),
          antialias: perf.antialias,
        });
        sceneRef.current = scene;
        idleMixerRef.current = new IdleMixer();

        let initialId = "builtin:demo";
        try {
          const stored = await callWithRetry(
            () => ctx.backend.call<string | null>("vrm.get_active_model"),
            ctx.log,
            "active model lookup",
          );
          if (stored) initialId = stored;
        } catch (e) {
          // Fall back to the demo model, but leave a trace: a silent catch
          // here read as "the app always loads the demo model".
          ctx.log.warn(`active model lookup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const vrm = await resolveModel(initialId);
        if (cancelled) {
          scene.dispose();
          return;
        }
        attachVrmTo(scene, vrm);
        ctx.log.info(`model attached: ${initialId}`);

        stopLoop = frameLoop(scene, (dt, t) => {
          const handle = handleRef.current;
          exprRef.current?.update(dt);
          lipsRef.current?.update(dt);
          const busy = motionRef.current?.isActive() === true;
          const pick = idleMixerRef.current?.tick(dt, { busy });
          if (pick) motionRef.current?.trigger(pick);
          const mo = motionRef.current?.update(dt);
          setMotionOverride(
            mo?.state ?? null,
            mo?.absolute ?? false,
            mo?.fade ?? 1,
            mo?.hipsPos ?? null,
          );
          handle?.vrm?.update(dt);
          if (handle) idleAnimation(handle, t, dt, exprRef.current);
        });
        return;
      } catch (e) {
        if (cancelled) return;
        // Drop any partial scene from the failed attempt before retrying.
        sceneRef.current?.dispose();
        sceneRef.current = null;
        if (bootAttempt === 2) {
          reportError(e instanceof Error ? e.message : String(e));
          return;
        }
        ctx.log.warn(
          `avatar boot failed (${e instanceof Error ? e.message : String(e)}); retrying once`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (cancelled) return;
      }
    }
  })();

  // Host-global broadcasts: perf changes retune the renderer, idle-mixer
  // changes reload the mixer config. Both are host-owned channels the
  // plugin-namespaced events can't reach.
  void tauriListen<PerfConfigShape>("perf-changed", (cfg) => {
    sceneRef.current?.setPerf({
      maxPixelRatio: cfg.max_pixel_ratio,
      fpsCap: fpsFrom(cfg.fps_cap),
    });
  })
    .then((off) => {
      if (cancelled) off();
      else cleanups.push(off);
    })
    .catch(() => {});
  void tauriListen("idle-mixer-changed", () => {
    idleMixerRef.current?.setConfig(loadIdleMixer());
  })
    .then((off) => {
      if (cancelled) off();
      else cleanups.push(off);
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    ctx.avatar.provide({}); // back to no-ops; live handlers died with the scene
    for (const off of cleanups) off();
    cleanups = [];
    swapGen++;
    stopLoop();
    sceneRef.current?.dispose();
    sceneRef.current = null;
  };
}
