import { readFileSync } from "fs";
import { resolve } from "path";

const path = resolve(process.argv[2] ?? "public/model/hime.glb");
const buf = readFileSync(path);

const decode = new TextDecoder("utf-8");
let cursor = 12;
const chunks = {};
while (cursor < buf.length) {
  const clen = buf.readUInt32LE(cursor);
  const ctype = buf.toString("ascii", cursor + 4, cursor + 8);
  const cdata = buf.subarray(cursor + 8, cursor + 8 + clen);
  chunks[ctype] = Buffer.from(cdata);
  cursor += 8 + clen;
}

const json = JSON.parse(decode.decode(chunks["JSON"]));
const nodes = json.nodes ?? [];
const skins = json.skins ?? [];

for (const skin of skins) {
  console.log("--- Skin ---");
  const boneNames = (skin.joints ?? []).map((ji) => nodes[ji]?.name ?? `<unnamed_${ji}>`);
  console.log("Total bones:", boneNames.length);
  console.log("All bone names:");
  for (const n of boneNames) console.log("  ", n);
}

const vrmExt = json.extensions?.VRMC_vrm;
if (vrmExt) {
  console.log("\n--- VRM humanoid mapping ---");
  const humanBones = vrmExt.humanoid?.humanBones ?? {};
  for (const [name, val] of Object.entries(humanBones)) {
    const node = nodes[val.node];
    console.log(`  ${name.padEnd(22)} -> ${node?.name ?? "?"}`);
  }
}
