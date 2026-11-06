import type { VRM, VRMExpressionPresetName } from "@pixiv/three-vrm";
import { VISEMES } from "./visemes";

type VisemeName = (typeof VISEMES)[number];
type Weights = Record<VisemeName, number>;

function zeroWeights(): Weights {
  return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
}

// Interpolation timing: the mouth pops open almost immediately with the
// syllable (attack), then closes a touch slower, which is how real
// articulation moves. Equal 50ms ramps in both directions read as lagging.
const ATTACK_S = 0.035;
const RELEASE_S = 0.09;

/** Lip sync driver for VRM viseme blendshapes. Visemes carry continuous
 *  weights — loudness scales how wide the mouth opens instead of only
 *  picking between fixed shapes — and every new viseme starts interpolating
 *  from whatever is currently on screen, so rapid updates never snap. */
export class LipSyncController {
  private vrm: VRM | null;
  private from: Weights = zeroWeights();
  private to: Weights = zeroWeights();
  private t = 1;
  private duration = ATTACK_S;

  constructor(vrm: VRM | null) {
    this.vrm = vrm;
  }

  setVrm(vrm: VRM | null) {
    this.vrm = vrm;
    this.from = zeroWeights();
    this.to = zeroWeights();
    this.t = 1;
  }

  setViseme(name: VRMExpressionPresetName | "neutral", weight = 1) {
    const to = zeroWeights();
    if (name !== "neutral") {
      to[name as VisemeName] = Math.min(1, Math.max(0, weight));
    }
    // Freeze the currently displayed blend as the interpolation source.
    this.from = this.blend();
    this.to = to;
    this.duration = name === "neutral" ? RELEASE_S : ATTACK_S;
    this.t = 0;
  }

  stop() {
    this.setViseme("neutral");
  }

  private blend(): Weights {
    const k = this.t;
    const out = zeroWeights();
    for (const v of VISEMES) out[v] = this.from[v] * (1 - k) + this.to[v] * k;
    return out;
  }

  update(dt: number) {
    if (!this.vrm) return;
    const expr = this.vrm.expressionManager;
    if (!expr) return;
    if (this.t < 1) this.t = Math.min(1, this.t + dt / this.duration);
    const w = this.blend();
    for (const v of VISEMES) expr.setValue(v, w[v]);
  }
}
