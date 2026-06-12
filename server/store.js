import { del, list, put } from '@vercel/blob';

// Tier 0: Vercel Blob holding a base snapshot plus an append-only delta log.
//
// Upstream writes are literal deltas: each push uploads only the pixels drawn
// through this instance (6-byte records, same format as the socket wire).
// Appends can't conflict, so concurrent instances never erase each other's
// work the way overwriting one full-state object did. Readers replay the log
// over the newest base in timestamp order; replay is idempotent, so applying
// a delta twice (e.g. one already folded into a base) is harmless.
//
// Pathnames are versioned because the blob CDN caches by pathname and ignores
// query strings: overwriting a fixed key serves stale content for up to a
// minute, while a never-seen pathname can't be cached. list() is an API call
// and always sees the true latest objects.
const DIR = 'pixelparty/';
const BASE_PREFIX = `${DIR}base-`;
const DELTA_PREFIX = `${DIR}delta-`;
const KEEP_BASES = 2; // a base may be read while a newer one lands; keep a spare

// A compaction folds everything it has replayed into a new base, but only
// claims deltas stamped at least this far in the past: a delta whose upload
// was still in flight when we listed must not be declared compacted.
const COMPACT_MARGIN_MS = 3000;
export const COMPACT_AFTER_DELTAS = 24;

export function storeEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

const stamp = (t) => String(t).padStart(14, '0');
const stampOf = (pathname, prefix) => pathname.slice(prefix.length, prefix.length + 14);
const nonce = () => Math.random().toString(36).slice(2, 8);
const byPathnameDesc = (a, b) => (a.pathname < b.pathname ? 1 : -1);

async function fetchBuf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// This instance's view of the log
let basePathname = null;
let baseStamp = '';
const deltaCache = new Map(); // pathname -> Buffer, every live delta at/after baseStamp

// Lists the store and returns what the caller should apply: the new base (if
// it changed) and every cached delta, sorted oldest-first. Deltas are
// returned every pull — re-applying them is idempotent and means a new base
// is always followed by the full replay it needs.
export async function pullState() {
  const { blobs } = await list({ prefix: DIR, limit: 1000 });
  const bases = blobs.filter((b) => b.pathname.startsWith(BASE_PREFIX)).sort(byPathnameDesc);
  const out = { base: null, deltas: [], deltaCount: 0, complete: true };

  const newest = bases[0];
  if (newest && newest.pathname !== basePathname) {
    out.base = await fetchBuf(newest.url);
    basePathname = newest.pathname;
    baseStamp = stampOf(newest.pathname, BASE_PREFIX);
  } else if (!newest && basePathname === null) {
    // First contact with an un-compacted store: fall back to the snapshots
    // written before the delta log existed (canvas-<version>.bin, canvas.bin)
    const legacy =
      blobs.filter((b) => b.pathname.startsWith(`${DIR}canvas-`)).sort(byPathnameDesc)[0] ??
      blobs.find((b) => b.pathname === `${DIR}canvas.bin`);
    if (legacy) out.base = await fetchBuf(legacy.url);
    basePathname = '(none)';
  }

  const deltas = blobs.filter(
    (b) => b.pathname.startsWith(DELTA_PREFIX) && stampOf(b.pathname, DELTA_PREFIX) >= baseStamp
  );
  out.deltaCount = deltas.length;
  const missing = deltas.filter((d) => !deltaCache.has(d.pathname));
  const fetched = await Promise.allSettled(
    missing.map(async (d) => [d.pathname, await fetchBuf(d.url)])
  );
  for (const r of fetched) {
    if (r.status === 'fulfilled') deltaCache.set(r.value[0], r.value[1]);
    // A rejection usually means a concurrent compaction deleted the delta
    // (its base carries the content); flag the pull so this instance doesn't
    // compact off an incomplete view, and retry on the next pull if it still
    // exists.
    else out.complete = false;
  }
  for (const pathname of deltaCache.keys()) {
    if (stampOf(pathname, DELTA_PREFIX) < baseStamp) deltaCache.delete(pathname);
  }

  out.deltas = [...deltaCache.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, data]) => data);
  return out;
}

export async function pushDelta(chunk) {
  const pathname = `${DELTA_PREFIX}${stamp(Date.now())}-${nonce()}.bin`;
  await put(pathname, chunk, {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/octet-stream'
  });
  deltaCache.set(pathname, Buffer.from(chunk)); // own write; no need to fetch it back
}

// Writes the caller's merged state as a new base and prunes everything it
// supersedes. Callers must have pulled (completely) in the same cycle.
export async function compact(deflatedFullState) {
  const boundary = stamp(Date.now() - COMPACT_MARGIN_MS);
  await put(`${BASE_PREFIX}${boundary}-${nonce()}.bin`, deflatedFullState, {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/octet-stream'
  });
  const { blobs } = await list({ prefix: DIR, limit: 1000 });
  const liveBases = blobs.filter((b) => b.pathname.startsWith(BASE_PREFIX)).sort(byPathnameDesc);
  const doomed = blobs.filter(
    (b) =>
      (b.pathname.startsWith(DELTA_PREFIX) && stampOf(b.pathname, DELTA_PREFIX) < boundary) ||
      liveBases.indexOf(b) >= KEEP_BASES ||
      b.pathname.startsWith(`${DIR}canvas`)
  );
  if (doomed.length > 0) await del(doomed.map((b) => b.url));
}
