import { del, list, put } from '@vercel/blob';
import { storeEnabled } from './store.js';

// Cross-instance presence over the blob store. io.engine.clientsCount is
// per-instance; to show a global total each instance heartbeats its own count
// and reads everyone's.
//
// The whole record lives in the PATHNAME (`<id>/<ts>-<clients>-<region>`,
// empty body): list() is an API call that's always fresh and returns every
// object's name, so aggregating needs no body fetches and dodges the blob
// CDN's by-pathname caching entirely. Scoped by deploy environment so dev and
// preview instances never inflate production's counts.
const ENV = process.env.VERCEL_ENV || 'dev';
const PREFIX = `presence-${ENV}/`;
const TTL_MS = 15000; // an instance is "live" if it heartbeat within this window

export function presenceEnabled() {
  return storeEnabled();
}

function parse(blob) {
  const rest = blob.pathname.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const id = rest.slice(0, slash);
  const name = rest.slice(slash + 1).replace(/\.b$/, '');
  const d1 = name.indexOf('-');
  const d2 = name.indexOf('-', d1 + 1);
  if (d1 < 0 || d2 < 0) return null;
  const ts = Number(name.slice(0, d1));
  const clients = Number(name.slice(d1 + 1, d2));
  if (!Number.isFinite(ts)) return null;
  return { id, ts, clients: Number.isFinite(clients) ? clients : 0, region: name.slice(d2 + 1), url: blob.url };
}

// Write this instance's heartbeat, then read the world. Keeps exactly the
// newest blob per live instance and deletes older versions and dead instances.
// Returns the aggregate; best-effort (callers tolerate a throw).
export async function syncPresence(id, region, clients, now = Date.now()) {
  await put(`${PREFIX}${id}/${now}-${clients}-${region}.b`, '1', {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'text/plain'
  });

  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  const parsed = blobs.map(parse).filter(Boolean);

  const newest = new Map(); // id -> entry
  for (const e of parsed) {
    const cur = newest.get(e.id);
    if (!cur || e.ts > cur.ts) newest.set(e.id, e);
  }

  const keep = new Set();
  let totalClients = 0;
  const instances = [];
  for (const [, e] of newest) {
    if (now - e.ts <= TTL_MS) {
      keep.add(e.url);
      totalClients += e.clients;
      instances.push({ id: e.id, region: e.region, clients: e.clients });
    }
  }

  const doomed = parsed.filter((e) => !keep.has(e.url)).map((e) => e.url);
  if (doomed.length) await del(doomed);

  return { totalClients, instanceCount: instances.length, instances };
}
