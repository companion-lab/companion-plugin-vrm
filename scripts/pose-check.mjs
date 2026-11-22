import * as THREE from "three";
import { readFileSync } from "fs";
import { resolve } from "path";

// End-to-end check of the idle-pose space conversion (src/engine/idle/pose-space.ts)
// against REAL VRM files: parses the glTF JSON chunk, rebuilds the raw humanoid
// hierarchy, applies the engine's normalized-frame POSE deltas through the
// B⁻¹·P⁻¹·N·P·B sandwich, and asserts the world-space result is anatomically
// sane for BOTH VRM 0.x (Unity bone conventions) and VRM 1.0 (identity rest
// rotations) exports. Usage: node scripts/pose-check.mjs model.vrm [more.vrm…]

function parseGltf(path) {
  const buf = readFileSync(path);
  let c = 12;
  while (c < buf.length) {
    const len = buf.readUInt32LE(c);
    const type = buf.toString("ascii", c + 4, c + 8);
    if (type === "JSON") return JSON.parse(buf.toString("utf8", c + 8, c + 8 + len));
    c += 8 + len;
  }
  throw new Error(`${path}: no JSON chunk`);
}

function vrmInfo(json) {
  const ext = json.extensions?.VRMC_vrm ?? json.extensions?.VRM;
  if (!ext?.humanoid?.humanBones) throw new Error("no humanoid mapping");
  // Normalize both shapes: VRM 1.0 keys are bone names, VRM 0.x entries are
  // { bone, node } records.
  const bones = {};
  for (const [key, entry] of Object.entries(ext.humanoid.humanBones)) {
    const name = typeof entry === "object" && entry.bone ? entry.bone : key;
    const node = typeof entry === "object" ? entry.node : entry;
    if (name && node != null) bones[name] = { node };
  }
  return {
    isVrm0: !json.extensions.VRMC_vrm,
    bones,
  };
}

// World matrices of every node in the RENDERED frame: node locals, with the
// rotateVRM0 scene-level yaw (VRM 0.x: 180° around Y) applied on top — the
// same frame the engine's converted deltas act in.
function nodeWorlds(json, isVrm0) {
  const nodes = json.nodes;
  const parent = new Map();
  json.scenes?.[json.scene ?? 0]?.nodes?.forEach((root) => parent.set(root, null));
  nodes.forEach((n, i) => (n.children ?? []).forEach((ch) => parent.set(ch, i)));

  const local = (i) => {
    const n = nodes[i];
    const m = new THREE.Matrix4();
    if (n.matrix) m.fromArray(n.matrix);
    else {
      const q = n.rotation ? new THREE.Quaternion(...n.rotation) : new THREE.Quaternion();
      m.compose(
        new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
        q,
        new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
      );
    }
    return m;
  };

  const yawM = isVrm0 ? new THREE.Matrix4().makeRotationY(Math.PI) : new THREE.Matrix4();
  const worlds = new Map();
  const visit = (i, parentWorld) => {
    const w = parentWorld ? new THREE.Matrix4().multiplyMatrices(parentWorld, local(i)) : local(i).clone();
    worlds.set(i, w);
    (nodes[i].children ?? []).forEach((ch) => visit(ch, w));
  };
  json.scenes?.[json.scene ?? 0]?.nodes?.forEach((root) => visit(root, null));
  if (isVrm0) for (const w of worlds.values()) w.premultiply(yawM);
  return { worlds, parent };
}

const _e = new THREE.Euler();
const eulerQuat = (x, y, z) => new THREE.Quaternion().setFromEuler(_e.set(x, y, z, "YXZ"));

// The engine's conversion (pose-space.ts): raw delta D = B⁻¹·P⁻¹·N·P·B,
// applied as raw = B·D. P here is the parent world rest quaternion.
const toRawDelta = (n, p, b) =>
  b.clone().invert().multiply(p.clone().invert()).multiply(n).multiply(p).multiply(b);

