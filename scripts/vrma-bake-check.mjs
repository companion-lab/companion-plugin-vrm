import * as THREE from "three";

// 1. rotation bake: delta = B^-1 * P^-1 * N * P * B, playback = rest * delta
//    must equal three-vrm raw mapping invP * N * P * B
const P = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, -0.2));
const B = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0.9, 0.4));
const N = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.2, -0.7, 2.1));
const delta = B.clone().invert().multiply(P.clone().invert()).multiply(N).multiply(P).multiply(B);
const mine = B.clone().multiply(delta);
const ref = P.clone().invert().multiply(N).multiply(P).multiply(B);
console.assert(mine.angleTo(ref) < 1e-6, `bake mismatch: ${mine.angleTo(ref)}`);

// 2. hips leash: offset clamped to circle, direction preserved, Y untouched
const R = 0.35;
const rest = { x: 0, z: 0 };
for (const [ox, oz] of [[0.2, 0.2], [1.5, -2], [-0.3, 0.1]]) {
  let x = ox, z = oz;
  const dist = Math.hypot(x, z);
  if (dist > R) {
    const k = R / dist;
    x *= k;
    z *= k;
  }
  console.assert(Math.hypot(x, z) <= R + 1e-9, `leash failed for (${ox},${oz})`);
  console.assert(Math.abs(Math.atan2(oz, ox) - Math.atan2(z, x)) < 1e-9, `leash bent direction for (${ox},${oz})`);
}
// inside radius: untouched
{
  const x = 0.2, z = 0.1;
  const dist = Math.hypot(x, z);
  const cx = dist > R ? x * (R / dist) : x;
  const cz = dist > R ? z * (R / dist) : z;
  console.assert(cx === x && cz === z, "leash moved in-radius point");
}

console.log("vrma bake OK");
