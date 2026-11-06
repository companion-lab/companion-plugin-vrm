const CHUNK = 0x8000;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
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
