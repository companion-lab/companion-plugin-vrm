const CHUNK = 0x8000;

export function arrayBufferToBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 through the webview's native decoder (a data: URL fetch).
 *  For multi-megabyte payloads (VRM models, .vrma clips) this is far faster
 *  than a JS char-by-char loop and doesn't hold the main thread for the
 *  whole decode. */
export async function base64ToArrayBuffer(base64: string): Promise<ArrayBuffer> {
  const res = await fetch(`data:application/octet-stream;base64,${base64}`);
  return res.arrayBuffer();
}

/** Sync base64 → Float32Array for baked motion tracks. registerCustom is a
 *  sync fire-and-forget call, so the async fetch decoder above isn't an
 *  option here; atob on the ~tens-of-MB blobs this sees stays fast enough. */
export function base64ToFloat32Array(base64: string): Float32Array {
  const bin = atob(base64);
  if (bin.length % 4 !== 0) return new Float32Array(0);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bin.length);
    for (let j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
  }
  return new Float32Array(bytes.buffer);
}
