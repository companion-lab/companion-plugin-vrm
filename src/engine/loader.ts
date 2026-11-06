import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

export type VRMHandle = {
  vrm: VRM | null;
  scene: THREE.Group;
};

export async function loadVRM(urlOrBuffer: string | ArrayBuffer): Promise<VRMHandle> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await (typeof urlOrBuffer === "string"
    ? loader.loadAsync(urlOrBuffer)
    : loader.parseAsync(urlOrBuffer, ""));
  const vrm = (gltf.userData.vrm as VRM | undefined) ?? null;

  if (vrm) {
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
  }

  return { vrm, scene: gltf.scene };
}
