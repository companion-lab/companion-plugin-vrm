import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { normalizedToRawDelta } from "./pose-space";

const quat = (x: number, y: number, z: number, w: number) => new THREE.Quaternion(x, y, z, w);
const axisAngle = (axis: THREE.Vector3, rad: number) =>
  new THREE.Quaternion().setFromAxisAngle(axis, rad);

// applyAngleOrder composes like three-vrm does in VRMHumanoidRig.update():
// raw = P⁻¹ · N · P · B
function rigMapping(n: THREE.Quaternion, p: THREE.Quaternion, b: THREE.Quaternion) {
  return p.clone().invert().multiply(n).multiply(p).multiply(b);
}

describe("normalizedToRawDelta", () => {
  it("is the identity when parent and rest rotations are identity (VRM 1.0 T-pose bones)", () => {
    const n = axisAngle(new THREE.Vector3(0, 0, 1), -1.2);
    const d = normalizedToRawDelta(n, quat(0, 0, 0, 1), quat(0, 0, 0, 1), new THREE.Quaternion());
    expect(d.x).toBeCloseTo(n.x, 6);
    expect(d.y).toBeCloseTo(n.y, 6);
    expect(d.z).toBeCloseTo(n.z, 6);
    expect(d.w).toBeCloseTo(n.w, 6);
  });

  it("reproduces VRMHumanoidRig.update()'s raw = P⁻¹·N·P·B when applied as rest·delta", () => {
    const n = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.4, 1.1, "YXZ"));
    // Simulated VRM 0.x conventions: non-identity parent chain and bone rest.
    const p = axisAngle(new THREE.Vector3(0, 1, 0), 0.3).multiply(
      axisAngle(new THREE.Vector3(1, 0, 0), -0.5),
    );
    const b = axisAngle(new THREE.Vector3(0, 0, 1), -0.96).multiply(
      axisAngle(new THREE.Vector3(1, 0, 0), 0.4),
    );

    const delta = normalizedToRawDelta(n, p, b, new THREE.Quaternion());
    const applied = b.clone().multiply(delta); // playback: raw = rest · delta

    const expected = rigMapping(n, p, b);
    // Quats q and -q encode the same rotation — compare the rotation it
    // produces on a probe vector too, to catch both sign and axis mistakes.
    expect(applied.angleTo(expected)).toBeLessThan(1e-6);
    const probe = new THREE.Vector3(0.3, -0.8, 0.52);
    expect(probe.clone().applyQuaternion(applied).distanceTo(probe.clone().applyQuaternion(expected))).toBeLessThan(1e-6);
  });

  it("yields a world-frame rotation delta of N when the parent sits at rest", () => {
    // world_rest = P·B, world_new = P·(rest·delta) — the ratio must be N.
    const n = axisAngle(new THREE.Vector3(0, 0, 1), -1.2); // left arm down
    const p = axisAngle(new THREE.Vector3(0, 1, 0), 1.7); // e.g. armature yaw
    const b = axisAngle(new THREE.Vector3(1, 0, 0), 0.6);

    const delta = normalizedToRawDelta(n, p, b, new THREE.Quaternion());
    const worldRest = p.clone().multiply(b);
    const worldNew = p.clone().multiply(b.clone().multiply(delta));
    const worldDelta = worldNew.multiply(worldRest.clone().invert());

    expect(worldDelta.angleTo(n)).toBeLessThan(1e-6);
  });
});