// The pose, authored in the normalized frame (idle/animation.ts POSE + updateBody).
const POSE = {
  leftUpperArm: [0, 0, -1.2],
  rightUpperArm: [0, 0, 1.2],
  leftLowerArm: [0, -0.3, 0],
  rightLowerArm: [0, 0.3, 0],
  leftHand: [0, -0.2, 0],
  rightHand: [0, 0.2, 0],
  leftLowerLeg: [0.15, 0, 0],
  rightLowerLeg: [0.15, 0, 0],
};

function jointPos(json, worlds, name, bones) {
  const i = bones[name]?.node;
  if (i == null) return null;
  return new THREE.Vector3().setFromMatrixPosition(worlds.get(i));
}

function checkModel(path) {
  const json = parseGltf(path);
  const { isVrm0, bones } = vrmInfo(json);
  const { worlds, parent } = nodeWorlds(json, isVrm0);

  // B and P per humanoid bone, as the engine captures them at rest (P with
  // the scene-level yaw folded in — see animation.ts parentWorldRest).
  const rest = {};
  const sceneYaw = isVrm0
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
    : new THREE.Quaternion();
  for (const [name, b] of Object.entries(bones)) {
    if (b.node == null) continue;
    const node = json.nodes[b.node];
    rest[name] = {
      b: node.rotation ? new THREE.Quaternion(...node.rotation) : new THREE.Quaternion(),
      p: (() => {
        const chain = [];
        let cur = parent.get(b.node);
        const sceneRoots = new Set(json.scenes?.[json.scene ?? 0]?.nodes ?? []);
        while (cur != null && !sceneRoots.has(cur)) {
          chain.unshift(cur);
          cur = parent.get(cur);
        }
        const p = new THREE.Quaternion();
        for (const a of chain) {
          const r = json.nodes[a].rotation;
          if (r) p.multiply(new THREE.Quaternion(...r));
        }
        return p.premultiply(sceneYaw);
      })(),
    };
  }

  // Apply the pose: world_bone = P · B · D.
  const posedWorlds = new Map(worlds);
  const worldOf = (i) => posedWorlds.get(i).clone();
  for (const [name, [x, y, z]] of Object.entries(POSE)) {
    const idx = bones[name]?.node;
    const r = rest[name];
    if (idx == null || !r) continue;
    const d = toRawDelta(eulerQuat(x, y, z), r.p, r.b);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...(json.nodes[idx].translation ?? [0, 0, 0])),
      r.b.clone().multiply(d),
      new THREE.Vector3(1, 1, 1),
    );
    const parentWorld = (() => {
      const pi = parent.get(idx);
      return pi == null ? new THREE.Matrix4() : worldOf(pi);
    })();
    posedWorlds.set(idx, new THREE.Matrix4().multiplyMatrices(parentWorld, local));
    // Propagate to descendants so child-joint directions include the move.
    const walk = (ci, pw) => {
      const node = json.nodes[ci];
      const lm = node.matrix
        ? new THREE.Matrix4().fromArray(node.matrix)
        : new THREE.Matrix4().compose(
            new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
            node.rotation ? new THREE.Quaternion(...node.rotation) : new THREE.Quaternion(),
            new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
          );
      const w = new THREE.Matrix4().multiplyMatrices(pw, lm);
      posedWorlds.set(ci, w);
      (node.children ?? []).forEach((cc) => walk(cc, w));
    };
    (json.nodes[idx].children ?? []).forEach((cc) => walk(cc, posedWorlds.get(idx)));
  }

  const dir = (a, b) => (a && b ? b.clone().sub(a).normalize() : null);
  const txt = (v) => (v ? `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})` : "n/a");

  const get = (name) => jointPos(json, posedWorlds, name, bones);
  const ls = get("leftShoulder"), le = get("leftUpperArm") ?? get("leftShoulder"), lw = get("leftLowerArm");
  const rs = get("rightShoulder"), rw = get("rightLowerArm");
  const lk = get("leftUpperLeg"), la = get("leftLowerLeg"), lf = get("leftFoot");

  const upperArmL = dir(get("leftUpperArm"), get("leftLowerArm"));
  const upperArmR = dir(get("rightUpperArm"), get("rightLowerArm"));
  const forearmL = dir(get("leftLowerArm"), get("leftHand"));
  const shinL = dir(get("leftLowerLeg"), get("leftFoot"));

  console.log(`\n=== ${path.split("/").pop()} — ${isVrm0 ? "VRM 0.x" : "VRM 1.0"}`);
  console.log(`  leftUpperArm  dir: ${txt(upperArmL)}`);
  console.log(`  rightUpperArm dir: ${txt(upperArmR)}`);
  console.log(`  leftForearm   dir: ${txt(forearmL)}`);
  console.log(`  leftShin      dir: ${txt(shinL)}`);

  let ok = true;
  const assert = (label, cond) => {
    if (!cond) ok = false;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  };
  // Arms hang DOWN (dominant -Y), mirrored, not raised (the VRM 1.0 bug).
  assert("left upper arm points down", upperArmL && upperArmL.y < -0.8);
  assert("right upper arm points down", upperArmR && upperArmR.y < -0.8);
  // Forearms bend toward the front the model faces (+Z in the rendered frame).
  assert("left forearm flexes forward (not a twist)", forearmL && forearmL.z > 0.2);
  // Shins stay mostly downward with a slight backward (knee) bend.
  assert("left shin points down", shinL && shinL.y < -0.9);
  assert("knee bends backward (heel back)", shinL && shinL.z < 0.05);

  // v5 .vrma playback equivalence: applying an authored normalized quat N
  // through the yaw-folded sandwich must land exactly on three-vrm's own
  // mapping — pre-yaw P with the x/z negation of N for VRM 0.x (the π-yaw
  // conjugation in createVRMAnimationHumanoidTracks), plain N for VRM 1.0.
  const lu = bones["leftUpperArm"]?.node;
  const r = rest["leftUpperArm"];
  if (lu != null && r) {
    const n = eulerQuat(0.2, -0.4, 1.1);
    const d = toRawDelta(n, r.p, r.b); // engine playback: P has yaw folded in
    const mine = r.b.clone().multiply(d);
    // three-vrm: pre-yaw parent chain + negated track values for VRM 0.x
    const pPre = r.p.clone().premultiply(sceneYaw.clone().invert());
    const negated = n.clone();
    if (isVrm0) {
      negated.x = -negated.x;
      negated.z = -negated.z;
    }
    const ref = pPre.clone().invert().multiply(negated).multiply(pPre).multiply(r.b);
    const probe = new THREE.Vector3(0.3, -0.8, 0.52);
    const okEq =
      mine.angleTo(ref) < 1e-6 &&
      probe.clone().applyQuaternion(mine).distanceTo(probe.clone().applyQuaternion(ref)) < 1e-6;
    assert("v5 playback ≡ three-vrm mapping", okEq);

    // v5 root motion: chain⁻¹·yaw⁻¹·offset must equal inv(yaw·chain)·offset.
    const offset = new THREE.Vector3(0.1, -0.05, 0.3);
    const mineV = offset
      .clone()
      .applyQuaternion(sceneYaw.clone().invert())
      .applyQuaternion(pPre.clone().invert());
    const parentWorld = new THREE.Matrix4().makeRotationFromQuaternion(
      sceneYaw.clone().multiply(pPre),
    );
    const refV = offset.clone().applyMatrix4(parentWorld.invert());
    assert("v5 hips offset ≡ inv(yaw·chain)·offset", mineV.distanceTo(refV) < 1e-6);
  }
  return ok;
}

const files = process.argv.slice(2).map((p) => resolve(p));
if (!files.length) {
  console.error("usage: node scripts/pose-check.mjs model.vrm [more.vrm…]");
  process.exit(1);
}
let all = true;
for (const f of files) all = checkModel(f) && all;
if (!all) process.exit(1);
console.log("\npose check OK");
