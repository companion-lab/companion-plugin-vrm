import * as THREE from "three";

export type RendererPerf = {
  maxPixelRatio: number;
  fpsCap: number | null;
  antialias: boolean;
};

export const DEFAULT_RENDERER_PERF: RendererPerf = {
  maxPixelRatio: 1.5,
  fpsCap: 60,
  antialias: true,
};

export type SceneHandle = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  beginFrame: () => { dt: number; t: number; render: boolean };
  setPerf: (p: Partial<Pick<RendererPerf, "maxPixelRatio" | "fpsCap">>) => void;
  dispose: () => void;
};

export function createScene(canvas: HTMLCanvasElement, perf: RendererPerf = DEFAULT_RENDERER_PERF): SceneHandle {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 1.4, 4);
  camera.lookAt(0, 1.4, 0);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: perf.antialias,
    alpha: true,
    premultipliedAlpha: false,
    // Click-through hit-testing reads pixel alpha between frames.
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Uncapped devicePixelRatio multiplies fragment work (2x = 4x pixels);
  // clamp it. Live-updatable via setPerf.
  let maxPixelRatio = perf.maxPixelRatio;
  let fpsCap = perf.fpsCap;
  const applyPixelRatio = () => {
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(Math.min(dpr, maxPixelRatio));
  };
  applyPixelRatio();

  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(1, 2, -2);
  scene.add(dir);

  const fit = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  fit();
  const ro = new ResizeObserver(() => {
    applyPixelRatio();
    fit();
  });
  ro.observe(canvas);

  const timer = new THREE.Timer();
  let lastRenderT = -Infinity;
  const beginFrame = () => {
    timer.update();
    const t = timer.getElapsed();
    if (fpsCap === null) {
      lastRenderT = t;
      return { dt: Math.min(timer.getDelta(), 0.05), t, render: true };
    }
    const interval = 1 / fpsCap;
    if (t - lastRenderT < interval) return { dt: 0, t, render: false };
    const dt = Math.min(t - lastRenderT, 0.05);
    lastRenderT = t;
    return { dt, t, render: true };
  };

  return {
    scene,
    camera,
    renderer,
    beginFrame,
    setPerf: (p) => {
      if (p.maxPixelRatio !== undefined) {
        maxPixelRatio = p.maxPixelRatio;
        applyPixelRatio();
        fit();
      }
      if (p.fpsCap !== undefined) {
        fpsCap = p.fpsCap;
        lastRenderT = -Infinity;
      }
    },
    dispose: () => {
      ro.disconnect();
      renderer.dispose();
    },
  };
}

export function frameLoop(
  handle: SceneHandle,
  update: (dt: number, t: number) => void,
): () => void {
  let raf = 0;
  const tick = () => {
    const { dt, t, render } = handle.beginFrame();
    if (render) {
      update(dt, t);
      handle.renderer.render(handle.scene, handle.camera);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
