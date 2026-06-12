import { head, put } from '@vercel/blob';

// Tier 0: the canvas snapshot lives in a Vercel Blob as zlib-deflated RGB bytes.
const BLOB_KEY = 'pixelparty/canvas.bin';

export function storeEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

// Returns the deflated snapshot from the blob store, or null if none exists yet.
export async function loadSnapshot() {
  let meta;
  try {
    meta = await head(BLOB_KEY);
  } catch {
    return null;
  }
  // Cache-bust: the blob CDN can serve a stale copy for up to a minute after
  // an overwrite, and a stale canvas on boot would silently undo drawings.
  const url = new URL(meta.downloadUrl);
  url.searchParams.set('v', String(Date.now()));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function saveSnapshot(deflated) {
  await put(BLOB_KEY, deflated, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/octet-stream',
    cacheControlMaxAge: 60
  });
}
